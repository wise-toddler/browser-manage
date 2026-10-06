"""Run JavaScript in a tab's page context, and inspect the script allowlist/log."""

from ipc import send_extension_command
from tools import tool, schema, text, as_json, ext_result


@tool("browser_run_script", "Run JavaScript in a tab's page context (like the DevTools console) and return the result. Allowed on all sites by default; the allowlist can be narrowed from the extension popup. 8s timeout; every run is logged.", schema({
    "tab_id": {"type": "integer", "description": "Chrome tab ID to run in"},
    "code": {"type": "string", "description": "JS expression/statements; the last expression value is returned (promises are awaited)"},
}, ["tab_id", "code"]))
async def run_script(args):
    tab_id, code = args.get("tab_id"), args.get("code")
    if not isinstance(tab_id, int) or not isinstance(code, str) or not code:
        return [text("Error: tab_id (integer) and code (non-empty string) are required")]
    # Allowlist is enforced inside the extension against the tab's real hostname
    return as_json(send_extension_command("runScript", {"tabId": tab_id, "code": code}, profile=args.get("profile")))


@tool("browser_script_info", "Read-only: the script allowlist and the last 20 script runs (url, code, ok/error).", schema())
async def script_info(args):
    return ext_result(send_extension_command("getScriptInfo", {}, profile=args.get("profile")))
