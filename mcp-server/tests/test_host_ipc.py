"""Host + IPC tests against a fake extension; never touches live hosts. Run: cd mcp-server && uv run python3 tests/test_host_ipc.py"""

import asyncio
import base64
import json
import os
import random
import statistics
import struct
import subprocess
import sys
import tempfile
import threading
import time

TMP = tempfile.mkdtemp(prefix="tm-ipc-")
# Must be set before ipc/tools import: they read it once
os.environ["TAB_MANAGER_DIR"] = TMP
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.dirname(HERE)
HOST = os.path.join(os.path.dirname(SERVER_DIR), "native-host", "host.py")
sys.path.insert(0, SERVER_DIR)

import ipc  # noqa: E402
import server  # noqa: E402

PROFILE = "edge-testprof"
TINY_JPEG = base64.b64encode(b"\xff\xd8\xff\xd9").decode()


def fake_result(action, payload):
    """Plausible extension answers so every tool handler can run end to end."""
    return {
        "echo": payload,
        "big": "x" * 3_000_000,
        "getTabs": [{"id": 1, "url": "https://example.com/", "title": "Example", "groupId": -1}],
        "getDecisionLog": {"data": []},
        "getDomainStats": {"data": {}},
        "getTabTracking": {"data": {}},
        "getTabsWithMemory": {"tabs": [], "total_memory_mb": 0},
        "openTabs": {"opened": 1, "tabIds": [1]},
        "screenshot": {"data": TINY_JPEG, "format": "jpeg", "fullPage": False},
        "action": {"ok": True, "url": "https://example.com/"},
        "triageTabs": {"triaged": 1},
        "reloadExtension": {"reloading": True},
    }.get(action, {"ok": True})


class FakeExtension:
    """Drives host.py over its stdin/stdout like the browser does."""

    def __init__(self):
        self.proc = subprocess.Popen([sys.executable, HOST, "chrome-extension://test/"], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, env={**os.environ, "TAB_MANAGER_DIR": TMP})
        self.lock = threading.Lock()
        self.send({"action": "identify", "payload": {"browser": "edge", "profile": "testprof"}})
        threading.Thread(target=self.loop, daemon=True).start()

    def send(self, msg):
        data = json.dumps(msg).encode()
        with self.lock:
            self.proc.stdin.write(struct.pack("=I", len(data)) + data)
            self.proc.stdin.flush()

    def read_frame(self):
        head = self.proc.stdout.read(4)
        if len(head) < 4:
            return None
        return json.loads(self.proc.stdout.read(struct.unpack("=I", head)[0]))

    def loop(self):
        while (msg := self.read_frame()) is not None:
            threading.Thread(target=self.answer, args=(msg,), daemon=True).start()

    def answer(self, msg):
        if msg.get("action") == "ping":
            return self.send({"id": "ping", "result": "pong"})
        # Out-of-order replies prove routing is by id, not arrival order
        if msg.get("action") == "echo":
            time.sleep(random.uniform(0, 0.05))
        self.send({"id": msg["id"], "result": fake_result(msg.get("action"), msg.get("payload"))})


def wait_for(cond, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def entry():
    return ipc.resolve_profile(PROFILE)


def main():
    ext = FakeExtension()
    assert wait_for(lambda: entry() and entry().get("sock") and os.path.exists(entry()["sock"])), "host never registered a socket"
    sock = entry()["sock"]
    assert oct(os.stat(sock).st_mode & 0o777) == "0o600", oct(os.stat(sock).st_mode & 0o777)
    print("PASS socket registered with 0600:", sock)

    r = ipc.send_extension_command("echo", {"hello": "world"}, profile=PROFILE)
    assert r == {"hello": "world"}, r
    print("PASS socket round trip")

    results = {}
    def worker(i):
        results[i] = ipc.send_extension_command("echo", {"n": i}, profile=PROFILE)
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert all(results[i] == {"n": i} for i in range(20)), results
    print("PASS 20 concurrent clients each got their own reply")

    big = ipc.send_extension_command("big", {}, timeout=30, profile=PROFILE)
    assert isinstance(big, str) and len(big) == 3_000_000
    print("PASS 3MB response")

    def bench(fn, n=30):
        ts = []
        for i in range(n):
            t0 = time.perf_counter(); fn(i); ts.append((time.perf_counter() - t0) * 1000)
        return statistics.median(ts)
    sock_ms = bench(lambda i: ipc.send_extension_command("fast", {"i": i}, profile=PROFILE))
    no_sock = {**entry(), "sock": None}
    file_ms = bench(lambda i: ipc.send_to_entry(no_sock, "fast", {"i": i}))
    print(f"PASS latency median: socket {sock_ms:.1f}ms, file fallback {file_ms:.1f}ms (old file poll ~200ms)")

    assert ipc.send_to_entry(no_sock, "echo", {"f": 1}) == {"f": 1}
    dead_sock = {**entry(), "sock": os.path.join(TMP, "missing.sock")}
    assert ipc.send_to_entry(dead_sock, "echo", {"f": 2}) == {"f": 2}
    print("PASS file-IPC fallback (no sock, and sock path missing)")

    names = [t.name for t in asyncio.run(server.list_tools())]
    assert len(names) == 28, len(names)
    shot = os.path.join(TMP, "shot.jpg")
    args = {
        "browser_create_group": {"name": "G", "tab_ids": [1]}, "browser_suspend_tabs": {"tab_ids": [1]},
        "browser_unsuspend_tabs": {"tab_ids": [1]}, "browser_suspend_whitelist": {"action": "list"},
        "browser_search_all_tabs": {"query": "example"}, "browser_smart_cleanup": {"check_prs": False},
        "browser_close_by_ids": {"tab_ids": [1]}, "browser_open_tabs": {"urls": ["https://example.com/"], "group": "G"},
        "browser_run_script": {"tab_id": 1, "code": "1"}, "browser_screenshot": {"tab_id": 1, "path": shot},
        "browser_action": {"tab_id": 1, "action": "scroll", "screenshot": False},
        "browser_triage_tabs": {"tab_ids": [1]}, "browser_restore_from_triage": {"tab_ids": [1]},
    }
    for n in names:
        out = asyncio.run(server.call_tool(n, {"profile": PROFILE, **args.get(n, {})}))
        assert isinstance(out, list) and out, (n, out)
        bad = [c.text for c in out if getattr(c, "text", "").startswith(("Error", "Unknown tool", "Screenshot error"))]
        assert not bad, (n, bad)
    print(f"PASS all {len(names)} tools dispatch through the registry")

    ext.proc.stdin.close()
    assert ext.proc.wait(timeout=5) == 0, ext.proc.returncode
    assert not os.path.exists(sock), "socket left behind"
    assert entry() is None, "registry entry left behind"
    print("PASS EOF exits host, removes socket and registry entry")


if __name__ == "__main__":
    main()
