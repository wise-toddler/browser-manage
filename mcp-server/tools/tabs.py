"""Tab listing, closing, grouping, opening, memory/activity and suspension tools."""

from urllib.parse import urlparse

from ipc import send_extension_command
from tools import tool, schema, dispatch, text, as_json, ext_result

TAB_IDS = {"type": "array", "items": {"type": "integer"}}


@tool("browser_create_group", "Create a tab group with specified tabs via extension.", schema({
    "name": {"type": "string", "description": "Name for the tab group"},
    "color": {"type": "string", "description": "Color: grey, blue, red, yellow, green, pink, purple, cyan, orange", "default": "blue"},
    "tab_ids": {**TAB_IDS, "description": "Chrome tab IDs to group"},
}, ["name", "tab_ids"]))
async def create_group(args):
    profile, group_name, tab_ids = args.get("profile"), args.get("name"), args.get("tab_ids", [])
    if not group_name or not tab_ids:
        return [text("Error: name and tab_ids are required")]
    # Check for existing group with same name first
    existing = send_extension_command("getTabs", {}, profile=profile)
    if isinstance(existing, list):
        for t in existing:
            gi = t.get('groupInfo')
            if gi and gi.get('title') == group_name:
                result = send_extension_command("addToGroup", {"groupId": t['groupId'], "tabIds": tab_ids}, profile=profile)
                if isinstance(result, dict) and "error" in result:
                    return [text(f"Error: {result['error']}")]
                return [text(f"Added {len(tab_ids)} tabs to existing group '{group_name}'")]
    result = send_extension_command("createGroup", {"name": group_name, "color": args.get("color", "blue"), "tabIds": tab_ids}, profile=profile)
    if "error" in result:
        return [text(f"Error: {result['error']}")]
    return [text(f"Created group '{group_name}' with {len(tab_ids)} tabs")]


@tool("browser_get_tabs_ext", "Get tabs via extension with Chrome tab IDs (required for grouping).", schema())
async def get_tabs_ext(args):
    return ext_result(send_extension_command("getTabs", {}, profile=args.get("profile")))


@tool("browser_close_duplicates", "Find and close all duplicate tabs (same URL). Keeps one per URL.", schema())
async def close_duplicates(args):
    profile = args.get("profile")
    tabs = send_extension_command("getTabs", {}, profile=profile)
    if isinstance(tabs, dict) and "error" in tabs:
        return [text(f"Error: {tabs['error']}. Is the extension running?")]
    url_to_tabs = {}
    for tab in tabs:
        url_to_tabs.setdefault(tab.get('url', ''), []).append(tab)
    to_close = []
    new_tab_urls = ['edge://newtab/', 'chrome://newtab/', 'about:newtab', 'about:blank']
    for url, tab_list in url_to_tabs.items():
        if any(url.startswith(nt) for nt in new_tab_urls):
            to_close.extend([t['id'] for t in tab_list])
        elif len(tab_list) > 1:
            to_close.extend([t['id'] for t in tab_list[1:]])
    if not to_close:
        return [text("No duplicate tabs found")]
    result = send_extension_command("closeTabs", {"tabIds": to_close}, profile=profile)
    if isinstance(result, dict) and "error" in result:
        return [text(f"Error closing tabs: {result['error']}")]
    return [text(f"Closed {len(to_close)} duplicate tabs")]


@tool("browser_get_memory", "Get memory usage per tab with memory hog detection. Returns tabs sorted by memory.", schema())
async def get_memory(args):
    result = send_extension_command("getTabsWithMemory", {}, profile=args.get("profile"))
    if isinstance(result, dict) and "error" in result and not result.get("tabs"):
        return [text(f"Error: {result['error']}. Is the extension running?")]
    return as_json(result)


@tool("browser_get_tab_activity", "Get tab activity data: open duration, last visited, idle time for each tab.", schema())
async def get_tab_activity(args):
    return ext_result(send_extension_command("getTabActivity", {}, profile=args.get("profile")))


@tool("browser_get_stale_tabs", "Find tabs not visited in X hours. Default threshold is 2 hours.", schema({
    "threshold_hours": {"type": "number", "description": "Hours of inactivity to consider stale", "default": 2},
}))
async def get_stale_tabs(args):
    return ext_result(send_extension_command("getStaleTabs", {"thresholdHours": args.get("threshold_hours", 2)}, profile=args.get("profile")))


@tool("browser_list_suspended", "List all suspended tabs with their original URLs.", schema())
async def list_suspended(args):
    return ext_result(send_extension_command("listSuspended", {}, profile=args.get("profile")))


@tool("browser_suspend_tabs", "Suspend tabs by tab IDs via Great Suspender. Respects whitelist.", schema({
    "tab_ids": {**TAB_IDS, "description": "Chrome tab IDs to suspend"},
}, ["tab_ids"]))
async def suspend_tabs(args):
    return ext_result(send_extension_command("suspendTabs", {"tabIds": args.get("tab_ids", [])}, profile=args.get("profile")))


@tool("browser_unsuspend_tabs", "Unsuspend (restore) suspended tabs by tab IDs.", schema({
    "tab_ids": {**TAB_IDS, "description": "Chrome tab IDs to restore"},
}, ["tab_ids"]))
async def unsuspend_tabs(args):
    return ext_result(send_extension_command("unsuspendTabs", {"tabIds": args.get("tab_ids", [])}, profile=args.get("profile")))


@tool("browser_suspend_whitelist", "Manage domains exempt from suspension. Actions: list, add, remove.", schema({
    "action": {"type": "string", "description": "list, add, or remove", "enum": ["list", "add", "remove"]},
    "domains": {"type": "array", "description": "Domains to add/remove", "items": {"type": "string"}},
}, ["action"]))
async def suspend_whitelist(args):
    payload = {"action": args.get("action", "list"), "domains": args.get("domains", [])}
    return ext_result(send_extension_command("suspendWhitelist", payload, profile=args.get("profile")))


@tool("browser_close_by_ids", "Close specific tabs by their Chrome tab IDs.", schema({
    "tab_ids": {**TAB_IDS, "description": "List of tab IDs to close"},
}, ["tab_ids"]))
async def close_by_ids(args):
    tab_ids = args.get("tab_ids", [])
    if not tab_ids:
        return [text("No tab IDs provided")]
    result = send_extension_command("closeTabs", {"tabIds": tab_ids}, profile=args.get("profile"))
    if isinstance(result, dict) and "error" in result:
        return [text(f"Error: {result['error']}")]
    return [text(f"Closed {len(tab_ids)} tabs")]


@tool("browser_open_tabs", "Open URLs as new background tabs (http/https only). Optionally add them to a named group (reuses an existing group with that name).", schema({
    "urls": {"type": "array", "description": "URLs to open", "items": {"type": "string"}},
    "group": {"type": "string", "description": "Optional group name to put the new tabs in"},
    "color": {"type": "string", "description": "Group color if a new group is created", "default": "blue"},
    "active": {"type": "boolean", "description": "Focus the first opened tab (also needs allow_focus)", "default": False},
    "allow_focus": {"type": "boolean", "description": "Permit stealing the user's window focus; refused by the extension otherwise", "default": False},
}, ["urls"]))
async def open_tabs(args):
    profile, urls = args.get("profile"), args.get("urls", [])
    # Only web URLs: no javascript:, file:, chrome: etc.
    bad = [u for u in urls if urlparse(u).scheme not in ("http", "https")]
    if not urls or bad:
        return [text(f"Error: urls must be a non-empty list of http/https URLs. Rejected: {bad}")]
    payload = {"urls": urls, "active": args.get("active", False), "allowFocus": args.get("allow_focus", False)}
    result = send_extension_command("openTabs", payload, profile=profile)
    if isinstance(result, dict) and "error" in result:
        return [text(f"Error: {result['error']}")]
    msg = f"Opened {result.get('opened', 0)} tabs"
    group = args.get("group")
    if group and result.get("tabIds"):
        grouped = await dispatch("browser_create_group", {"name": group, "color": args.get("color", "blue"), "tab_ids": result["tabIds"], "profile": profile})
        msg += f"; {grouped[0].text}"
    return [text(msg)]
