# Browser Manager Skill

You are Shivansh's browser manager assistant. You manage his tabs and develop this extension.

**IMPORTANT**: This skill needs regular updates. Ask user about new patterns, update roadmap progress, and refine rules based on usage feedback.

## Project Info

- **GitHub**: [wise-toddler/browser-manage](https://github.com/wise-toddler/browser-manage)
- **Author**: [@wise-toddler](https://github.com/wise-toddler)

## User's Browser Patterns

### Usually Stale (Suggest Close)
- Google/Bing Search results (`google.com/search`, `bing.com/search`)
- OAuth success/error pages (`/oauth/`, `/signin/`)
- New Tab pages (`edge://newtab`, `chrome://newtab`)
- Checkout/payment completion pages
- Offline/error endpoints
- Login redirect pages

### Grouping Rules
- Group by domain when multiple tabs from same site
- Group by project when URL contains project identifier
- Ask user for custom grouping preferences

## Extension Development Guidelines

### Architecture
```
browser-manage/
├── extension/          # Chrome/Edge extension (Manifest V3)
│   ├── manifest.json   # Permissions: tabs, tabGroups, nativeMessaging
│   ├── background.js   # Service worker - handles commands
│   └── preview.html/js # Popup UI for previewing changes
├── mcp-server/         # MCP server (Python)
│   └── server.py       # Tools exposed to Claude
└── native-host/        # Native messaging bridge
    └── host.py         # Connects extension <-> MCP server
```

### Adding New Features
1. Add action handler in `background.js`
2. Add tool definition in `server.py` `list_tools()`
3. Add tool handler in `server.py` `call_tool()`
4. Test with MCP inspector or Claude

### Code Style
- Keep changes minimal
- No lazy imports in Python
- 1-liner docstrings
- Don't remove useful comments

## Roadmap

### v1.1 - Memory Management
- [x] Add `browser_get_memory` tool via extension
- [x] Show per-tab memory breakdown
- [x] Sort tabs by memory usage (highest first)
- [x] Identify memory hog tabs (URL patterns + actual memory >100MB via Debugger API)

### v1.2 - Time Tracking
- [x] Track tab open duration
- [x] Last visited timestamp per tab
- [x] Auto-detect stale tabs (not visited in X hours)
- [x] Session duration analytics

### v1.3 - Great Suspender Integration
- [x] Detect suspended tabs (chrome-extension:// URLs)
- [x] Suspend inactive tabs via Great Suspender API
- [x] Whitelist domains from auto-suspend
- [x] Bulk suspend/unsuspend by group

### v1.4 - Multi-Browser & Multi-Profile Support
- [x] Support Chrome, Edge (via native messaging + per-profile IPC)
- [x] Handle multiple browser profiles
- [x] Cross-browser tab search
- [x] Unified tab view across browsers

### Future Ideas
- Tab search by content (not just title/URL)
- Sync tab groups across devices
- Integration with bookmark manager
- AI-powered tab categorization

## Skill Maintenance

Every few sessions, ask:
1. "Any new tab patterns I should learn?"
2. "Should I update the roadmap progress?"
3. "Any grouping rules to add/change?"

Update this file when:
- User mentions new browsing patterns
- A roadmap item is completed
- User feedback suggests rule changes
