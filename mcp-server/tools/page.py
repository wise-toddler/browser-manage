"""Read pages (role/name tree with refs, find, text), wait for page conditions, upload files to file inputs."""

import base64
import json
import mimetypes
import os

from ipc import send_extension_command
from tools import tool, schema, text

# Native messaging caps host→extension messages at 1MB and base64 adds a third, so the
# in-page upload fallback (debugger blocked) only gets file bytes up to this much in total
UPLOAD_FALLBACK_MAX = 700 * 1024
REF_PROP = {"ref": {"type": ["string", "integer"], "description": "Element ref from browser_read_page / browser_find (e.g. 12 or 'ref_12')"}}


def _error(result) -> str:
    """Error message from an extension result, or None when it succeeded."""
    if not isinstance(result, dict):
        return f"unexpected result: {result}"
    return result.get("error")


def _need_tab(args):
    """tab_id error message, or None."""
    return None if isinstance(args.get("tab_id"), int) else "Error: tab_id (integer) is required"


@tool("browser_read_page", "Accessibility-style tree of a tab: one line per element, `role \"name\" [ref=N]` plus value/checked/href. Use refs with browser_action(ref=...), browser_upload and browser_wait_for. filter=interactive (default) lists only things you can act on; all adds headings, landmarks and text. Works on background tabs; no focus change.", schema({
    "tab_id": {"type": "integer"},
    "filter": {"type": "string", "enum": ["interactive", "all"], "default": "interactive"},
    "max_chars": {"type": "integer", "default": 30000, "description": "Truncate the tree at a line boundary past this size"},
    "ref": {**REF_PROP["ref"], "description": "Only read this element's subtree"},
}, ["tab_id"]))
async def browser_read_page(args):
    if (err := _need_tab(args)):
        return [text(err)]
    r = send_extension_command("readPage", {"tabId": args["tab_id"], "filter": args.get("filter", "interactive"),
                                            "maxChars": args.get("max_chars", 30000), "ref": args.get("ref")}, profile=args.get("profile"))
    if (err := _error(r)):
        return [text(f"Error: {err}")]
    s = r.get("scroll", {})
    head = (f"url: {r.get('url')}\ntitle: {r.get('title')}\n"
            f"scroll: y={s.get('y')} of {s.get('height')} (viewport {s.get('viewport')}) · {r.get('nodes')} nodes")
    body = r.get("tree") or "(no matching elements)"
    tail = f"\n[truncated: showing {args.get('max_chars', 30000)} of {r.get('chars')} chars; narrow with ref= or filter=interactive]" if r.get("truncated") else ""
    return [text(f"{head}\n{body}{tail}")]


@tool("browser_find", "Find elements by words (\"login button\", \"search box\", \"email\"): matches role, name, value and placeholder, returns up to 20 lines with refs. No LLM involved; works on background tabs.", schema({
    "tab_id": {"type": "integer"},
    "query": {"type": "string"},
}, ["tab_id", "query"]))
async def browser_find(args):
    if (err := _need_tab(args)):
        return [text(err)]
    if not args.get("query"):
        return [text("Error: query is required")]
    r = send_extension_command("findInPage", {"tabId": args["tab_id"], "query": args["query"]}, profile=args.get("profile"))
    if (err := _error(r)):
        return [text(f"Error: {err}")]
    lines = r.get("lines") or []
    if not lines:
        return [text(f"No elements match {args['query']!r} on {r.get('url')}")]
    more = f" (showing top 20 of {r.get('matches')})" if r.get("matches", 0) > len(lines) else ""
    return [text(f"{len(lines)} matches{more} on {r.get('url')}\n" + "\n".join(lines))]


@tool("browser_get_page_text", "Readable text of a tab: the article/main content when there is one, else the whole body. Works on background tabs.", schema({
    "tab_id": {"type": "integer"},
    "max_chars": {"type": "integer", "default": 50000},
}, ["tab_id"]))
async def browser_get_page_text(args):
    if (err := _need_tab(args)):
        return [text(err)]
    r = send_extension_command("getPageText", {"tabId": args["tab_id"], "maxChars": args.get("max_chars", 50000)}, profile=args.get("profile"))
    if (err := _error(r)):
        return [text(f"Error: {err}")]
    tail = f"\n[truncated at {args.get('max_chars', 50000)} of {r.get('chars')} chars]" if r.get("truncated") else ""
    return [text(f"url: {r.get('url')}\ntitle: {r.get('title')}\nsource: <{r.get('source')}>\n\n{r.get('text')}{tail}")]


@tool("browser_wait_for", "Wait until a tab satisfies a condition instead of sleeping: an element (selector or ref) or text appears — or disappears with gone=true — and/or the URL contains a string. All given conditions must hold. Polls every 200ms; works on background tabs.", schema({
    "tab_id": {"type": "integer"},
    "selector": {"type": "string"},
    **REF_PROP,
    "text": {"type": "string", "description": "Text that must appear in the page's visible text"},
    "url_contains": {"type": "string"},
    "gone": {"type": "boolean", "default": False, "description": "Wait for the selector/ref/text to disappear instead"},
    "timeout_ms": {"type": "integer", "default": 10000, "description": "Max 60000"},
}, ["tab_id"]))
async def browser_wait_for(args):
    if (err := _need_tab(args)):
        return [text(err)]
    if not any(args.get(k) is not None for k in ("selector", "ref", "text", "url_contains")):
        return [text("Error: give at least one of selector, ref, text, url_contains")]
    timeout_ms = min(int(args.get("timeout_ms", 10000)), 60000)
    payload = {"tabId": args["tab_id"], "selector": args.get("selector"), "ref": args.get("ref"), "text": args.get("text"),
               "urlContains": args.get("url_contains"), "gone": bool(args.get("gone")), "timeoutMs": timeout_ms}
    r = send_extension_command("waitFor", payload, timeout=timeout_ms / 1000 + 5, profile=args.get("profile"))
    if (err := _error(r)):
        return [text(f"Error: {err}")]
    return [text(json.dumps(r))]


def _upload_files(paths: list):
    """Validated absolute paths plus base64 payloads for the in-page fallback (None when over the size cap)."""
    resolved = []
    for p in paths:
        full = os.path.expanduser(p) if isinstance(p, str) else ""
        if not os.path.isabs(full):
            raise ValueError(f"path must be absolute (~ allowed): {p}")
        if not os.path.isfile(full):
            raise ValueError(f"not a file: {p}")
        resolved.append(full)
    if sum(os.path.getsize(p) for p in resolved) > UPLOAD_FALLBACK_MAX:
        return resolved, None
    files = []
    for p in resolved:
        with open(p, "rb") as f:
            files.append({"name": os.path.basename(p), "type": mimetypes.guess_type(p)[0] or "application/octet-stream",
                          "b64": base64.b64encode(f.read()).decode("ascii")})
    return resolved, files


@tool("browser_upload", "Put local files into a page's <input type=file> (like the user picking them; fires input/change). Target it by ref from browser_read_page/browser_find, or a CSS selector. Don't click file inputs: that opens a native picker you can't see.", schema({
    "tab_id": {"type": "integer"},
    "paths": {"type": "array", "items": {"type": "string"}, "description": "Local file paths (~ allowed)"},
    **REF_PROP,
    "selector": {"type": "string"},
}, ["tab_id", "paths"]))
async def browser_upload(args):
    if (err := _need_tab(args)):
        return [text(err)]
    paths = args.get("paths")
    if not isinstance(paths, list) or not paths:
        return [text("Error: paths must be a non-empty list")]
    if args.get("ref") is None and not args.get("selector"):
        return [text("Error: give ref or selector of the file input")]
    try:
        resolved, files = _upload_files(paths)
    except ValueError as e:
        return [text(f"Error: {e}")]
    payload = {"tabId": args["tab_id"], "paths": resolved, "ref": args.get("ref"), "selector": args.get("selector")}
    if files:
        payload["files"] = files
    r = send_extension_command("uploadFiles", payload, timeout=30, profile=args.get("profile"))
    if (err := _error(r)):
        return [text(f"Error: {err}")]
    return [text(json.dumps(r))]
