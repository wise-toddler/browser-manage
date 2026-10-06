"""Act in a tab with real mouse/keyboard events (click, type, key, scroll, navigate, history, activate)."""

import json

from ipc import send_extension_command
from tools import tool, schema, text
from tools.capture import screenshot


@tool("browser_action", "Act in a tab with real mouse/keyboard events: click (x,y or selector), type text, press key, scroll, navigate, back/forward, activate. activate steals the user's window focus and needs allow_focus=true. Returns a screenshot after the action unless screenshot=false.", schema({
    "tab_id": {"type": "integer"},
    "action": {"type": "string", "enum": ["click", "type", "key", "scroll", "navigate", "back", "forward", "activate"]},
    "x": {"type": "number"}, "y": {"type": "number"},
    "selector": {"type": "string", "description": "CSS selector; scrolled into view, its center is used as x,y"},
    "text": {"type": "string", "description": "for type"},
    "key": {"type": "string", "description": "for key: Enter, Tab, Escape, Backspace, ArrowDown, ... or a single character"},
    "url": {"type": "string", "description": "for navigate"},
    "deltaY": {"type": "number", "description": "for scroll; default 600 (positive = down)"},
    "deltaX": {"type": "number"},
    "double": {"type": "boolean"}, "button": {"type": "string", "enum": ["left", "right", "middle"]},
    "wait": {"type": "integer", "description": "ms to wait after the action before screenshot, default 400"},
    "screenshot": {"type": "boolean", "default": True},
    "allow_focus": {"type": "boolean", "description": "Permit stealing the user's window focus (activate); refused by the extension otherwise", "default": False},
}, ["tab_id", "action"]))
async def browser_action(args):
    tab_id, profile = args.get("tab_id"), args.get("profile")
    if not isinstance(tab_id, int):
        return [text("Error: tab_id (integer) is required")]
    payload = {k: v for k, v in args.items() if k not in ("tab_id", "profile", "screenshot", "allow_focus")}
    payload["allowFocus"] = args.get("allow_focus", False)
    result = send_extension_command("action", {"tabId": tab_id, **payload}, timeout=30, profile=profile)
    if not isinstance(result, dict) or "error" in result:
        return [text(f"Error: {result.get('error', result) if isinstance(result, dict) else result}")]
    out = [text(json.dumps(result))]
    if args.get("screenshot", True) and args["action"] != "activate":
        out = screenshot(tab_id, profile) + out
    return out
