#!/usr/bin/env python3
"""MCP Server for browser tab management: lists and dispatches tools registered under tools/."""

import asyncio

from mcp.server import Server
from mcp.server.stdio import stdio_server

# Import order = order tools are listed to clients
import tools.tabs  # noqa: F401
import tools.profiles  # noqa: F401
import tools.learning  # noqa: F401
import tools.script  # noqa: F401
import tools.capture  # noqa: F401
import tools.actions  # noqa: F401
import tools.page  # noqa: F401
import tools.triage  # noqa: F401
# P2 debug
import tools.debug  # noqa: F401
import tools.batch  # noqa: F401
import tools.record  # noqa: F401
from tools import REGISTRY, dispatch
# Re-exported for bm.py and ad-hoc scripts that `import server`
from ipc import send_extension_command, get_active_profiles  # noqa: F401
from analysis import categorize_tabs, check_pr_status, predict_dispose_probability, extract_features_server_side  # noqa: F401

server = Server("browser-tabs")


@server.list_tools()
async def list_tools():
    return [entry.tool for entry in REGISTRY.values()]


@server.call_tool()
async def call_tool(name: str, arguments: dict):
    return await dispatch(name, arguments)


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())

if __name__ == "__main__":
    asyncio.run(main())
