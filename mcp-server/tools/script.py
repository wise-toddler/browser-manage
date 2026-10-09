"""Run JavaScript in a tab's page context, and inspect the script allowlist/log."""

from ipc import send_extension_command
from tools import tool, schema, text, as_json, ext_result


@tool("browser_run_script", "Run JavaScript in a tab's page context (like the DevTools console) and return the result. Plain code returns its last expression; top-level `await` works; code with a top-level `return` runs as an async function body and returns that value. A sleeping (frozen) background tab is woken first, or you get a clear 'tab is frozen' error. Allowed on all sites by default; the allowlist can be narrowed from the extension popup. Every run is logged.", schema({
    "tab_id": {"type": "integer", "description": "Chrome tab ID to run in"},
    "code": {"type": "string", "description": "JS: last expression is the result; top-level await and return both work"},
    "timeout_ms": {"type": "integer", "description": "Max run time, 1000-60000", "default": 8000},
}, ["tab_id", "code"]))
async def run_script(args):
    tab_id, code = args.get("tab_id"), args.get("code")
    if not isinstance(tab_id, int) or not isinstance(code, str) or not code:
        return [text("Error: tab_id (integer) and code (non-empty string) are required")]
    # Allowlist is enforced inside the extension against the tab's real hostname
    timeout_ms = min(max(int(args.get("timeout_ms") or 8000), 1000), 60000)
    # IPC wait outlives the script timeout so the extension's own timeout/frozen error comes back, not ours
    return as_json(send_extension_command("runScript", {"tabId": tab_id, "code": code, "timeoutMs": timeout_ms},
                                          timeout=timeout_ms / 1000 + 10, profile=args.get("profile")))


@tool("browser_script_info", "Read-only: the script allowlist and the last 20 script runs (url, code, ok/error).", schema())
async def script_info(args):
    return ext_result(send_extension_command("getScriptInfo", {}, profile=args.get("profile")))
