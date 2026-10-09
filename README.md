# Browser Tab Manager - MCP Server + Extension

Control browser tabs across Chrome and Edge profiles from terminal/CLI via MCP.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Claude /   │────▶│ MCP Server  │────▶│ Native Host  │────▶│  Browser    │
│  LLM        │     │ (Python)    │     │ (Python)     │     │  Extension  │
└─────────────┘     └─────────────┘     └──────────────┘     └─────────────┘
                          │                                         │
                     File IPC (per-profile)                    Chrome APIs
                          ▼                                         ▼
              /tmp/tab-manager-{browser}-{profile}-*.json    tabs, groups,
              /tmp/tab-manager-registry.json                 memory, suspend
```

## Available MCP Tools

| Tool | Description | Backend |
|------|-------------|---------|
| **Tab Management** | | |
| `browser_get_tabs_ext` | Get tabs with Chrome IDs, filter by `group` / `url_contains` (supports `--profile`) | Extension |
| `browser_close_duplicates` | Close all duplicate tabs + new tab pages | Extension |
| `browser_create_group` | Create named/colored tab groups | Extension |
| `browser_close_group` | Close every tab in a named group | Extension |
| **Memory** | | |
| `browser_get_memory` | Per-tab JS heap via Debugger API + hog detection | Extension |
| **Time Tracking** | | |
| `browser_get_tab_activity` | Open duration, last visited, idle time per tab | Extension |
| `browser_get_stale_tabs` | Find tabs idle longer than threshold | Extension |
| **Suspend/Resume** | | |
| `browser_list_suspended` | List suspended tabs with original URLs | Extension |
| `browser_suspend_tabs` | Suspend tabs (auto-detects Great Suspender) | Extension |
| `browser_unsuspend_tabs` | Restore suspended tabs | Extension |
| `browser_suspend_whitelist` | Manage never-suspend domains | Extension |
| **Multi-Profile** | | |
| `browser_list_profiles` | List all connected browser profiles | Registry |
| `browser_search_all_tabs` | Search tabs across all profiles | Extension |
| **Page automation** (background tabs, no focus) | | |
| `browser_read_page` | Role/name tree with stable `[ref=N]` | Extension |
| `browser_find` | Elements matching words, with refs | Extension |
| `browser_get_page_text` | Readable text (article/main/body) | Extension |
| `browser_action` | click/type/key/scroll/navigate/back/forward by ref, selector or x,y (keys like `Shift+Tab` use real CDP input even on hidden tabs) | Extension |
| `browser_wait_for` | Wait for selector/ref/text/URL (or gone) | Extension |
| `browser_upload` | Set files on `<input type=file>` | Extension |
| `browser_run_script` | JS in page context, logged: last expression, top-level `await`/`return`, promise results awaited, `timeout_ms` (8s default, 60s max), wakes sleeping tabs | Extension |
| `browser_screenshot` | Viewport, element crop (`selector`/`ref`), `clip` box, or full page in 8000px tiles; hidden tabs too | Extension |
| `browser_set_viewport` | Emulate width/height/dpr/mobile (stays until `reset=true`) | Extension |
| `browser_open_tabs` | Open URLs, optionally into a group; returns `[{tab_id, url, group_id}]` JSON | Extension |
| **Debugging** | | |
| `browser_debug` | Start/stop console + network capture (infobar shows while on); `duration_ms` = one-shot | Extension |
| `browser_read_console` / `browser_read_network` | Read captured logs / requests, response bodies; console hides extension/browser noise unless `page_only=false` | Extension |
| **Orchestration** | | |
| `browser_batch` | Run several tool calls in one round trip | Server |
| `browser_record` | Record screenshots of a tab's actions, export GIF | Server |
| `browser_reload_extension` | Reload extension code from disk | Extension |

Focus-changing calls (`activate`, `restore_from_triage`, `open_tabs active=true`) need `allow_focus=true`.

All extension-based tools accept an optional `--profile` parameter to target a specific browser profile.

## Setup

### 1. Install Extension
1. Open `edge://extensions` or `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/` folder
4. Repeat for each browser profile you want to manage

### 2. Install Native Host
```bash
cd native-host
./install.sh
```
This registers the native messaging host for Chrome and Edge.

### 3. Configure MCP Server
Add to Claude settings:
```bash
mcp-call --add browser-manage uv run --directory /path/to/browser-manage/mcp-server server.py
```

Or manually in `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "browser-manage": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/browser-manage/mcp-server", "server.py"]
    }
  }
}
```

## Multi-Profile Support

Each browser profile generates a unique ID (stored in `chrome.storage.local`) and registers itself in `/tmp/tab-manager-registry.json`. The native host creates per-profile IPC files:

```
/tmp/tab-manager-edge-3982a3d4-cmd.json      # Edge profile 1
/tmp/tab-manager-chrome-75cec1fc-cmd.json     # Chrome profile 1
/tmp/tab-manager-chrome-e94c1043-cmd.json     # Chrome profile 2
```

## Memory Hog Detection

Tabs are flagged as memory hogs via two methods:
- **URL patterns**: Known heavy sites (GCP Logs, BigQuery, Figma, IDEs, monitoring tools)
- **Actual memory**: Tabs using >100MB JS heap (measured via Chrome Debugger API)

## Great Suspender Integration

Auto-detects the Great Suspender extension (any version/fork) by scanning installed extensions via `chrome.management` API. No hardcoded extension IDs.

## Files

```
browser-manage/
├── extension/                 # Edge/Chrome extension (MV3, module service worker)
│   ├── manifest.json
│   ├── src/main.js            # native port + the single action registry (native + popup)
│   ├── src/cdp.js             # shared debugger sessions (refcounted, idle detach, pin)
│   ├── src/page.js            # self-contained in-page functions (serialized into tabs)
│   ├── src/{actions,capture,script,tabs,suspend,triage,tracking,util}.js
│   ├── preview.html/js        # popup
│   └── *.test.js / *.test.mjs # node tests, no deps
├── native-host/host.py        # native messaging <-> Unix socket (/tmp/tab-manager-<profile>.sock)
└── mcp-server/
    ├── server.py              # thin: lists/dispatches from the tool registry
    ├── ipc.py                 # profile registry + socket transport (file IPC fallback)
    ├── tools/                 # @tool modules: tabs, profiles, learning, script, capture, actions, triage
    ├── analysis.py            # cleanup categories, PR status, dispose classifier
    └── tests/test_host_ipc.py
```

## Debug

```bash
# Check native host logs
tail -f /tmp/tab-manager-host.log

# Check active profiles
cat /tmp/tab-manager-registry.json | python3 -m json.tool

# Test a specific profile
mcp-call browser-manage browser_get_tabs_ext --profile=edge-3982a3d4
```

## License

MIT
