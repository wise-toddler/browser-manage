"""Batch, recording and debug-output tests with the extension mocked. Run: uv run python3 tests/test_p2_tools.py"""

import asyncio
import base64
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image  # noqa: E402

import tools.capture as capture  # noqa: E402
import tools.actions as actions  # noqa: E402
import tools.debug as debug  # noqa: E402
import tools.batch  # noqa: E402,F401
import tools.record as record  # noqa: E402
from tools import dispatch  # noqa: E402

SHOT_W, SHOT_H, DPR = 1600, 1000, 2
CALLS = []


def fake_jpeg(color):
    """A solid-colour JPEG screenshot as base64."""
    buf = io.BytesIO()
    Image.new("RGB", (SHOT_W, SHOT_H), color).save(buf, "JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode()


SHOTS = iter([fake_jpeg(c) for c in [(200, 200, 200), (180, 220, 180), (180, 180, 220), (90, 90, 90), (50, 50, 50)] * 10])
CONSOLE = {"total": 3, "matched": 2, "dropped": 0, "messages": [
    {"ts": 1700000000123, "level": "error", "source": "console", "text": "boom", "url": "https://t/app.js", "line": 10},
    {"ts": 1700000001000, "level": "error", "source": "exception", "text": "TypeError: x"}]}
NETWORK = {"total": 2, "matched": 1, "dropped": 0, "note": "Capture started just now", "requests": [
    {"requestId": "r1", "method": "GET", "url": "https://t/api", "type": "Fetch", "status": 500, "size": 2048, "durationMs": 120}]}


def fake_send(action, payload, timeout=10, profile=None):
    """Stand-in for the extension."""
    CALLS.append((action, payload, profile))
    if action == "screenshot":
        if payload["tabId"] == 404:
            return {"error": "No tab with id: 404"}
        return {"data": next(SHOTS), "format": "jpeg", "fullPage": False, "dpr": DPR}
    if action == "action":
        if payload.get("action") == "click":
            return {"ok": True, "url": "https://t/", "at": {"x": 100, "y": 50}}
        return {"ok": True, "url": "https://t/"}
    if action == "readConsole":
        return CONSOLE
    if action == "readNetwork":
        if payload.get("requestId"):
            return {"requestId": "r1", "url": "https://t/api", "status": 500, "mime": "application/json", "length": 13, "body": '{"err":"bad"}'}
        return NETWORK
    if action == "debugCapture":
        return {"error": "Console/network capture needs the debugger, which this tab refuses"} if payload["tabId"] == 13 else {"capturing": True, "started": True}
    return {"error": f"unexpected {action}"}


for mod in (capture, actions, debug):
    mod.send_extension_command = fake_send

run = lambda name, args: asyncio.run(dispatch(name, args))
texts = lambda out: [c.text for c in out if getattr(c, "type", "") == "text"]
images = lambda out: [c for c in out if getattr(c, "type", "") == "image"]


def test_batch():
    CALLS.clear()
    out = run("browser_batch", {"profile": "edge-aaa", "actions": [
        {"tool": "browser_screenshot", "args": {"tab_id": 1}},
        {"tool": "browser_action", "args": {"tab_id": 1, "action": "click", "selector": "#go", "profile": "edge-other"}},
        {"tool": "browser_screenshot", "args": {"tab_id": 404}},
        {"tool": "browser_screenshot", "args": {"tab_id": 1}},
    ]})
    t = texts(out)
    assert t[0] == "[0] browser_screenshot" and len(images(out)) == 2, t
    assert [c[2] for c in CALLS] == ["edge-aaa", "edge-other", "edge-other", "edge-aaa"], CALLS  # injected unless set
    assert "[2] browser_screenshot FAILED" in t and t[-1].startswith("Stopped at step 2; 1 step(s) not run"), t
    assert len(CALLS) == 4  # step 3 never ran

    out = run("browser_batch", {"stop_on_error": False, "actions": [
        {"tool": "browser_screenshot", "args": {"tab_id": 404}}, {"tool": "browser_batch", "args": {}},
        {"tool": "nope"}, {"tool": "browser_screenshot", "args": {"tab_id": 1}}]})
    t = texts(out)
    assert "[1] browser_batch FAILED" in t and "Error: browser_batch cannot be nested" in t
    assert "[2] nope FAILED" in t and "[3] browser_screenshot" in t and len(images(out)) == 1, t

    assert texts(run("browser_batch", {"actions": []}))[0].startswith("Error")
    assert texts(run("browser_batch", {"actions": [{"tool": "browser_screenshot", "args": {"tab_id": 1}}] * 51}))[0].startswith("Error: at most 50")
    print("PASS batch: order, profile injection, stop/continue on error, nesting + unknown refused, limits")


def test_record():
    out = run("browser_record", {"tab_id": 7, "action": "export"})
    assert texts(out)[0].startswith("Error: tab 7 isn't being recorded")
    out = run("browser_record", {"tab_id": 7, "action": "start", "profile": "edge-aaa"})
    assert texts(out)[0].startswith("Recording tab 7: 1 frame") and len(images(out)) == 1
    run("browser_action", {"tab_id": 7, "action": "click", "selector": "#go", "profile": "edge-aaa"})
    run("browser_action", {"tab_id": 7, "action": "type", "text": "hello", "profile": "edge-aaa"})
    run("browser_action", {"tab_id": 7, "action": "key", "key": "Enter", "profile": "edge-aaa", "screenshot": False})  # no frame
    run("browser_screenshot", {"tab_id": 7, "profile": "edge-zzz"})  # another profile's tab 7: not this recording
    run("browser_screenshot", {"tab_id": 8, "profile": "edge-aaa"})  # another tab
    rec = record.RECORDINGS[7]
    assert [f["label"] for f in rec["frames"]] == ["start", "click #go", "type 'hello'"], rec["frames"]
    assert rec["frames"][1]["at"] == {"x": 100, "y": 50} and rec["frames"][1]["dpr"] == DPR
    assert "recording, 3 frame(s)" in texts(run("browser_record", {"tab_id": 7, "action": "status"}))[0]

    run("browser_record", {"tab_id": 7, "action": "stop"})
    run("browser_screenshot", {"tab_id": 7, "profile": "edge-aaa"})
    assert len(rec["frames"]) == 3  # stopped: no new frames

    path = "/tmp/tab-manager-p2-test.gif"
    out = texts(run("browser_record", {"tab_id": 7, "action": "export", "path": path}))[0]
    assert out.startswith(f"Saved {path}: 3 frames"), out
    gif = Image.open(path)
    assert gif.n_frames == 3 and gif.width == 960 and gif.height == 600 + record.BAR_H, (gif.n_frames, gif.size)
    assert [gif.seek(i) or gif.info["duration"] for i in range(3)] == [800, 800, 2000]
    # Click marker: (100, 50) CSS px × dpr 2 × (960 / 1600) = (120, 60), drawn as a red ring of radius 14
    gif.seek(1)
    ring = gif.convert("RGB").getpixel((120 + 14, 60))
    assert ring[0] > 200 and ring[1] < 100 and ring[2] < 100, ring
    gif.seek(0)
    plain = gif.convert("RGB").getpixel((120 + 14, 60))
    assert abs(plain[0] - plain[1]) < 30, plain  # no marker on the start frame (grey, not red)
    frames_dir = rec["dir"]
    run("browser_record", {"tab_id": 7, "action": "start", "profile": "edge-aaa"})  # restart discards old frames
    assert not os.path.exists(frames_dir) and len(record.RECORDINGS[7]["frames"]) == 1
    os.remove(path)
    record._discard(7)
    print(f"PASS record: frames from start/action screenshots only (right tab+profile, not after stop), labels, GIF 3 frames 960px, red click ring at (120,60), durations 800/800/2000")


def test_debug_output():
    t = texts(run("browser_read_console", {"tab_id": 1}))[0]
    assert t.splitlines()[0] == "2 of 3 console messages", t
    assert "error   boom  (https://t/app.js:10)" in t and "[exception] TypeError: x" in t, t
    t = texts(run("browser_read_network", {"tab_id": 1, "only_failed": True}))[0]
    assert "Note: Capture started just now" in t and "r1  GET    500" in t and "2.0KB" in t and "120ms" in t, t
    t = texts(run("browser_read_network", {"tab_id": 1, "request_id": "r1"}))[0]
    assert t.startswith("500 application/json https://t/api (13 chars)") and t.endswith('{"err":"bad"}'), t
    assert texts(run("browser_debug", {"tab_id": 13, "action": "start"}))[0].startswith("Error: Console/network capture needs the debugger")
    assert json.loads(texts(run("browser_debug", {"tab_id": 1, "action": "start", "reload": True}))[0]) == {"capturing": True, "started": True}
    sent = [c for c in CALLS if c[0] == "debugCapture"][-1][1]
    assert sent == {"tabId": 1, "mode": "start", "reload": True, "durationMs": 0}, sent
    print("PASS debug tools: console/network formatting, body view, blocked-tab error, start payload")


test_batch()
test_record()
test_debug_output()
