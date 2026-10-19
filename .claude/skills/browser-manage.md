---
name: browser-manage
description: Manage browser tabs across Chrome and Edge profiles. Clean stale tabs, check memory, group tabs, detect duplicates. Trigger on "clean tabs", "browser tabs", "tab cleanup", "stale tabs", "memory hogs".
---

# Browser Manager

Manage tabs across all connected Chrome and Edge profiles via the `browser-manage` MCP server.

## Available Tools

### Tab Management
- `browser_get_tabs_ext` — list all tabs (via extension, supports `--profile`, filter `group` / `url_contains`)
- `browser_close_by_ids` — close tabs by ID
- `browser_close_duplicates` — find and close duplicate tabs
- `browser_create_group` — group tabs with name and color
- `browser_close_group` — close every tab in a named group
- `browser_smart_cleanup` — categorize tabs (merged PRs, sign-in, search, dupes) + predictions

### Memory
- `browser_get_memory` — per-tab JS heap memory via Chrome Debugger API, flags hogs (URL pattern + >100MB)

### Time Tracking
- `browser_get_tab_activity` — open duration, last visited, idle time per tab
- `browser_get_stale_tabs` — tabs idle longer than threshold (default 2hrs)

### Multi-Profile
- `browser_list_profiles` — list all connected browser profiles
- `browser_search_all_tabs` — search tabs across all profiles by query

### Page automation (works on background tabs, never takes focus)
- `browser_read_page` → refs, then `browser_action(ref=…)`, `browser_upload(ref=…)`, `browser_wait_for(ref|selector|text|url_contains)`
- `browser_find(query)`, `browser_get_page_text`, `browser_run_script` (top-level `await`/`return`, `timeout_ms`), `browser_screenshot` (`selector`/`ref`/`clip` crop, full-page `tile`)
- `browser_set_viewport(width, height, dpr, mobile)` until `reset=true`; `browser_open_tabs` returns tab IDs as JSON
- `browser_debug` (`duration_ms` for one-shot) + `browser_read_console` (`page_only` default) / `browser_read_network` for debugging
- `browser_batch` to chain steps, `browser_record` start → actions → export GIF
- Never pass `allow_focus=true` unless the user asked for a visible tab
- Google Sheets: prefer `browser_sheets_write(tab_id, cells={"F25": "value"})`: writes in a background tab and reads every cell back (ok only when all landed, misses retried once)
- Background tabs: `type`/`key` are real keystrokes (work in Google Sheets/Docs); click/scroll are synthetic and return a `warning`. Google Sheets cell write, no focus needed: `browser_action type clear=true selector='#t-name-box' text='F8\n'` then `browser_action type selector='#waffle-rich-text-editor' text='value\n'`; verify with a gviz read-back (`run_script` fetch of `/spreadsheets/d/<id>/gviz/tq?tqx=out:csv&range=F8`), never with ok:true alone

## Usage via mcp-call

```bash
mcp-call browser-manage browser_list_profiles
mcp-call browser-manage browser_get_tabs_ext --profile=edge-54f24d93
mcp-call browser-manage browser_get_memory --profile=edge-59a2f80d
mcp-call browser-manage browser_get_stale_tabs --threshold_hours=1
mcp-call browser-manage browser_search_all_tabs --query=github
```

## Cleanup Workflow

1. `browser_list_profiles` — see connected profiles
2. `browser_get_stale_tabs` — find idle tabs
3. `browser_smart_cleanup` — get suggestions
4. Confirm with user before closing
5. `browser_get_memory` — check memory hogs

## Rules
- Always ask before closing tabs
- Never close grouped tabs without asking
- Keep research/GCP/Cloud console tabs unless asked
- Close: search results, OAuth pages, new tabs, login redirects
- Use `--profile` to target specific browser profile
