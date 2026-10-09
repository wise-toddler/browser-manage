---
name: browser-manage
description: Manage browser tabs across Chrome and Edge profiles. Clean stale tabs, check memory, suspend/unsuspend tabs, group tabs, detect duplicates. Trigger on "clean tabs", "browser tabs", "tab cleanup", "stale tabs", "memory hogs", "suspend tabs".
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

### Suspend/Resume (Great Suspender)
- `browser_list_suspended` — list suspended tabs with original URLs
- `browser_suspend_tabs` — suspend tabs by ID (respects whitelist)
- `browser_unsuspend_tabs` — restore suspended tabs
- `browser_suspend_whitelist` — manage never-suspend domains (list/add/remove)

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

## Usage via mcp-call

```bash
mcp-call browser-manage browser_list_profiles
mcp-call browser-manage browser_get_tabs_ext --profile=edge-54f24d93
mcp-call browser-manage browser_get_memory --profile=edge-59a2f80d
mcp-call browser-manage browser_get_stale_tabs --threshold_hours=1
mcp-call browser-manage browser_search_all_tabs --query=github
mcp-call browser-manage browser_suspend_whitelist --action=list
```

## Cleanup Workflow

1. `browser_list_profiles` — see connected profiles
2. `browser_get_stale_tabs` — find idle tabs
3. `browser_smart_cleanup` — get suggestions
4. Confirm with user before closing
5. `browser_get_memory` — check memory hogs
6. `browser_suspend_tabs` — suspend heavy tabs instead of closing

## Rules
- Always ask before closing tabs
- Never close grouped tabs without asking
- Keep research/GCP/Cloud console tabs unless asked
- Close: search results, OAuth pages, new tabs, login redirects
- Use `--profile` to target specific browser profile
