"""Run: uv run python3 tests/test_page_tools.py — P1 page tools: schemas, validation, payloads (no live host)."""

import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402,F401  (registers every tool)
import tools.page as page  # noqa: E402
from tools import REGISTRY, dispatch, ext_error, ext_result, tab_id_error  # noqa: E402

sent = []


def fake_send(action, payload, timeout=10, profile=None):
    """Record the call and answer like the extension would."""
    sent.append((action, payload, timeout))
    return {
        "readPage": {"url": "https://x.test/", "title": "X", "scroll": {"y": 0, "height": 900, "viewport": 900}, "nodes": 2,
                     "chars": 40, "truncated": False, "tree": 'button "Go" [ref=1]\nlink "Home" [ref=2] href="/"'},
        "findInPage": {"url": "https://x.test/", "matches": 1, "lines": ['button "Go" [ref=1]']},
        "getPageText": {"url": "https://x.test/", "title": "X", "source": "main", "chars": 5, "truncated": False, "text": "hello"},
        "waitFor": {"ok": True, "matched": "selector #a", "elapsedMs": 12},
        "uploadFiles": {"ok": True, "uploaded": 1, "mode": "debugger"},
    }[action]


page.send_extension_command = fake_send
run = lambda name, args: "\n".join(c.text for c in asyncio.run(dispatch(name, args)))

# Schemas
for name, required in {"browser_read_page": ["tab_id"], "browser_find": ["tab_id", "query"], "browser_get_page_text": ["tab_id"],
                       "browser_wait_for": ["tab_id"], "browser_upload": ["tab_id", "paths"]}.items():
    s = REGISTRY[name].tool.inputSchema
    assert s["required"] == required, (name, s["required"])
    assert "profile" in s["properties"], name
assert "ref" in REGISTRY["browser_action"].tool.inputSchema["properties"]
for name in ("browser_read_page", "browser_wait_for", "browser_upload"):
    assert "ref" in REGISTRY[name].tool.inputSchema["properties"], name
print("PASS schemas")

# read_page / find / text formatting and payloads
out = run("browser_read_page", {"tab_id": 5, "filter": "all", "ref": "ref_3", "profile": "p"})
assert 'button "Go" [ref=1]' in out and "url: https://x.test/" in out, out
assert sent[-1][:2] == ("readPage", {"tabId": 5, "filter": "all", "maxChars": 30000, "ref": "ref_3"}), sent[-1]
assert 'button "Go"' in run("browser_find", {"tab_id": 5, "query": "go"})
assert "hello" in run("browser_get_page_text", {"tab_id": 5})
assert run("browser_read_page", {"tab_id": "5"}).startswith("Error: tab_id")
assert run("browser_find", {"tab_id": 5}).startswith("Error: query")
print("PASS read_page/find/page_text")

# wait_for: needs a condition; IPC timeout outlives the wait
assert run("browser_wait_for", {"tab_id": 5}).startswith("Error: give at least one")
out = run("browser_wait_for", {"tab_id": 5, "selector": "#a", "timeout_ms": 90000})
action, payload, timeout = sent[-1]
assert payload["timeoutMs"] == 60000 and timeout > 60, (payload, timeout)
assert json.loads(out)["ok"]
print("PASS wait_for")

# upload: absolute existing files only; base64 for the fallback only under 700KB total
with tempfile.TemporaryDirectory() as d:
    small = os.path.join(d, "s.txt")
    big = os.path.join(d, "b.bin")
    with open(small, "w") as f:
        f.write("hi")
    with open(big, "wb") as f:
        f.write(b"\0" * (page.UPLOAD_FALLBACK_MAX + 1))
    assert run("browser_upload", {"tab_id": 5, "paths": ["rel.txt"], "ref": 1}).startswith("Error: path must be absolute")
    assert run("browser_upload", {"tab_id": 5, "paths": [os.path.join(d, "nope")], "ref": 1}).startswith("Error: not a file")
    assert run("browser_upload", {"tab_id": 5, "paths": [small]}).startswith("Error: give ref or selector")
    assert run("browser_upload", {"tab_id": 5, "paths": []}).startswith("Error: paths")
    run("browser_upload", {"tab_id": 5, "paths": [small], "ref": 7})
    p = sent[-1][1]
    assert p["paths"] == [small] and p["files"][0]["name"] == "s.txt" and p["files"][0]["type"] == "text/plain", p
    run("browser_upload", {"tab_id": 5, "paths": [small, big], "selector": "#f"})
    assert "files" not in sent[-1][1], "over the cap: no base64 payload"
    home_rel = "~/" + os.path.relpath(small, os.path.expanduser("~")) if small.startswith(os.path.expanduser("~")) else None
    if home_rel:
        run("browser_upload", {"tab_id": 5, "paths": [home_rel], "ref": 1})
        assert sent[-1][1]["paths"] == [small]
print("PASS upload validation")

# Shared error helpers
assert ext_error({"error": "boom"}) == "Error: boom" and ext_error([1]) is None and ext_error({"ok": True}, dict) is None
assert ext_error("oops", dict) == "Error: unexpected result: oops"
assert ext_result({"error": "boom"})[0].text == "Error: boom" and ext_result([1])[0].text == "[\n  1\n]"
assert tab_id_error({"tab_id": 5}) is None and tab_id_error({"tab_id": "5"}) == "Error: tab_id (integer) is required"
print("PASS error helpers")
print("ALL PASS")
