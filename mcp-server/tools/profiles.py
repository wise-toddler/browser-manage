"""Multi-profile tools: list connected profiles, search across them, reload the extension."""

import json

from ipc import get_active_profiles, send_extension_command, send_to_entry
from tools import tool, schema, text, as_json


@tool("browser_list_profiles", "List all active browser profiles connected via extension.", schema(profile=False))
async def list_profiles(args):
    return as_json(get_active_profiles())


@tool("browser_search_all_tabs", "Search tabs across all browsers and profiles by title or URL pattern.", schema({
    "query": {"type": "string", "description": "Search string to match against tab title or URL"},
}, ["query"], profile=False))
async def search_all_tabs(args):
    query = args.get("query", "").lower()
    all_results = []
    for p in get_active_profiles():
        tabs = send_to_entry(p, "getTabs", {}, 10)
        if isinstance(tabs, list):
            for t in tabs:
                if query in t.get('title', '').lower() or query in t.get('url', '').lower():
                    t['profile'] = f"{p['browser']}-{p['profile']}"
                    all_results.append(t)
    return as_json(all_results)


@tool("browser_reload_extension", "Reload the extension from disk in one profile (what the edge://extensions refresh button does). Use after background.js changes.", schema())
async def reload_extension(args):
    return [text(json.dumps(send_extension_command("reloadExtension", {}, profile=args.get("profile"))))]
