Controlling Browsers from the Terminal (macOS)

This document explains how to inspect and control web browsers using the terminal on macOS. The core mechanism is AppleScript, executed via the osascript command.

⸻

1. Core Idea

macOS applications expose an automation interface (Apple Events). Browsers like Chrome, Safari, and Edge expose:
	•	windows
	•	tabs
	•	URLs
	•	titles

osascript lets you send commands to these apps from the terminal.

Mental model: Terminal → osascript → Browser Automation API

⸻

2. Why osascript
	•	Native to macOS (no install)
	•	Stable, supported by Apple
	•	Direct access to browser internals (tabs, URLs)

Alternatives (JS injection, accessibility APIs) are fragile or limited.

⸻

3. Basic Syntax

osascript -e '<AppleScript code>'

Multi-line scripts are allowed.

⸻

4. Counting Browser Windows

Chrome

osascript -e 'tell application "Google Chrome" to count windows'

Safari

osascript -e 'tell application "Safari" to count windows'

Edge

osascript -e 'tell application "Microsoft Edge" to count windows'

Note: This counts windows, not tabs. Edge uses same syntax as Chrome (both Chromium-based).

⸻

5. Listing Open Tabs

Chrome – URLs only

osascript -e 'tell application "Google Chrome" to get URL of tabs of windows'

Chrome – titles + URLs (readable)

osascript -e '
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      log (title of t & " — " & URL of t)
    end repeat
  end repeat
end tell'

Safari – titles + URLs

osascript -e '
tell application "Safari"
  repeat with w in windows
    repeat with t in tabs of w
      log (name of t & " — " & URL of t)
    end repeat
  end repeat
end tell'

Output is printed to stdout, so it can be piped or saved.

⸻

6. Closing Tabs

Close the active tab (Chrome)

osascript -e 'tell application "Google Chrome" to close active tab of front window'

Close tabs matching a URL (Chrome)

osascript -e '
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "example.com" then close t
    end repeat
  end repeat
end tell'

Safari (same pattern)

osascript -e '
tell application "Safari"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "example.com" then close t
    end repeat
  end repeat
end tell'

⚠️ Be careful: loops can close multiple tabs.

⸻

7. Common Control Patterns

Close only ONE matching tab
	•	Add a return after close t

Dry-run (print before closing)
	•	Replace close t with log URL of t

Filter by title instead of URL

if title of t contains "Docs" then ...


⸻

8. Automation & Scripting

Because output goes to stdout, you can:
	•	pipe to grep
	•	save to files
	•	wrap in shell scripts
	•	create aliases or zsh functions

Example:

alias chrome-tabs='osascript -e "tell application \\\"Google Chrome\\\" to get URL of tabs of windows"'


⸻

9. Limitations
	•	Firefox: no reliable AppleScript tab API
	•	Tab Groups: not exposed via AppleScript (requires browser extension)
	•	Requires browser to be running
	•	First run may prompt for Automation permission

⸻

10. Security Notes
	•	AppleScript has full app control
	•	Avoid exposing raw osascript in shared or agent environments
	•	Prefer narrow wrappers (specific scripts)

⸻

11. Recommended Mental Model (Opinion)

Treat browsers like structured data sources, not GUIs.

Tabs = objects
URLs = fields
Terminal = controller

This approach scales cleanly into automation, agents, and MCP-style tooling.

⸻

12. Next Extensions
	•	JSON output formatting
	•	MCP wrapper around safe browser actions
	•	Raycast / Alfred integration
	•	Background tab cleanup jobs

⸻

End of document