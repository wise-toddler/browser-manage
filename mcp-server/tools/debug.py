"""Console + network capture for a tab (CDP Runtime/Log/Network over a pinned debugger session)."""

import json
import time

from ipc import send_extension_command
from tools import tool, schema, text

INFOBAR = "While capture is on, the browser shows its 'debugging this browser' infobar."


def _err(result):
    """Error text for a failed extension call, or None."""
    if not isinstance(result, dict):
        return f"Error: {result}"
    if "error" in result:
        return f"Error: {result['error']}"
    return None


def _clock(ms):
    """HH:MM:SS.mmm for an epoch-ms timestamp."""
    if not ms:
        return "--:--:--"
    return time.strftime("%H:%M:%S", time.localtime(ms / 1000)) + f".{int(ms) % 1000:03d}"


def _size(n):
    """Compact byte count."""
    if n is None:
        return "-"
    return f"{n}B" if n < 1024 else f"{n / 1024:.1f}KB" if n < 1 << 20 else f"{n / (1 << 20):.1f}MB"


def _header(r, noun):
    """Counts line shared by both readers."""
    h = f"{r.get('matched', 0)} of {r.get('total', 0)} {noun}"
    if r.get("dropped"):
        h += f" ({r['dropped']} older dropped, buffer keeps the last 500)"
    if r.get("hiddenNoise"):
        h += f" ({r['hiddenNoise']} extension/browser-noise messages hidden; page_only=false shows them)"
    return h + (f"\nNote: {r['note']}" if r.get("note") else "")


@tool("browser_debug", f"Start, stop or check console + network capture on a tab. start pins a debugger session and records console logs, exceptions, browser log entries and network requests (last 500 each); reload=true reloads after enabling to capture from page load; duration_ms makes it one-shot (capture that long, then stop so the infobar goes away; reads still work). {INFOBAR} Tabs where another extension has a frame refuse the debugger.", schema({
    "tab_id": {"type": "integer"},
    "action": {"type": "string", "enum": ["start", "stop", "status"], "default": "status"},
    "reload": {"type": "boolean", "description": "start only: reload the tab after enabling capture", "default": False},
    "duration_ms": {"type": "integer", "description": "start only: stop automatically after this long (max 60000)"},
}, ["tab_id"]))
async def browser_debug(args):
    tab_id = args.get("tab_id")
    if not isinstance(tab_id, int):
        return [text("Error: tab_id (integer) is required")]
    duration_ms = min(int(args.get("duration_ms") or 0), 60000)
    result = send_extension_command("debugCapture", {"tabId": tab_id, "mode": args.get("action", "status"), "reload": args.get("reload", False),
                                                     "durationMs": duration_ms}, timeout=30 + duration_ms / 1000, profile=args.get("profile"))
    return [text(_err(result) or json.dumps(result))]


@tool("browser_read_console", f"Read a tab's console: console.* calls, uncaught exceptions and browser log entries (failed loads, violations). Starts capture if it isn't on (that first read only has messages logged so far). {INFOBAR}", schema({
    "tab_id": {"type": "integer"},
    "pattern": {"type": "string", "description": "Regex (case-insensitive) matched against message text and source URL; plain substring if not a valid regex"},
    "only_errors": {"type": "boolean", "default": False},
    "page_only": {"type": "boolean", "description": "Hide other extensions' messages, DevTools hook banners and browser intervention/tracking-prevention notices", "default": True},
    "limit": {"type": "integer", "description": "Most recent N matches", "default": 100},
    "clear": {"type": "boolean", "description": "Empty the console buffer after reading", "default": False},
}, ["tab_id"]))
async def browser_read_console(args):
    tab_id = args.get("tab_id")
    if not isinstance(tab_id, int):
        return [text("Error: tab_id (integer) is required")]
    payload = {"tabId": tab_id, "pattern": args.get("pattern"), "onlyErrors": args.get("only_errors", False),
               "limit": args.get("limit", 100), "clear": args.get("clear", False), "pageOnly": args.get("page_only", True)}
    r = send_extension_command("readConsole", payload, timeout=30, profile=args.get("profile"))
    if _err(r):
        return [text(_err(r))]
    lines = [_header(r, "console messages")]
    for m in r.get("messages", []):
        where = f"  ({m['url']}:{m['line']})" if m.get("url") and m.get("line") else f"  ({m['url']})" if m.get("url") else ""
        src = "" if m.get("source") == "console" else f"[{m.get('source')}] "
        lines.append(f"{_clock(m.get('ts'))} {m.get('level', ''):<7} {src}{m.get('text', '')}{where}")
    return [text("\n".join(lines))]


@tool("browser_read_network", f"Read a tab's network requests (method, status, type, size, duration, failure). Pass request_id to get that response body (text decoded, capped 20KB). Starts capture if it isn't on; requests made before that aren't recorded (use browser_debug start with reload=true). {INFOBAR}", schema({
    "tab_id": {"type": "integer"},
    "url_pattern": {"type": "string", "description": "Substring the request URL must contain"},
    "only_failed": {"type": "boolean", "description": "Only network errors and HTTP status >= 400", "default": False},
    "limit": {"type": "integer", "description": "Most recent N matches", "default": 100},
    "clear": {"type": "boolean", "description": "Empty the network buffer after reading", "default": False},
    "request_id": {"type": "string", "description": "Return this request's response body instead of the list"},
}, ["tab_id"]))
async def browser_read_network(args):
    tab_id = args.get("tab_id")
    if not isinstance(tab_id, int):
        return [text("Error: tab_id (integer) is required")]
    payload = {"tabId": tab_id, "urlPattern": args.get("url_pattern"), "onlyFailed": args.get("only_failed", False),
               "limit": args.get("limit", 100), "clear": args.get("clear", False), "requestId": args.get("request_id")}
    r = send_extension_command("readNetwork", payload, timeout=30, profile=args.get("profile"))
    if _err(r):
        return [text(_err(r))]
    if args.get("request_id"):
        head = f"{r.get('status')} {r.get('mime')} {r.get('url')} ({r.get('length')} chars{', truncated to 20000' if r.get('truncated') else ''}{', base64' if r.get('base64') else ''})"
        return [text(head + "\n\n" + r.get("body", ""))]
    lines = [_header(r, "requests")]
    for q in r.get("requests", []):
        status = q.get("error") or q.get("status") or "pending"
        extra = (" cached" if q.get("cached") else "") + (f" redirects={q['redirects']}" if q.get("redirects") else "")
        dur = f"{q['durationMs']}ms" if q.get("durationMs") is not None else "-"
        lines.append(f"{q.get('requestId')}  {q.get('method', '?'):<6} {status!s:<6} {(q.get('type') or '-'):<10} {_size(q.get('size')):>8} {dur:>7}  {q.get('url', '')}{extra}")
    return [text("\n".join(lines))]
