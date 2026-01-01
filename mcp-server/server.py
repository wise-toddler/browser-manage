#!/usr/bin/env python3
"""MCP Server for browser tab management."""

import json
import subprocess
import asyncio
import time
import os
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

server = Server("browser-tabs")

CMD_FILE = "/tmp/tab-manager-cmd.json"
RESULT_FILE = "/tmp/tab-manager-result.json"

def send_extension_command(action: str, payload: dict, timeout: int = 10) -> dict:
    """Send command to extension via file-based IPC."""
    # Write command
    cmd = {"action": action, "payload": payload, "timestamp": time.time()}
    with open(CMD_FILE, 'w') as f:
        json.dump(cmd, f)

    # Wait for result
    start = time.time()
    while time.time() - start < timeout:
        if os.path.exists(RESULT_FILE):
            try:
                with open(RESULT_FILE, 'r') as f:
                    result = json.load(f)
                if result.get('timestamp', 0) > cmd['timestamp']:
                    os.remove(RESULT_FILE)
                    return result.get('data', result)  # Return data field
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
            description="Analyze tabs and suggest which to close and how to group the rest. Returns a cleanup plan for user approval.",
            inputSchema={
                "type": "object",
                "properties": {
                    "browser": {
                        "type": "string",
                        "default": "Microsoft Edge"
                    },
                    "close_patterns": {
                        "type": "array",
                        "description": "URL patterns to mark for closing (e.g., 'cart', 'checkout', 'login')",
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
            description="Create a tab group with specified tabs. Requires the browser extension to be running. Use browser_get_tabs_ext to get Chrome tab IDs first.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name for the tab group"
                    },
                    "color": {
                        "type": "string",
                        "description": "Color: grey, blue, red, yellow, green, pink, purple, cyan, orange",
                        "default": "blue"
                    },
                    "tab_ids": {
                        "type": "array",
                        "description": "List of Chrome tab IDs to group (get from browser_get_tabs_ext)",
                        "items": {"type": "integer"}
                    }
                },
                "required": ["name", "tab_ids"]
            }
        ),
        Tool(
            name="browser_get_tabs_ext",
            description="Get tabs via extension with Chrome tab IDs (required for grouping). Use this instead of browser_list_tabs when you need to create groups.",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="browser_close_duplicates",
            description="Find and close all duplicate tabs (same URL). Keeps one tab per unique URL.",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        )
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    browser = arguments.get("browser", "Microsoft Edge")

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
            # Close in reverse order to avoid index shifting
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
            should_close = any(p in url for p in close_patterns)
            if should_close:
                to_close.append(tab)
            else:
                to_keep.append(tab)

        # Group by domain
        groups = {}
        if group_by_domain:
            for tab in to_keep:
                url = tab.get('url', '')
                try:
                    from urllib.parse import urlparse
                    domain = urlparse(url).netloc
                    domain = domain.replace('www.', '')
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

        result = send_extension_command("createGroup", {
            "name": group_name,
            "color": color,
            "tabIds": tab_ids
        })

        if "error" in result:
            return [TextContent(type="text", text=f"Error: {result['error']}")]

        return [TextContent(type="text", text=f"Created group '{group_name}' with {len(tab_ids)} tabs")]

    elif name == "browser_get_tabs_ext":
        result = send_extension_command("getTabs", {})
        if "error" in result:
            return [TextContent(type="text", text=f"Error: {result['error']}. Is the extension running?")]
        return [TextContent(type="text", text=json.dumps(result, indent=2))]

    elif name == "browser_close_duplicates":
        tabs = send_extension_command("getTabs", {})
        if "error" in tabs:
            return [TextContent(type="text", text=f"Error: {tabs['error']}. Is the extension running?")]

        # Group tabs by URL
        url_to_tabs = {}
        for tab in tabs:
            url = tab.get('url', '')
            if url not in url_to_tabs:
                url_to_tabs[url] = []
            url_to_tabs[url].append(tab)

        # Find duplicates (keep first, close rest) + new tabs
        to_close = []
        new_tab_urls = ['edge://newtab/', 'chrome://newtab/', 'about:newtab', 'about:blank']
        for url, tab_list in url_to_tabs.items():
            if any(url.startswith(nt) for nt in new_tab_urls):
                to_close.extend([t['id'] for t in tab_list])
            elif len(tab_list) > 1:
                to_close.extend([t['id'] for t in tab_list[1:]])

        if not to_close:
            return [TextContent(type="text", text="No duplicate tabs found")]

        # Close duplicates via extension
        result = send_extension_command("closeTabs", {"tabIds": to_close})
        if "error" in result:
            return [TextContent(type="text", text=f"Error closing tabs: {result['error']}")]

        return [TextContent(type="text", text=f"Closed {len(to_close)} duplicate tabs")]

    return [TextContent(type="text", text=f"Unknown tool: {name}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())

if __name__ == "__main__":
    asyncio.run(main())
