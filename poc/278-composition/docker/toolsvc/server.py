"""Disposable MCP tool service for the #278 PoC (N1 / §4.2).

Exposes one tool with a real, externally observable side effect: it writes a
marker file. The N1 negative control asserts that when Preloop policy denies the
call, this file does NOT appear — i.e. the deny prevented the underlying effect,
not merely the agent's report of it.

This service sits on `cadp278-toolnet`, which the agent container is NOT a member
of. The only route to it is through the Preloop MCP safety layer.
"""

import datetime
import os
import pathlib

from mcp.server.fastmcp import FastMCP

MARKERS = pathlib.Path("/markers")
mcp = FastMCP("cadp278-toolsvc", host="0.0.0.0", port=8000)


@mcp.tool()
def write_marker(name: str) -> str:
    """Write a marker file. This is the observable underlying effect for N1."""
    MARKERS.mkdir(parents=True, exist_ok=True)
    safe = "".join(c for c in name if c.isalnum() or c in "-_")[:64] or "unnamed"
    target = MARKERS / f"{safe}.txt"
    target.write_text(
        f"written_at={datetime.datetime.now(datetime.timezone.utc).isoformat()}\n",
        encoding="utf-8",
    )
    return f"wrote {target}"


@mcp.tool()
def list_markers() -> str:
    """List marker files that exist. Read-only."""
    if not MARKERS.exists():
        return "(no markers directory)"
    names = sorted(p.name for p in MARKERS.glob("*.txt"))
    return ", ".join(names) if names else "(none)"


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
