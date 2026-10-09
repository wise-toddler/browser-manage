"""Tab screenshots (background tabs too) returned as images plus a saved file; viewport emulation."""

import base64
import json
import os
import time

from mcp.types import ImageContent

from ipc import send_extension_command
from tools import tool, schema, text
from tools.page import REF_PROP


# Called after every successful capture as fn(tab_id, profile, result, label, at); recording subscribes here
FRAME_LISTENERS = []
# Full-page tiles per call: 10 × 8000px covers 80k CSS px; anything taller is a feed, not a page
MAX_TILES = 10


def _capture(tab_id: int, profile: str, payload: dict) -> dict:
    """One screenshot call to the extension; returns its result dict (error included)."""
    result = send_extension_command("screenshot", {"tabId": tab_id, **payload}, timeout=30, profile=profile)
    if not isinstance(result, dict):
        return {"error": str(result)}
    if "error" not in result and not result.get("data"):
        return {"error": "no image data"}
    return result


def _save(result: dict, path: str) -> int:
    """Write the image; return its size in KB."""
    with open(path, "wb") as f:
        f.write(base64.b64decode(result["data"]))
    return os.path.getsize(path) // 1024


def _describe(result: dict) -> str:
    """Short capture description for the saved-file line."""
    parts = ["full page" if result.get("fullPage") else ("crop " + json.dumps(result["crop"]) if result.get("crop") else "viewport")]
    if result.get("viewport"):
        v = result["viewport"]
        parts.append(f"emulated {v['width']}x{v['height']}@{v['dpr']}{' mobile' if v.get('mobile') else ''}")
    if result.get("mode"):
        parts.append(result["mode"])
    return ", ".join(parts)


def screenshot(tab_id: int, profile: str, full_page: bool = False, fmt: str = "jpeg", path: str = None, label: str = "screenshot",
               at: dict = None, selector: str = None, ref=None, clip: dict = None, tile: bool = False) -> list:
    """Capture a tab via the extension; return ImageContent(s) + saved path(s), or an error TextContent."""
    ext = "jpg" if fmt == "jpeg" else "png"
    path = path or f"/tmp/tab-manager-shot-{tab_id}-{int(time.time())}.{ext}"
    payload = {"fullPage": full_page, "format": fmt}
    if not full_page:
        payload.update({k: v for k, v in (("selector", selector), ("ref", ref), ("clip", clip)) if v is not None})
    result = _capture(tab_id, profile, payload)
    if "error" in result:
        return [text(f"Screenshot error: {result['error']}")]
    for listener in FRAME_LISTENERS:
        listener(tab_id, profile, result, label, at)

    if not (full_page and tile and result.get("truncated")):
        kb = _save(result, path)
        note = ""
        if result.get("truncated"):
            note = (f", truncated to {result['tileHeight']}px of {result['pageHeight']}: pass tile=true for all of it "
                    f"or clip/selector for one part")
        return [ImageContent(type="image", data=result["data"], mimeType=f"image/{fmt}"),
                text(f"Saved {path} ({kb} KB, {_describe(result)}{note})")]

    # Tiled full page: one extension call per tile so each gets its own render + timeout
    stem, suffix = os.path.splitext(path)
    out, lines, n = [], [], 0
    page_height = result["pageHeight"]
    while True:
        n += 1
        tile_path = f"{stem}_{n}{suffix or '.' + ext}"
        kb = _save(result, tile_path)
        y0 = result["tileY"]
        out.append(ImageContent(type="image", data=result["data"], mimeType=f"image/{fmt}"))
        lines.append(f"tile {n}: y {y0}-{y0 + result['tileHeight']} → {tile_path} ({kb} KB)")
        next_y = y0 + result["tileHeight"]
        if next_y >= page_height:
            break
        if n >= MAX_TILES:
            lines.append(f"stopped at {MAX_TILES} tiles ({next_y} of {page_height}px); use clip/selector for the rest")
            break
        result = _capture(tab_id, profile, {**payload, "tileY": next_y})
        if "error" in result:
            lines.append(f"tile {n + 1} failed at y={next_y}: {result['error']}")
            break
    return out + [text(f"Full page {page_height}px in {n} tile(s){', ' + _describe(result) if 'error' not in result and result.get('viewport') else ''}:\n" + "\n".join(lines))]


@tool("browser_screenshot", "Screenshot a tab (works on background tabs, no need to activate). Returns the image plus a saved file path. "
      "Crop to an element (selector or ref) or a clip box; full_page captures up to 8000px, tile=true returns the whole page as "
      "several images (saved as <path>_1, _2…). Honors browser_set_viewport.", schema({
    "tab_id": {"type": "integer", "description": "Chrome tab ID"},
    "full_page": {"type": "boolean", "description": "Capture the whole scrollable page instead of the viewport", "default": False},
    "tile": {"type": "boolean", "description": "With full_page: pages taller than 8000px come back as multiple images", "default": False},
    "selector": {"type": "string", "description": "Crop to this element (scrolled into view inside scroll containers, scroll restored after)"},
    **REF_PROP,
    "clip": {"type": "object", "description": "Crop box in CSS px relative to the viewport (image px / dpr)",
             "properties": {"x": {"type": "number"}, "y": {"type": "number"}, "width": {"type": "number"}, "height": {"type": "number"}},
             "required": ["width", "height"]},
    "format": {"type": "string", "enum": ["jpeg", "png"], "default": "jpeg"},
    "path": {"type": "string", "description": "Where to save; default /tmp/tab-manager-shot-<tab_id>-<ts>.<ext>"},
}, ["tab_id"]))
async def browser_screenshot(args):
    tab_id = args.get("tab_id")
    if not isinstance(tab_id, int):
        return [text("Error: tab_id (integer) is required")]
    clip = args.get("clip")
    if clip is not None and not (isinstance(clip, dict) and clip.get("width") and clip.get("height")):
        return [text("Error: clip needs width and height (CSS px, viewport-relative)")]
    return screenshot(tab_id, args.get("profile"), args.get("full_page", False), args.get("format", "jpeg"), args.get("path"),
                      selector=args.get("selector"), ref=args.get("ref"), clip=clip, tile=args.get("tile", False))


@tool("browser_set_viewport", "Emulate a viewport/device on a tab (works on background tabs, no focus change): width × height CSS px, "
      "dpr, mobile (touch + mobile layout). Screenshots, actions and read_page then see that viewport. The override holds a "
      "debugger session, so the debugging infobar stays visible until reset=true. No width/height and no reset = report the current state.", schema({
    "tab_id": {"type": "integer"},
    "width": {"type": "integer", "description": "CSS px, e.g. 390 / 768 / 1440"},
    "height": {"type": "integer", "description": "CSS px, e.g. 844 / 1024 / 900"},
    "dpr": {"type": "number", "description": "devicePixelRatio, default 1", "default": 1},
    "mobile": {"type": "boolean", "default": False},
    "reset": {"type": "boolean", "description": "Clear the override and release the debugger session", "default": False},
}, ["tab_id"]))
async def browser_set_viewport(args):
    tab_id = args.get("tab_id")
    if not isinstance(tab_id, int):
        return [text("Error: tab_id (integer) is required")]
    if not args.get("reset") and (args.get("width") is None) != (args.get("height") is None):
        return [text("Error: give both width and height")]
    payload = {"tabId": tab_id, **{k: args[k] for k in ("width", "height", "dpr", "mobile", "reset") if k in args}}
    r = send_extension_command("setViewport", payload, profile=args.get("profile"))
    if isinstance(r, dict) and "error" in r:
        return [text(f"Error: {r['error']}")]
    return [text(json.dumps(r))]
