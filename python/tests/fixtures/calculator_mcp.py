"""Small local extension for the MCP import experiments. No file/model access."""
from mcp.server.fastmcp import FastMCP

server = FastMCP("audit-learning-calculator")


@server.tool()
def add_numbers(a: int, b: int) -> dict:
    """Add two integers to verify a local MCP connection."""
    return {"sum": a + b}


if __name__ == "__main__":
    server.run(transport="stdio")
