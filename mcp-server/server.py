#!/usr/bin/env python3
"""MCP Server for browser tab management."""

import json
import subprocess
import asyncio
import time
import os
import re
from urllib.parse import urlparse
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

server = Server("browser-tabs")

CMD_FILE = "/tmp/tab-manager-cmd.json"
RESULT_FILE = "/tmp/tab-manager-result.json"
REGISTRY_FILE = "/tmp/tab-manager-registry.json"

# Optional profile param added to extension-based tools
PROFILE_PROP = {
    "profile": {
        "type": "string",
        "description": "Target browser profile (e.g. 'edge-kgofki...'). Omit for default.",
    }
}


def get_active_profiles() -> list:
    """Read the registry of active browser+profile connections."""
    if not os.path.exists(REGISTRY_FILE):
        return []
    try:
        with open(REGISTRY_FILE, 'r') as f:
            registry = json.load(f)
        now = time.time()
        return [v for v in registry.values() if now - v.get('last_seen', 0) < 300]
    except Exception:
        return []


def send_extension_command(action: str, payload: dict, timeout: int = 10, profile: str = None) -> dict:
    """Send command to extension via file-based IPC."""
    # Route to specific profile if requested
    if profile:
        profiles = get_active_profiles()
        match = None
        for p in profiles:
            key = f"{p['browser']}-{p['profile']}"
            if profile in key:
                match = p
                break
        if match:
            return _send_to_ipc(action, payload, match['cmd_file'], match['result_file'], timeout)
        active = [f"{p['browser']}-{p['profile']}" for p in profiles]
        return {"error": f"Profile '{profile}' not found. Active: {active}"}
    # Default IPC files
    return _send_to_ipc(action, payload, CMD_FILE, RESULT_FILE, timeout)


def _send_to_ipc(action: str, payload: dict, cmd_path: str, result_path: str, timeout: int) -> dict:
    """Send command via specific IPC file pair."""
    cmd = {"action": action, "payload": payload, "timestamp": time.time()}
    with open(cmd_path, 'w') as f:
        json.dump(cmd, f)
    start = time.time()
    while time.time() - start < timeout:
        if os.path.exists(result_path):
            try:
                with open(result_path, 'r') as f:
                    result = json.load(f)
                if result.get('timestamp', 0) > cmd['timestamp']:
                    os.remove(result_path)
                    return result.get('data', result)
            except Exception:
                pass
        time.sleep(0.2)
    return {"error": "timeout waiting for extension"}


def run_osascript(script: str) -> str:
    """Execute AppleScript and return output."""
    result = subprocess.run(
        ['osascript', '-e', script],
        capture_output=True, text=True
    )
    return result.stdout.strip() or result.stderr.strip()


def get_tabs_data(browser: str = "Microsoft Edge") -> list:
    """Get tabs using AppleScript and parse in Python."""
    # Get URLs
    url_script = f'tell application "{browser}" to get URL of tabs of windows'
    urls_raw = run_osascript(url_script)

    # Get titles
    title_script = f'tell application "{browser}" to get title of tabs of windows'
    titles_raw = run_osascript(title_script)

    # Parse comma-separated values
    urls = [u.strip() for u in urls_raw.split(', ') if u.strip()]
    titles = [t.strip() for t in titles_raw.split(', ') if t.strip()]

    # Get window/tab indices
    count_script = f'''
tell application "{browser}"
    set output to ""
    set winIdx to 0
    repeat with w in windows
        set winIdx to winIdx + 1
        set tabIdx to 0
        repeat with t in tabs of w
            set tabIdx to tabIdx + 1
            set output to output & winIdx & ":" & tabIdx & ","
        end repeat
    end repeat
    return output
end tell
'''
    indices_raw = run_osascript(count_script)
    indices = [i.strip() for i in indices_raw.split(',') if i.strip()]

    tabs = []
    for i, (url, title) in enumerate(zip(urls, titles)):
        win, tab = 1, i + 1
        if i < len(indices) and ':' in indices[i]:
            parts = indices[i].split(':')
            win, tab = int(parts[0]), int(parts[1])
        tabs.append({
            "window": win,
            "tab": tab,
            "title": title,
            "url": url
        })

    return tabs


def close_tab_script(browser: str, window: int, tab: int) -> str:
    """Generate AppleScript to close a specific tab."""
    return f'tell application "{browser}" to close tab {tab} of window {window}'


def close_tabs_by_url_script(browser: str, url_pattern: str) -> str:
    """Generate AppleScript to close tabs matching URL pattern."""
    return f'''
tell application "{browser}"
    repeat with w in windows
        repeat with t in tabs of w
            if URL of t contains "{url_pattern}" then
                close t
            end if
        end repeat
    end repeat
end tell
'''


def _ext_result(result):
    """Return extension result as TextContent."""
    if isinstance(result, dict) and "error" in result:
        return [TextContent(type="text", text=f"Error: {result['error']}. Is the extension running?")]
    return [TextContent(type="text", text=json.dumps(result, indent=2))]


# --- Personalized cleanup patterns ---
# Tabs matching these are always safe to suggest closing
STALE_PATTERNS = [
    'accounts.google.com',     # sign-in redirects
    'edge://newtab', 'chrome://newtab', 'about:blank',  # new tabs
    '/oauth/', '/signin/', '/callback',  # auth flows
    'google.com/search', 'bing.com/search',  # search results
]

# One-time tabs: usually opened, used once, forgotten
ONE_TIME_PATTERNS = [
    'slack.com/files',         # slack file downloads
    'mail.google.com',         # email opened in browser
]

# Domains to never suggest closing
KEEP_DOMAINS = [
    'notion.so',               # docs/TRDs — ask first
    'console.cloud.google.com',  # GCP — ask first
]


def check_pr_status(url: str) -> str:
    """Check if a GitHub PR is merged/closed/open via gh CLI."""
    match = re.search(r'github\.com/([^/]+/[^/]+)/pull/(\d+)', url)
    if not match:
        return 'unknown'
    repo, number = match.group(1), match.group(2)
    try:
        result = subprocess.run(
            ['gh', 'pr', 'view', f'https://github.com/{repo}/pull/{number}',
             '--json', 'state', '-q', '.state'],
            capture_output=True, text=True, timeout=10
        )
        return result.stdout.strip().lower() or 'unknown'
    except Exception:
        return 'unknown'


def categorize_tabs(tabs: list, check_prs: bool = True) -> dict:
    """Categorize tabs into actionable groups."""
    categories = {
        'merged_prs': [],      # safe to close
        'closed_prs': [],      # safe to close
        'open_prs': [],        # keep
        'signin_pages': [],    # safe to close
        'new_tabs': [],        # safe to close
        'one_time': [],        # suggest close
        'search_results': [],  # suggest close
        'suspended': [],       # info only
        'grouped': [],         # skip
        'duplicates': [],      # close extras
        'keep': [],            # remaining
    }

    seen_urls = {}
    for t in tabs:
        url = t.get('url', '')
        title = t.get('title', '')
        is_grouped = t.get('groupId', -1) != -1

        # Suspended
        if 'chrome-extension://' in url and 'suspended' in url:
            categories['suspended'].append(t)
            continue

        # Grouped tabs — skip
        if is_grouped:
            categories['grouped'].append(t)
            continue

        # GitHub PRs
        if 'github.com' in url and '/pull/' in url:
            if check_prs:
                status = check_pr_status(url)
                t['pr_status'] = status
                if status == 'merged':
                    categories['merged_prs'].append(t)
                elif status == 'closed':
                    categories['closed_prs'].append(t)
                else:
                    categories['open_prs'].append(t)
            else:
                categories['open_prs'].append(t)
            continue

        # Sign-in / auth pages
        if 'accounts.google.com' in url or 'Sign In' in title or 'Sign in' in title or '/signin' in url or '/oauth/' in url:
            categories['signin_pages'].append(t)
            continue

        # New tabs
        if any(p in url for p in ['edge://newtab', 'chrome://newtab', 'about:blank']):
            categories['new_tabs'].append(t)
            continue

        # Search results
        if 'google.com/search' in url or 'bing.com/search' in url:
            categories['search_results'].append(t)
            continue

        # One-time tabs
        if any(p in url for p in ONE_TIME_PATTERNS):
            categories['one_time'].append(t)
            continue

        # Duplicate detection
        clean_url = url.split('?')[0].split('#')[0]
        if clean_url in seen_urls:
            categories['duplicates'].append(t)
            continue
        seen_urls[clean_url] = t

        categories['keep'].append(t)

    return categories


@server.list_tools()
async def list_tools():
    return [
        Tool(
            name="browser_list_tabs",
            description="List all open browser tabs with their titles and URLs",
            inputSchema={
                "type": "object",
                "properties": {
                    "browser": {
                        "type": "string",
                        "description": "Browser name: 'Microsoft Edge', 'Google Chrome', or 'Safari'",
                        "default": "Microsoft Edge"
                    }
                }
            }
        ),
        Tool(
            name="browser_close_tabs",
            description="Close browser tabs by URL pattern or specific window/tab indices",
            inputSchema={
                "type": "object",
                "properties": {
                    "browser": {
                        "type": "string",
                        "default": "Microsoft Edge"
                    },
                    "url_pattern": {
                        "type": "string",
                        "description": "Close all tabs whose URL contains this pattern"
                    },
                    "tabs": {
                        "type": "array",
                        "description": "List of {window, tab} objects to close",
                        "items": {
                            "type": "object",
                            "properties": {
                                "window": {"type": "integer"},
                                "tab": {"type": "integer"}
                            }
                        }
                    }
                }
            }
        ),
        Tool(
            name="browser_count_windows",
            description="Count the number of open browser windows",
            inputSchema={
                "type": "object",
                "properties": {
                    "browser": {
                        "type": "string",
                        "default": "Microsoft Edge"
                    }
                }
            }
        ),
        Tool(
            name="browser_suggest_cleanup",
            description="Analyze tabs and suggest which to close and how to group the rest.",
            inputSchema={
                "type": "object",
                "properties": {
                    "browser": {
                        "type": "string",
                        "default": "Microsoft Edge"
                    },
                    "close_patterns": {
                        "type": "array",
                        "description": "URL patterns to mark for closing",
                        "items": {"type": "string"}
                    },
                    "group_by_domain": {
                        "type": "boolean",
                        "description": "Whether to group remaining tabs by domain",
                        "default": True
                    }
                }
            }
        ),
        Tool(
            name="browser_create_group",
            description="Create a tab group with specified tabs via extension.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Name for the tab group"},
                    "color": {"type": "string", "description": "Color: grey, blue, red, yellow, green, pink, purple, cyan, orange", "default": "blue"},
                    "tab_ids": {"type": "array", "description": "Chrome tab IDs to group", "items": {"type": "integer"}},
                    **PROFILE_PROP
                },
                "required": ["name", "tab_ids"]
            }
        ),
        Tool(
            name="browser_get_tabs_ext",
            description="Get tabs via extension with Chrome tab IDs (required for grouping).",
            inputSchema={"type": "object", "properties": {**PROFILE_PROP}}
        ),
        Tool(
            name="browser_close_duplicates",
            description="Find and close all duplicate tabs (same URL). Keeps one per URL.",
            inputSchema={"type": "object", "properties": {**PROFILE_PROP}}
        ),
        Tool(
            name="browser_get_memory",
            description="Get memory usage per tab with memory hog detection. Returns tabs sorted by memory.",
            inputSchema={"type": "object", "properties": {**PROFILE_PROP}}
        ),
        # v1.2 - Time Tracking
        Tool(
            name="browser_get_tab_activity",
            description="Get tab activity data: open duration, last visited, idle time for each tab.",
            inputSchema={"type": "object", "properties": {**PROFILE_PROP}}
        ),
        Tool(
            name="browser_get_stale_tabs",
            description="Find tabs not visited in X hours. Default threshold is 2 hours.",
            inputSchema={
                "type": "object",
                "properties": {
                    "threshold_hours": {"type": "number", "description": "Hours of inactivity to consider stale", "default": 2},
                    **PROFILE_PROP
                }
            }
        ),
        # v1.3 - Great Suspender
        Tool(
            name="browser_list_suspended",
            description="List all suspended tabs with their original URLs.",
            inputSchema={"type": "object", "properties": {**PROFILE_PROP}}
        ),
        Tool(
            name="browser_suspend_tabs",
            description="Suspend tabs by tab IDs via Great Suspender. Respects whitelist.",
            inputSchema={
                "type": "object",
                "properties": {
                    "tab_ids": {"type": "array", "description": "Chrome tab IDs to suspend", "items": {"type": "integer"}},
                    **PROFILE_PROP
                },
                "required": ["tab_ids"]
            }
        ),
        Tool(
            name="browser_unsuspend_tabs",
            description="Unsuspend (restore) suspended tabs by tab IDs.",
            inputSchema={
                "type": "object",
                "properties": {
                    "tab_ids": {"type": "array", "description": "Chrome tab IDs to restore", "items": {"type": "integer"}},
                    **PROFILE_PROP
                },
                "required": ["tab_ids"]
            }
        ),
        Tool(
            name="browser_suspend_whitelist",
            description="Manage domains exempt from suspension. Actions: list, add, remove.",
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "list, add, or remove", "enum": ["list", "add", "remove"]},
                    "domains": {"type": "array", "description": "Domains to add/remove", "items": {"type": "string"}},
                    **PROFILE_PROP
                },
                "required": ["action"]
            }
        ),
        # v1.4 - Multi-Profile
        Tool(
            name="browser_list_profiles",
            description="List all active browser profiles connected via extension.",
            inputSchema={"type": "object", "properties": {}}
        ),
        Tool(
            name="browser_search_all_tabs",
            description="Search tabs across all browsers and profiles by title or URL pattern.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search string to match against tab title or URL"}
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="browser_smart_cleanup",
            description="Auto-categorize tabs: checks GitHub PR merge status, finds duplicates, sign-in pages, search results, one-time tabs. Returns categorized report with tab IDs ready for closing.",
            inputSchema={
                "type": "object",
                "properties": {
                    "check_prs": {"type": "boolean", "description": "Check GitHub PR statuses via gh CLI (slower but accurate)", "default": True},
                    **PROFILE_PROP
                }
            }
        ),
        Tool(
            name="browser_close_by_ids",
            description="Close specific tabs by their Chrome tab IDs.",
            inputSchema={
                "type": "object",
                "properties": {
                    "tab_ids": {"type": "array", "description": "List of tab IDs to close", "items": {"type": "integer"}},
                    **PROFILE_PROP
                },
                "required": ["tab_ids"]
            }
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict):
    browser = arguments.get("browser", "Microsoft Edge")
    profile = arguments.get("profile")

    if name == "browser_list_tabs":
        tabs = get_tabs_data(browser)
        return [TextContent(type="text", text=json.dumps(tabs, indent=2))]

    elif name == "browser_close_tabs":
        url_pattern = arguments.get("url_pattern")
        tabs = arguments.get("tabs", [])
        if url_pattern:
            script = close_tabs_by_url_script(browser, url_pattern)
            run_osascript(script)
            return [TextContent(type="text", text=f"Closed tabs matching: {url_pattern}")]
        if tabs:
            tabs_sorted = sorted(tabs, key=lambda x: (x['window'], x['tab']), reverse=True)
            for t in tabs_sorted:
                script = close_tab_script(browser, t['window'], t['tab'])
                run_osascript(script)
            return [TextContent(type="text", text=f"Closed {len(tabs)} tabs")]
        return [TextContent(type="text", text="No tabs specified to close")]

    elif name == "browser_count_windows":
        script = f'tell application "{browser}" to count windows'
        count = run_osascript(script)
        return [TextContent(type="text", text=f"{browser} has {count} windows open")]

    elif name == "browser_suggest_cleanup":
        tabs = get_tabs_data(browser)
        if not tabs:
            return [TextContent(type="text", text="No tabs found")]
        close_patterns = arguments.get("close_patterns", [])
        group_by_domain = arguments.get("group_by_domain", True)
        to_close = []
        to_keep = []
        for tab in tabs:
            url = tab.get('url', '')
            if any(p in url for p in close_patterns):
                to_close.append(tab)
            else:
                to_keep.append(tab)
        groups = {}
        if group_by_domain:
            for tab in to_keep:
                url = tab.get('url', '')
                try:
                    domain = urlparse(url).netloc.replace('www.', '')
                except Exception:
                    domain = 'other'
                if domain not in groups:
                    groups[domain] = []
                groups[domain].append(tab)
        plan = {
            "to_close": to_close,
            "groups": groups,
            "summary": {
                "total_tabs": len(tabs),
                "tabs_to_close": len(to_close),
                "tabs_to_keep": len(to_keep),
                "groups": len(groups)
            }
        }
        return [TextContent(type="text", text=json.dumps(plan, indent=2))]

    elif name == "browser_create_group":
        group_name = arguments.get("name")
        color = arguments.get("color", "blue")
        tab_ids = arguments.get("tab_ids", [])
        if not group_name or not tab_ids:
            return [TextContent(type="text", text="Error: name and tab_ids are required")]
        result = send_extension_command("createGroup", {"name": group_name, "color": color, "tabIds": tab_ids}, profile=profile)
        if "error" in result:
            return [TextContent(type="text", text=f"Error: {result['error']}")]
        return [TextContent(type="text", text=f"Created group '{group_name}' with {len(tab_ids)} tabs")]

    elif name == "browser_get_tabs_ext":
        return _ext_result(send_extension_command("getTabs", {}, profile=profile))

    elif name == "browser_close_duplicates":
        tabs = send_extension_command("getTabs", {}, profile=profile)
        if isinstance(tabs, dict) and "error" in tabs:
            return [TextContent(type="text", text=f"Error: {tabs['error']}. Is the extension running?")]
        url_to_tabs = {}
        for tab in tabs:
            url = tab.get('url', '')
            if url not in url_to_tabs:
                url_to_tabs[url] = []
            url_to_tabs[url].append(tab)
        to_close = []
        new_tab_urls = ['edge://newtab/', 'chrome://newtab/', 'about:newtab', 'about:blank']
        for url, tab_list in url_to_tabs.items():
            if any(url.startswith(nt) for nt in new_tab_urls):
                to_close.extend([t['id'] for t in tab_list])
            elif len(tab_list) > 1:
                to_close.extend([t['id'] for t in tab_list[1:]])
        if not to_close:
            return [TextContent(type="text", text="No duplicate tabs found")]
        result = send_extension_command("closeTabs", {"tabIds": to_close}, profile=profile)
        if isinstance(result, dict) and "error" in result:
            return [TextContent(type="text", text=f"Error closing tabs: {result['error']}")]
        return [TextContent(type="text", text=f"Closed {len(to_close)} duplicate tabs")]

    elif name == "browser_get_memory":
        result = send_extension_command("getTabsWithMemory", {}, profile=profile)
        if isinstance(result, dict) and "error" in result and not result.get("tabs"):
            return [TextContent(type="text", text=f"Error: {result['error']}. Is the extension running?")]
        return [TextContent(type="text", text=json.dumps(result, indent=2))]

    # v1.2 - Time Tracking
    elif name == "browser_get_tab_activity":
        return _ext_result(send_extension_command("getTabActivity", {}, profile=profile))

    elif name == "browser_get_stale_tabs":
        threshold = arguments.get("threshold_hours", 2)
        return _ext_result(send_extension_command("getStaleTabs", {"thresholdHours": threshold}, profile=profile))

    # v1.3 - Great Suspender
    elif name == "browser_list_suspended":
        return _ext_result(send_extension_command("listSuspended", {}, profile=profile))

    elif name == "browser_suspend_tabs":
        tab_ids = arguments.get("tab_ids", [])
        return _ext_result(send_extension_command("suspendTabs", {"tabIds": tab_ids}, profile=profile))

    elif name == "browser_unsuspend_tabs":
        tab_ids = arguments.get("tab_ids", [])
        return _ext_result(send_extension_command("unsuspendTabs", {"tabIds": tab_ids}, profile=profile))

    elif name == "browser_suspend_whitelist":
        action = arguments.get("action", "list")
        domains = arguments.get("domains", [])
        return _ext_result(send_extension_command("suspendWhitelist", {"action": action, "domains": domains}, profile=profile))

    # v1.4 - Multi-Profile
    elif name == "browser_list_profiles":
        profiles = get_active_profiles()
        return [TextContent(type="text", text=json.dumps(profiles, indent=2))]

    elif name == "browser_search_all_tabs":
        query = arguments.get("query", "").lower()
        profiles = get_active_profiles()
        all_results = []
        for p in profiles:
            tabs = _send_to_ipc("getTabs", {}, p['cmd_file'], p['result_file'], 10)
            if isinstance(tabs, list):
                for t in tabs:
                    if query in t.get('title', '').lower() or query in t.get('url', '').lower():
                        t['profile'] = f"{p['browser']}-{p['profile']}"
                        all_results.append(t)
        return [TextContent(type="text", text=json.dumps(all_results, indent=2))]

    elif name == "browser_smart_cleanup":
        check_prs = arguments.get("check_prs", True)
        tabs = send_extension_command("getTabs", {}, profile=profile)
        if isinstance(tabs, dict) and "error" in tabs:
            return [TextContent(type="text", text=f"Error: {tabs['error']}")]
        cats = categorize_tabs(tabs, check_prs=check_prs)
        # Build summary with IDs for easy closing
        safe_to_close = []
        report = {"total": len(tabs)}
        for cat in ['merged_prs', 'closed_prs', 'signin_pages', 'new_tabs', 'search_results', 'one_time', 'duplicates']:
            items = cats[cat]
            if items:
                report[cat] = [{"id": t["id"], "title": t.get("title", "")[:60], "url": t.get("url", "")[:80]} for t in items]
                safe_to_close.extend([t["id"] for t in items])
        report["safe_to_close_ids"] = safe_to_close
        report["safe_to_close_count"] = len(safe_to_close)
        # Info sections
        for cat in ['open_prs', 'suspended', 'grouped', 'keep']:
            items = cats[cat]
            if items:
                report[f"{cat}_count"] = len(items)
        return [TextContent(type="text", text=json.dumps(report, indent=2))]

    elif name == "browser_close_by_ids":
        tab_ids = arguments.get("tab_ids", [])
        if not tab_ids:
            return [TextContent(type="text", text="No tab IDs provided")]
        result = send_extension_command("closeTabs", {"tabIds": tab_ids}, profile=profile)
        if isinstance(result, dict) and "error" in result:
            return [TextContent(type="text", text=f"Error: {result['error']}")]
        return [TextContent(type="text", text=f"Closed {len(tab_ids)} tabs")]

    return [TextContent(type="text", text=f"Unknown tool: {name}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())

if __name__ == "__main__":
    asyncio.run(main())
