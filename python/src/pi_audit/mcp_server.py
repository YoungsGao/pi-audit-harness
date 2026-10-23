import argparse
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent
from pydantic import Field

from pi_audit.core import EvidenceService
from pi_audit.models import ReadRequest, StrictModel, ToolReply


class CheckRequest(StrictModel):
    evidence_id: str = Field(min_length=1, max_length=100)


def as_mcp(reply: ToolReply) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=reply.model_dump_json())],
        structuredContent=reply.model_dump(mode="json"),
        isError=reply.status == "error",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-dir", required=True, type=Path)
    args = parser.parse_args()
    service = EvidenceService(args.root, args.run_id, args.run_dir)
    server = FastMCP("pi-audit-m1")

    @server.tool(structured_output=False)
    def read_evidence(request: ReadRequest) -> CallToolResult:
        """读取允许项目中的 JavaScript / TypeScript 行区间，返回已登记证据。"""
        return as_mcp(service.read(request.model_dump()))

    @server.tool(structured_output=False)
    def check_evidence(request: CheckRequest) -> CallToolResult:
        """检查本次运行的证据是否存在，以及源码是否仍与取证时一致。"""
        return as_mcp(service.check(request.evidence_id))

    server.run(transport="stdio")


if __name__ == "__main__":
    main()
