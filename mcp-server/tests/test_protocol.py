"""server.py over stdio with raw JSON-RPC, as mcp-call speaks it; never touches live hosts. Run: cd mcp-server && uv run python3 tests/test_protocol.py"""

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.dirname(HERE)


class Rpc:
    """Line-delimited JSON-RPC to a server.py subprocess."""

    def __init__(self):
        # Empty registry dir: tools that need an extension fail fast instead of finding a live profile
        env = {**os.environ, "TAB_MANAGER_DIR": tempfile.mkdtemp(prefix="tm-proto-")}
        self.proc = subprocess.Popen([sys.executable, os.path.join(SERVER_DIR, "server.py")], cwd=SERVER_DIR, env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.n = 0

    def send(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method, **({"params": params} if params is not None else {})}
        if not notify:
            self.n += 1
            msg["id"] = self.n
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        if notify:
            return None
        while True:
            reply = json.loads(self.proc.stdout.readline())
            if reply.get("id") == self.n:
                return reply

    def call(self, name, arguments):
        return self.send("tools/call", {"name": name, "arguments": arguments})["result"]


def main():
    rpc = Rpc()
    init = rpc.send("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})
    assert init["result"]["protocolVersion"] == "2025-11-25", init
    assert init["result"]["serverInfo"]["name"] == "browser-tabs", init
    rpc.send("notifications/initialized", notify=True)
    print("PASS initialize negotiates 2025-11-25 (mcp-call's version)")

    tools = rpc.send("tools/list")["result"]["tools"]
    assert len(tools) == 40, len(tools)
    assert all("inputSchema" in t for t in tools), "wire format must stay camelCase"
    print("PASS tools/list: 40 tools, camelCase inputSchema on the wire")

    r = rpc.call("browser_list_profiles", {})
    assert not r.get("isError") and r["content"][0]["type"] == "text", r
    r = rpc.call("browser_read_page", {"tab_id": "x"})
    assert r.get("isError") and r["content"][0]["text"].startswith("Input validation error"), r
    r = rpc.call("browser_nope", {})
    assert r["content"][0]["text"] == "Unknown tool: browser_nope", r
    print("PASS tools/call: result content, schema validation as isError, unknown tool")

    rpc.proc.stdin.close()
    assert rpc.proc.wait(timeout=10) == 0, rpc.proc.returncode
    print("PASS clean exit on stdin EOF")


if __name__ == "__main__":
    main()
