#!/usr/bin/env python3
"""MCP Server for browser tab management: lists and dispatches tools registered under tools/."""

import asyncio

import jsonschema
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, ListToolsResult

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
from tools import REGISTRY, dispatch, text
# Re-exported for bm.py and ad-hoc scripts that `import server`
from ipc import send_extension_command, get_active_profiles  # noqa: F401
from analysis import categorize_tabs, check_pr_status, predict_dispose_probability, extract_features_server_side  # noqa: F401



async def list_tools():
    """Every registered tool, in registration order."""
    return [entry.tool for entry in REGISTRY.values()]


async def call_tool(name: str, arguments: dict):
    """Run a tool by name; content list (bm.py, tests and ad-hoc scripts call this directly)."""
    return await dispatch(name, arguments)


async def _on_list_tools(ctx, params):
    """MCP tools/list handler."""
    return ListToolsResult(tools=await list_tools())


async def _on_call_tool(ctx, params):
    """MCP tools/call handler: schema check and exceptions become error results, as mcp 1.x did for us."""
    arguments = params.arguments or {}
    try:
        if params.name in REGISTRY:
            jsonschema.validate(instance=arguments, schema=REGISTRY[params.name].tool.input_schema)
        return CallToolResult(content=await call_tool(params.name, arguments))
    except jsonschema.ValidationError as e:
        return CallToolResult(content=[text(f"Input validation error: {e.message}")], is_error=True)
    except Exception as e:
        return CallToolResult(content=[text(str(e))], is_error=True)


server = Server("browser-tabs", on_list_tools=_on_list_tools, on_call_tool=_on_call_tool)


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())

if __name__ == "__main__":
    asyncio.run(main())
