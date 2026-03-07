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

## Available MCP Tools (16)

| Tool | Description | Backend |
|------|-------------|---------|
| **Tab Management** | | |
| `browser_list_tabs` | List all tabs with titles/URLs | AppleScript |
| `browser_get_tabs_ext` | Get tabs with Chrome IDs (supports `--profile`) | Extension |
| `browser_close_tabs` | Close tabs by URL pattern or indices | AppleScript |
| `browser_close_duplicates` | Close all duplicate tabs + new tab pages | Extension |
| `browser_create_group` | Create named/colored tab groups | Extension |
| `browser_count_windows` | Count browser windows | AppleScript |
| `browser_suggest_cleanup` | Analyze and suggest tab cleanup | AppleScript |
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
├── extension/
│   ├── manifest.json        # Manifest V3 (tabs, tabGroups, debugger, storage, management)
│   ├── background.js        # Service worker - all tab/memory/suspend logic
│   ├── preview.html         # Popup UI for change preview
│   └── preview.js           # Popup logic
├── native-host/
│   ├── host.py              # Native messaging host (per-profile IPC + registry)
│   ├── install.sh           # Installer script
│   └── com.tabmanager.host.json
└── mcp-server/
    ├── server.py            # MCP server (16 tools)
    └── pyproject.toml       # Python project config
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
