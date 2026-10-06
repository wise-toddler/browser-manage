"""Tab screenshots (background tabs too) returned as images plus a saved file."""

import base64
import os
import time

from mcp.types import ImageContent

from ipc import send_extension_command
from tools import tool, schema, text


def screenshot(tab_id: int, profile: str, full_page: bool = False, fmt: str = "jpeg", path: str = None) -> list:
    """Capture a tab via the extension; return ImageContent + saved path (or an error TextContent)."""
    result = send_extension_command("screenshot", {"tabId": tab_id, "fullPage": full_page, "format": fmt}, timeout=30, profile=profile)
    if not isinstance(result, dict) or "error" in result or not result.get("data"):
        return [text(f"Screenshot error: {result.get('error', result) if isinstance(result, dict) else result}")]
    path = path or f"/tmp/tab-manager-shot-{tab_id}-{int(time.time())}.{'jpg' if fmt == 'jpeg' else 'png'}"
    with open(path, "wb") as f:
        f.write(base64.b64decode(result["data"]))
    return [
        ImageContent(type="image", data=result["data"], mimeType=f"image/{fmt}"),
        text(f"Saved {path} ({os.path.getsize(path) // 1024} KB, {'full page' if result.get('fullPage') else 'viewport'}{', ' + result['mode'] if result.get('mode') else ''}{', truncated to 8000px of ' + str(result['pageHeight']) if result.get('truncated') else ''})"),
    ]


@tool("browser_screenshot", "Screenshot a tab (works on background tabs, no need to activate). Returns the image plus a saved file path.", schema({
    "tab_id": {"type": "integer", "description": "Chrome tab ID"},
    "full_page": {"type": "boolean", "description": "Capture the whole scrollable page instead of the viewport", "default": False},
    "format": {"type": "string", "enum": ["jpeg", "png"], "default": "jpeg"},
    "path": {"type": "string", "description": "Where to save; default /tmp/tab-manager-shot-<tab_id>-<ts>.<ext>"},
}, ["tab_id"]))
async def browser_screenshot(args):
    tab_id = args.get("tab_id")
    if not isinstance(tab_id, int):
        return [text("Error: tab_id (integer) is required")]
    return screenshot(tab_id, args.get("profile"), args.get("full_page", False), args.get("format", "jpeg"), args.get("path"))
