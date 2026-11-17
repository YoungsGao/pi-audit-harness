import json
import os
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ServerConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()), pattern=r"^[A-Za-z0-9_-]{1,80}$")
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["codegraph", "static", "custom"]
    transport: Literal["builtin", "stdio", "http"] = "builtin"
    enabled: bool = True
    command: str = Field(default="", max_length=2000)
    args: list[str] = Field(default_factory=list, max_length=32)
    url: str = Field(default="", max_length=2000)
    tools: list[str] | None = Field(default=None, max_length=100)
    semgrepPath: str = Field(default="", max_length=2000)
    revision: int = Field(default=1, ge=1)

    @model_validator(mode="after")
    def connection(self):
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("服务名称不能为空")
        if self.kind != "custom" and self.transport != "builtin":
            raise ValueError("审计补证配置使用内置 Python 工具；外部服务请选择自定义")
        if self.kind == "custom" and self.transport == "builtin":
            raise ValueError("自定义服务请选择 stdio 或 HTTP")
        if self.transport == "stdio" and not self.command.strip():
            raise ValueError("stdio 需要启动程序和独立参数数组")
        if self.transport == "http":
            u = urlsplit(self.url)
            if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost", "::1") or u.username or u.password or u.fragment:
                raise ValueError("当前本地服务仅支持 localhost HTTP MCP 地址")
        if any(len(arg) > 2000 or "\x00" in arg for arg in self.args):
            raise ValueError("启动参数无效")
        if self.tools is not None and len(set(self.tools)) != len(self.tools):
            raise ValueError("工具选择不能重复")
        return self


def defaults():
    return [ServerConfig(id="codegraph", name="CodeGraph 补证", kind="codegraph"),
            ServerConfig(id="static", name="静态扫描", kind="static", semgrepPath=os.environ.get("PI_AUDIT_SEMGREP_PATH", ""))]


class Registry:
    def __init__(self, root: Path):
        self.file = root / "mcp" / "servers.json"
        self.file.parent.mkdir(parents=True, exist_ok=True)
        if not self.file.exists():
            self.rows = defaults()
            self.write()
        else:
            data = json.loads(self.file.read_text("utf-8"))
            if data.get("version") != 1:
                raise ValueError("MCP配置版本不受支持")
            self.rows = [ServerConfig.model_validate(row) for row in data["servers"]]

    def write(self, rows=None):
        rows = self.rows if rows is None else rows
        temp = self.file.with_suffix(".tmp")
        temp.write_text(json.dumps({"version": 1, "servers": [r.model_dump() for r in rows]}, ensure_ascii=False, indent=2), "utf-8")
        os.replace(temp, self.file)
        self.rows = rows

    def get(self, id: str):
        return next((r for r in self.rows if r.id == id), None)

    def save(self, value: dict):
        config = ServerConfig.model_validate(value)
        old = self.get(config.id)
        if old and config.revision != old.revision:
            raise ValueError("服务配置已更新，请刷新后保存")
        config.revision = old.revision + 1 if old else 1
        rows = [r.model_copy() for r in self.rows]
        if config.enabled and config.kind != "custom":
            for row in rows:
                if row.id != config.id and row.kind == config.kind and row.enabled:
                    row.enabled = False
                    row.revision += 1
        self.write([row for row in rows if row.id != config.id] + [config])
        return config

    def delete(self, id: str):
        if not self.get(id):
            raise ValueError("MCP服务不存在")
        self.write([row for row in self.rows if row.id != id])

    def import_config(self, document: dict):
        # Parse the entire document first; a bad item never leaves a partial import.
        if "mcpServers" in document:
            if not isinstance(document["mcpServers"], dict) or any(not isinstance(r, dict) for r in document["mcpServers"].values()):
                raise ValueError("mcpServers需要服务名到连接配置的对象")
            rows = []
            for name, raw in document["mcpServers"].items():
                if raw.get("env") or raw.get("headers"):
                    raise ValueError("此本地连接导入暂不支持 env/headers；请使用无额外凭据的本地服务")
                rows.append(ServerConfig(name=name, kind="custom", enabled=False,
                    transport="http" if "url" in raw else "stdio", command=raw.get("command", ""),
                    args=raw.get("args", []), url=raw.get("url", "")))
        else:
            rows = [ServerConfig.model_validate({**r, "id": str(uuid.uuid4()), "revision": 1, "enabled": False}) for r in document["servers"]]
        if len(self.rows) + len(rows) > 30:
            raise ValueError("最多保存30个本地MCP服务")
        self.write([*self.rows, *rows])
        return rows
