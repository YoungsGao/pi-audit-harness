"""Two local MCP servers plus a small configuration API; never execute target Java."""
import argparse
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import threading
import uuid

import httpx
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client
from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import ValidationError
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route, Mount
import uvicorn

from .registry import Registry
from .tools import EvidenceTools, compact, scan


class ExternalConnection:
    """Keep MCP SDK context managers in the same task for their entire lifetime."""
    def __init__(self, config):
        self.config = config
        self.queue = asyncio.Queue()
        self.ready = asyncio.get_running_loop().create_future()
        self.task = asyncio.create_task(self.run())

    async def run(self):
        try:
            async with AsyncExitStack() as stack:
                c = self.config
                if c.transport == "stdio":
                    env = {k: v for k, v in os.environ.items() if k.upper() in {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"}}
                    transport = await stack.enter_async_context(stdio_client(StdioServerParameters(command=c.command, args=c.args, env=env)))
                else:
                    def factory(headers=None, timeout=None, auth=None):
                        return httpx.AsyncClient(headers=headers, timeout=timeout or 20, auth=auth, trust_env=False, follow_redirects=False)
                    transport = await stack.enter_async_context(streamablehttp_client(c.url, timeout=20, httpx_client_factory=factory))
                session = await stack.enter_async_context(ClientSession(*transport[:2]))
                await session.initialize()
                tools = (await session.list_tools()).tools
                self.ready.set_result([t.model_dump(by_alias=True, exclude_none=True) for t in tools])
                while True:
                    message = await self.queue.get()
                    if message is None:
                        break
                    name, args, result = message
                    try:
                        reply = await asyncio.wait_for(session.list_tools() if name == "__list_tools__" else session.call_tool(name, args), 25)
                        if not result.done():
                            result.set_result(reply.model_dump(by_alias=True, exclude_none=True))
                    except Exception:
                        if not result.done():
                            result.set_exception(ValueError("MCP_TOOL_FAILED"))
        except Exception:
            if not self.ready.done():
                self.ready.set_exception(ValueError("MCP_CONNECTION_FAILED：请检查本地地址、程序与参数"))

    async def close(self):
        await self.queue.put(None)
        try:
            await asyncio.wait_for(asyncio.shield(self.task), 3)
        except asyncio.TimeoutError:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)


class Hub:
    def __init__(self, root, token, definitions, rules):
        self.registry = Registry(root)
        self.token, self.definitions, self.rules = token, definitions, rules
        self.contexts = {}
        self.connections = {}
        self.managers = {}
        self.port = 0
        for kind in ("codegraph", "static"):
            server = Server("audit-" + kind, version="2.0.0")
            self.install(server, kind)
            self.managers[kind] = StreamableHTTPSessionManager(server, json_response=True, stateless=True,
                security_settings=TransportSecuritySettings(allowed_hosts=["127.0.0.1:*", "localhost:*"], allowed_origins=[]))

    def install(self, server, kind):
        def config():
            request = server.request_context.request
            id = request.headers.get("x-audit-server", kind)
            row = self.registry.get(id)
            if not row or row.kind != kind:
                raise ValueError("MCP_SERVER_NOT_FOUND")
            return row

        @server.list_tools()
        async def tools():
            c = config()
            return [types.Tool(**t) for t in self.definitions if (t["name"] == "audit_static_scan") == (kind == "static") and (c.tools is None or t["name"] in c.tools)]

        @server.call_tool()
        async def call(name, arguments):
            c = config()
            context = self.contexts.get(server.request_context.request.headers.get("x-audit-context"))
            if not context:
                raise ValueError("MCP_CONTEXT_REQUIRED：请由审计客户端提供固定快照上下文")
            selected = context.bundle["servers"].get(kind)
            if not selected or selected["id"] != c.id or selected["revision"] != c.revision:
                raise ValueError("MCP_CONFIG_CHANGED：配置已变化，请开始新调查")
            allowed = [t.name for t in await tools()]
            if name not in allowed or not c.enabled:
                raise ValueError("MCP_TOOL_DISABLED")
            return await context.call(name, arguments, c)

    async def body(self, request, limit=524288):
        parts, size = [], 0
        async for part in request.stream():
            size += len(part)
            if size > limit:
                raise ValueError("MCP_INPUT_LIMIT")
            parts.append(part)
        return json.loads(b"".join(parts))

    def catalog(self):
        return dict(servers=[{**c.model_dump(), "state": "ready" if c.transport == "builtin" and c.enabled else "connected" if c.id in self.connections else "disabled" if not c.enabled else "configured"} for c in self.registry.rows],
            total=len(self.registry.rows), pid=os.getpid(), port=self.port)

    async def connect(self, c):
        if c.id in self.connections and self.connections[c.id].task.done():
            self.connections.pop(c.id)
        if c.id not in self.connections:
            connection = ExternalConnection(c)
            self.connections[c.id] = connection
            try:
                await asyncio.wait_for(asyncio.shield(connection.ready), 20)
            except BaseException:
                if self.connections.get(c.id) is connection:
                    self.connections.pop(c.id)
                await connection.close()
                raise
        else:
            await asyncio.wait_for(asyncio.shield(self.connections[c.id].ready), 20)
        return self.connections[c.id]

    async def action(self, request):
        action = request.path_params["action"]
        try:
            value = await self.body(request)
            if not isinstance(value, dict):
                raise ValueError("MCP操作需要JSON对象")
            active = {row["id"] for context in self.contexts.values() for row in context.bundle["servers"].values()}
            if action in ("save", "delete", "stop", "configureTools") and value.get("id") in active:
                raise ValueError("此MCP服务正在调查中使用，请先停止当前调查再修改")
            if action in ("save", "start"):
                existing = self.registry.get(value.get("id"))
                kind = value.get("kind", existing.kind if existing else None)
                enabling = action == "start" or value.get("enabled", True)
                if enabling and kind in ("codegraph", "static") and any(row.kind == kind and row.id != value.get("id") and row.id in active for row in self.registry.rows):
                    raise ValueError("当前调查正在使用同类服务，停止调查后再切换")
            if action == "list":
                return JSONResponse(self.catalog())
            if action == "save":
                if len(self.registry.rows) >= 30 and not self.registry.get(value.get("id")):
                    raise ValueError("最多保存30个服务")
                old = self.connections.pop(value.get("id"), None)
                if old:
                    await old.close()
                self.registry.save(value)
            elif action == "import":
                self.registry.import_config(value)
            elif action in ("delete", "start", "stop", "test", "tools", "configureTools", "call"):
                c = self.registry.get(value.get("id"))
                if not c:
                    raise ValueError("MCP服务不存在")
                if action in ("delete", "stop"):
                    old = self.connections.pop(c.id, None)
                    if old:
                        await old.close()
                    if action == "delete":
                        self.registry.delete(c.id)
                    else:
                        self.registry.save({**c.model_dump(), "enabled": False})
                elif action == "configureTools":
                    if c.kind == "codegraph" and "audit_read_related" in value["tools"] and "audit_find_related" not in value["tools"]:
                        raise ValueError("关联读取需要同时启用关联查询工具")
                    self.registry.save({**c.model_dump(), "tools": value["tools"]})
                elif action == "start":
                    if c.transport != "builtin":
                        await self.connect(c)
                    if not c.enabled:
                        self.registry.save({**c.model_dump(), "enabled": True})
                elif action in ("test", "tools"):
                    if c.transport == "builtin":
                        headers = {"Authorization": "Bearer " + self.token, "X-Audit-Server": c.id}
                        def factory(headers=None, timeout=None, auth=None):
                            return httpx.AsyncClient(headers=headers, timeout=timeout or 20, trust_env=False)
                        async with streamablehttp_client(f"http://127.0.0.1:{self.port}/{c.kind}/mcp", headers=headers, httpx_client_factory=factory) as transport:
                            async with ClientSession(*transport[:2]) as session:
                                initialized = await session.initialize()
                                listed = await session.list_tools()
                        tools = [t.model_dump(by_alias=True, exclude_none=True) for t in listed.tools]
                        protocol = initialized.protocolVersion
                    else:
                        temporary = c.id not in self.connections and not c.enabled
                        connection = await self.connect(c)
                        result = asyncio.get_running_loop().create_future()
                        await connection.queue.put(("__list_tools__", {}, result))
                        tools = (await asyncio.wait_for(result, 25))["tools"]
                        if temporary:
                            self.connections.pop(c.id, None)
                            await connection.close()
                        protocol = "MCP"
                    advertised = [t["name"] for t in tools]
                    if c.transport == "builtin":
                        tools = [t for t in self.definitions if (t["name"] == "audit_static_scan") == (c.kind == "static")]
                    return JSONResponse(dict(id=c.id, tools=tools, advertisedTools=advertised, protocol=protocol, connected=True, pid=os.getpid(),
                        scannerConfigured=bool(c.semgrepPath) if c.kind == "static" else None))
                else:
                    if c.kind != "custom" or not c.enabled:
                        raise ValueError("手动调用用于已启用的自定义工具；审计工具由路径上下文调用")
                    connection = await self.connect(c)
                    names = {t["name"] for t in await connection.ready}
                    name = value["name"]
                    if name not in names or (c.tools is not None and name not in c.tools):
                        raise ValueError("MCP_TOOL_DISABLED")
                    result = asyncio.get_running_loop().create_future()
                    await connection.queue.put((name, value.get("arguments", {}), result))
                    reply = await asyncio.wait_for(result, 30)
                    if len(compact(reply)) > 131072:
                        raise ValueError("MCP_OUTPUT_LIMIT")
                    return JSONResponse(dict(id=c.id, result=reply))
            else:
                return JSONResponse({"error": {"code": "MCP_ACTION_INVALID", "message": "不支持的MCP操作"}}, status_code=404)
            return JSONResponse(self.catalog())
        except (ValueError, KeyError, TypeError, asyncio.TimeoutError) as error:
            message = error.errors()[0]["msg"] if isinstance(error, ValidationError) else str(error)[:240]
            return JSONResponse({"error": {"code": "MCP_CONFIG_INVALID", "message": message or "MCP操作超时"}}, status_code=400)

    async def context(self, request):
        id = request.path_params["id"]
        if request.method == "DELETE":
            self.contexts.pop(id, None)
        else:
            value = await self.body(request, 32 * 1024 * 1024)
            if not 1 <= len(value.get("steps", [])) <= 16 or len(value.get("files", [])) > 2000:
                return JSONResponse({"error": {"code": "MCP_CONTEXT_INVALID", "message": "路径上下文无效"}}, status_code=400)
            self.contexts[id] = EvidenceTools(value, self.rules)
        return JSONResponse({"id": id})

    def app(self):
        @asynccontextmanager
        async def lifespan(app):
            async with AsyncExitStack() as stack:
                for manager in self.managers.values():
                    await stack.enter_async_context(manager.run())
                try:
                    yield
                finally:
                    await asyncio.gather(*(c.close() for c in self.connections.values()), return_exceptions=True)
                    self.contexts.clear()

        routes = [Route("/api/{action}", self.action, methods=["POST"]),
            Route("/contexts/{id}", self.context, methods=["POST", "DELETE"])]
        for kind, manager in self.managers.items():
            routes.append(Mount("/" + kind, app=manager.handle_request))
        app = Starlette(routes=routes, lifespan=lifespan)

        async def authenticated(scope, receive, send):
            if scope["type"] == "http":
                headers = dict(scope["headers"])
                expected = ("Bearer " + self.token).encode()
                if not secrets.compare_digest(headers.get(b"authorization", b""), expected):
                    await JSONResponse({"error": {"code": "UNAUTHORIZED", "message": "本地MCP认证失败"}}, status_code=401)(scope, receive, send)
                    return
            await app(scope, receive, send)
        return authenticated


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", required=True, type=Path)
    parser.add_argument("--standalone", action="store_true", help="使用包内工具契约独立启动；认证令牌保存到数据目录")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    args.data_root = args.data_root.resolve()
    if not 0 <= args.port <= 65535:
        parser.error("port must be 0..65535")
    if args.standalone:
        bootstrap = json.loads(Path(__file__).with_name("contract.json").read_text("utf-8"))
        bootstrap["token"] = secrets.token_hex(32)
        token_file = args.data_root / "mcp" / "local-token"
        token_file.parent.mkdir(parents=True, exist_ok=True)
        token_file.write_text(bootstrap["token"], "utf-8")
        token_file.chmod(0o600)
    else:
        bootstrap = json.loads(sys.stdin.readline())
    hub = Hub(args.data_root, bootstrap["token"], bootstrap["definitions"], bootstrap["rules"])
    parent_closed = threading.Event()

    def parent_watch():
        for line in sys.stdin:
            if line.strip() == "shutdown":
                break
        parent_closed.set()
    if not args.standalone:
        threading.Thread(target=parent_watch, daemon=True).start()

    async def serve():
        sock = socket.socket()
        sock.bind(("127.0.0.1", args.port))
        hub.port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(hub.app(), host="127.0.0.1", port=hub.port, log_level="error", access_log=False, timeout_graceful_shutdown=2))
        task = asyncio.create_task(server.serve(sockets=[sock]))
        while not server.started:
            if task.done():
                await task
                return
            await asyncio.sleep(.01)
        notice = {"type": "ready", "port": hub.port, "pid": os.getpid(),
            **({"tokenFile": str(token_file)} if args.standalone else {})}
        if args.standalone:
            (args.data_root / "mcp" / "endpoint.json").write_text(json.dumps(notice), "utf-8")
        print(json.dumps(notice), flush=True)
        async def watch():
            while not parent_closed.is_set():
                await asyncio.sleep(.1)
            server.should_exit = True
        watcher = asyncio.create_task(watch())
        try:
            await task
        finally:
            watcher.cancel()
    asyncio.run(serve())


if __name__ == "__main__":
    main()
