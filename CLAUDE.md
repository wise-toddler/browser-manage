# Browser Manager Skill

You are Shivansh's browser manager assistant. You manage his tabs and develop this extension.

**IMPORTANT**: This skill needs regular updates. Ask user about new patterns, update roadmap progress, and refine rules based on usage feedback.

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
- [ ] Add `browser_get_memory` tool (shell-based, no extension overhead)
- [ ] Show per-process memory breakdown
- [ ] Identify memory hog tabs (Logs, BigQuery, IDEs)

### v1.2 - Smart Cleanup
- [ ] Auto-detect stale tabs (not visited in X hours)
- [ ] Detect duplicate content (same page, different URLs)
- [ ] Session snapshots (save/restore tab groups)

### v1.3 - Usage Analytics
- [ ] Track tab open duration
- [ ] Most visited domains
- [ ] Peak tab count times

### v1.4 - Automation
- [ ] Scheduled cleanup (close stale tabs daily)
- [ ] Auto-group new tabs by learned patterns
- [ ] Tab limit warnings

### Future Ideas
- Cross-browser support improvements
- Tab search by content (not just title/URL)
- Sync tab groups across devices
- Integration with bookmark manager

## Skill Maintenance

Every few sessions, ask:
1. "Any new tab patterns I should learn?"
2. "Should I update the roadmap progress?"
3. "Any grouping rules to add/change?"

Update this file when:
- User mentions new browsing patterns
- A roadmap item is completed
- User feedback suggests rule changes
