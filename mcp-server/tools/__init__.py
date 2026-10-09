"""Tool registry: each module registers its tools with @tool; server.py lists and dispatches from REGISTRY."""

import json
from dataclasses import dataclass
from typing import Awaitable, Callable

from mcp.types import Tool, TextContent

# Optional profile param added to extension-based tools
PROFILE_PROP = {
    "profile": {
        "type": "string",
        "description": "Target browser profile (e.g. 'edge-kgofki...'). Omit for default.",
    }
}
# List-of-tab-IDs schema shared by tab tools
TAB_IDS = {"type": "array", "items": {"type": "integer"}}


@dataclass
class Entry:
    tool: Tool
    handler: Callable[[dict], Awaitable[list]]


# Insertion order = order tools are listed to clients
REGISTRY: dict[str, Entry] = {}


def tool(name: str, description: str, input_schema: dict):
    """Register an async handler(args) -> list[content] under `name`."""
    def register(fn):
        REGISTRY[name] = Entry(Tool(name=name, description=description, inputSchema=input_schema), fn)
        return fn
    return register


def schema(properties: dict = None, required: list = None, profile: bool = True) -> dict:
    """JSON schema for a tool's input; extension-backed tools also take `profile`."""
    s = {"type": "object", "properties": {**(properties or {}), **(PROFILE_PROP if profile else {})}}
    if required:
        s["required"] = required
    return s


async def dispatch(name: str, arguments: dict) -> list:
    """Run a registered tool (also used by tools that compose others)."""
    entry = REGISTRY.get(name)
    if not entry:
        return [text(f"Unknown tool: {name}")]
    return await entry.handler(arguments or {})


def text(s: str) -> TextContent:
    """Plain text content."""
    return TextContent(type="text", text=s)


def as_json(obj, indent=2) -> list:
    """Content list holding obj as JSON."""
    return [text(json.dumps(obj, indent=indent))]


def ext_error(result, expect: type = object) -> str | None:
    """'Error: ...' text when an extension call returned {error} or not an `expect` instance, else None."""
    if isinstance(result, dict) and "error" in result:
        return f"Error: {result['error']}"
    if not isinstance(result, expect):
        return f"Error: unexpected result: {result}"
    return None


def tab_id_error(args: dict) -> str | None:
    """'Error: ...' text when args has no integer tab_id, else None."""
    return None if isinstance(args.get("tab_id"), int) else "Error: tab_id (integer) is required"


def ext_result(result) -> list:
    """Return extension result as JSON, or its error text."""
    err = ext_error(result)
    return [text(err)] if err else as_json(result)


def unwrap(value, kind):
    """Extension learning endpoints answer {data: ...}; return the inner value, or an empty `kind` on error."""
    if isinstance(value, dict) and 'data' in value:
        value = value['data']
    if not isinstance(value, kind) or (isinstance(value, dict) and 'error' in value):
        return kind()
    return value
