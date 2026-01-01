# Browser Tab Manager - MCP Server + Extension

Control browser tabs from terminal/CLI with LLM integration via MCP.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Claude /   │────▶│ MCP Server  │────▶│ Native Host  │────▶│  Browser    │
│  LLM        │     │ (Python)    │     │ (Python)     │     │  Extension  │
└─────────────┘     └─────────────┘     └──────────────┘     └─────────────┘
                          │                                         │
                          │ File IPC                                │ Chrome APIs
                          ▼                                         ▼
                    /tmp/tab-manager-cmd.json              tabs, groups, windows
                    /tmp/tab-manager-result.json
```

## Components

| Component | Path | Purpose |
|-----------|------|---------|
| MCP Server | `mcp-server/server.py` | Exposes tools to LLM |
| Native Host | `native-host/host.py` | Bridge between MCP and extension |
| Extension | `extension/` | Chrome/Edge extension for tab APIs |

## Available MCP Tools

| Tool | Description | Backend |
|------|-------------|---------|
| `browser_list_tabs` | List all tabs with titles/URLs | AppleScript |
| `browser_close_tabs` | Close tabs by pattern or indices | AppleScript |
| `browser_count_windows` | Count browser windows | AppleScript |
| `browser_suggest_cleanup` | Analyze and suggest tab cleanup | AppleScript |
| `browser_get_tabs_ext` | Get tabs with Chrome IDs | Extension |
| `browser_create_group` | Create named tab groups | Extension |
| `browser_close_duplicates` | Close all duplicate tabs | Extension |

## Setup

### 1. Install Extension
1. Open `edge://extensions` (or `chrome://extensions`)
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/` folder

### 2. Install Native Host
```bash
cd native-host
./install.sh
```

### 3. Configure MCP Server
Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "browser-tabs": {
      "command": "/path/to/browser-manage/mcp-server/.venv/bin/python",
      "args": ["/path/to/browser-manage/mcp-server/server.py"]
    }
  }
}
```

### 4. Create venv and install dependencies
```bash
cd mcp-server
python3 -m venv .venv
source .venv/bin/activate
pip install mcp
```

## Limitations

### Single Profile Only (Current)
- Native host uses stdin/stdout → one connection at a time
- File IPC is shared → commands could conflict
- Only the first-connected profile's tabs are managed

### Multi-Browser / Multi-Profile (Not Yet Supported)
See "Future: Multi-Browser Support" section below.

## Timeline

| Date | Milestone |
|------|-----------|
| 2026-01-02 | Initial implementation |
| 2026-01-02 | AppleScript-based tab listing for Chrome/Edge/Safari |
| 2026-01-02 | Extension created for tab grouping (not possible via AppleScript) |
| 2026-01-02 | Native messaging host for extension ↔ CLI communication |
| 2026-01-02 | MCP server with 7 tools |
| 2026-01-02 | Fixed normal windows filter for tab grouping |
| 2026-01-02 | Added `browser_close_duplicates` tool |

## Future: Multi-Browser Support

### Problem
Each browser+profile needs:
- Its own extension instance
- Its own native host connection
- Separate IPC files to avoid conflicts

### Proposed Solution

```
Browser      Profile     IPC Files
─────────────────────────────────────────────────────
Edge         Default     /tmp/tab-manager-edge-default-{cmd,result}.json
Edge         Work        /tmp/tab-manager-edge-work-{cmd,result}.json
Chrome       Default     /tmp/tab-manager-chrome-default-{cmd,result}.json
Chrome       Personal    /tmp/tab-manager-chrome-personal-{cmd,result}.json
```

### Implementation Plan
1. Extension sends browser+profile identifier on connect
2. Native host spawns per-profile, uses unique IPC files
3. MCP server routes commands to specific browser+profile
4. New tool parameter: `browser_profile` to target specific profile

### Native Host Registration Paths
```
# Edge
~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/

# Chrome
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/

# Chromium
~/Library/Application Support/Chromium/NativeMessagingHosts/
```

## Files

```
browser-manage/
├── README.md                 # This file
├── control.md               # AppleScript reference documentation
├── extension/
│   ├── manifest.json        # Extension manifest (Manifest V3)
│   ├── background.js        # Service worker - handles native messaging
│   ├── preview.html         # Popup UI for change preview
│   └── preview.js           # Popup logic
├── native-host/
│   ├── host.py              # Native messaging host
│   ├── install.sh           # Installer script
│   └── com.tabmanager.host.json  # Native host manifest
└── mcp-server/
    ├── server.py            # MCP server
    ├── pyproject.toml       # Python project config
    └── .venv/               # Virtual environment
```

## Debug

### Logs
- Native host: `/tmp/tab-manager-host.log`
- Extension: Browser DevTools → Console (background service worker)

### Test Extension Connection
```bash
# Check if native host is responding
cat /tmp/tab-manager-result.json
```

## License

MIT
