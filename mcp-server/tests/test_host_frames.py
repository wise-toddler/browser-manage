"""Host frame reassembly from split stdin chunks, in-process. Run: cd mcp-server && uv run python3 tests/test_host_frames.py"""

import json
import os
import struct
import sys
import tempfile

# Must be set before host import: it reads it once, so the log lands here and never in the live /tmp
os.environ["TAB_MANAGER_DIR"] = tempfile.mkdtemp(prefix="tm-frames-")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "native-host"))

import host  # noqa: E402


def frame(obj):
    """One native messaging frame: native-endian length prefix plus JSON."""
    data = json.dumps(obj).encode()
    return struct.pack("=I", len(data)) + data


def main():
    big = {"id": "s1-1", "result": "x" * 20_000}
    want = [big, {"id": "ping", "result": "pong"}, {}, {"id": 2}]
    # The third frame is not JSON: it must come back as {} without stranding the frame queued behind it
    stream = frame(big) + frame(want[1]) + struct.pack("=I", 3) + b"{x}" + frame(want[3])
    for size in (1, 7, 4096, len(stream)):
        h = host.Host()
        got = []
        # Drain after every chunk like the event loop does; size 1 splits every length header
        for i in range(0, len(stream), size):
            h._inbuf.extend(stream[i:i + size])
            while (m := h.next_message()) is not None:
                got.append(m)
        assert got == want, (size, [str(m)[:40] for m in got])
        assert not h._inbuf, (size, len(h._inbuf))
    print("PASS frames reassemble across split reads (1, 7, 4096 bytes, all at once), bad JSON skipped")


if __name__ == "__main__":
    main()
