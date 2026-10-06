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
- Slack file downloads (`slack.com/files`)
- Gmail tabs opened from links (`mail.google.com`)
- `accounts.google.com` sign-in redirects
- Merged/closed GitHub PRs (auto-detected via `gh pr view`)

### Profiles
- `edge-54f24d93` = **Emergent work** (100-180 tabs, GCP grouped)
- `edge-59a2f80d` = **Personal**
- Chrome: not set up on this laptop yet
- IDs are per-profile UUIDs in `chrome.storage.local`; they change if the extension is removed/re-added. Live list: `browser_list_profiles`

### Cleanup Workflow
1. Run `browser_smart_cleanup --profile=<id>` — auto-categorizes + checks PRs
2. Review the `safe_to_close_ids` list
3. Confirm with user
4. Run `browser_close_by_ids --tab_ids=[...]`

### Grouping Rules
- Group by domain when multiple tabs from same site
- Group by project when URL contains project identifier
- Ask user for custom grouping preferences

## Extension Development Guidelines

### Architecture
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

### Adding New Features
1. Add the handler to the right `extension/src/*.js` module and register it in `ACTIONS` (`src/main.js`)
2. Add a `@tool` in the matching `mcp-server/tools/*.py` (schema + handler in one place)
3. Run `node extension/registry.test.mjs`, `node extension/cdp.test.mjs`, `uv run python3 mcp-server/tests/test_host_ipc.py`
4. Load new code with `browser_reload_extension`, test live in **background tabs of the personal profile only** (never activate)
5. Focus-changing actions require `allow_focus=true`; don't add new ones without that gate

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

### v1.5 - Metrics & Learning
Phase 1 — Data Collection (extension):
- [ ] `domainBehavior` store: per-domain activations, freshOpens, survived, closed, bursts
- [ ] Enhanced `onCreated`: track openerTabId, cache domain, increment freshOpens, burst detection
- [ ] Enhanced `onActivated`: increment activations, track focus time (totalFocusMs)
- [ ] Enhanced `onRemoved`: use cached domain for cleanup
- [ ] Burst detection: 5+ tabs from same domain in 30s = research burst
- [ ] New handlers: `getDomainBehavior`, `getTabTracking`, `recordCleanupResult`

Phase 2 — Smart Decisions (server):
- [ ] `compute_activation_ratio()`: disposable (freshOpen heavy) vs sticky (activation heavy)
- [ ] `compute_survival_rate()`: replaces hardcoded STALE_PATTERNS/KEEP_DOMAINS over time
- [ ] 30-day "no" override: kept but never activated for 30d → nudge anyway
- [ ] Frozen group detection: group tabs (misc/reading list) with 0 activations for 30d
- [ ] Tab temperature labels: hot/warm/cold/frozen on all tab listings
- [ ] Navigation source scoring: orphaned tabs, notification-spawned tabs
- [ ] `browser_record_cleanup` tool: feedback loop for survival tracking
- [ ] `browser_get_domain_insights` tool: inspect learned behavior

Phase 3 — UI:
- [ ] Temperature badges in popup (hot=red, warm=orange, cold=blue, frozen=grey)

### Future Ideas
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
