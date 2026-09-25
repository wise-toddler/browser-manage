#!/opt/homebrew/bin/python3.13
"""Native messaging host for Tab Manager extension."""

import json
import struct
import sys
import os
import time
import fcntl
import traceback
import atexit

# Default IPC files (backward compatible)
DEFAULT_CMD_FILE = "/tmp/tab-manager-cmd.json"
DEFAULT_RESULT_FILE = "/tmp/tab-manager-result.json"
LOG_FILE = "/tmp/tab-manager-host.log"
REGISTRY_FILE = "/tmp/tab-manager-registry.json"

# Dynamic per-profile IPC paths (set after identify message)
cmd_file = DEFAULT_CMD_FILE
result_file = DEFAULT_RESULT_FILE
identity = None

def log(msg):
    """Log message to file."""
    with open(LOG_FILE, 'a') as f:
        f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")

def set_nonblocking(fd):
    """Set file descriptor to non-blocking mode."""
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

# Bytes read from the extension but not yet a complete frame; large messages (screenshots)
# arrive across many reads, and dropping a partial read would desync the whole stream
_inbuf = bytearray()

def read_message_nonblocking():
    """Return the next complete message from stdin, or None if one hasn't fully arrived yet."""
    try:
        chunk = os.read(sys.stdin.fileno(), 1 << 20)
        # b'' on a non-blocking fd is EOF: extension port closed, don't linger as an orphan
        if chunk == b'':
            log("Extension port closed (EOF), exiting")
            sys.exit(0)
        _inbuf.extend(chunk)
    except BlockingIOError:
        pass
    if len(_inbuf) < 4:
        return None
    length = struct.unpack('=I', _inbuf[:4])[0]
    if len(_inbuf) < 4 + length:
        return None
    message = bytes(_inbuf[4:4 + length])
    del _inbuf[:4 + length]
    try:
        return json.loads(message.decode('utf-8'))
    except Exception:
        log("Dropped undecodable message")
        return None

def send_message(message):
    """Send a message to stdout (native messaging protocol); exit if the port is dead."""
    encoded = json.dumps(message).encode('utf-8')
    try:
        sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    except BrokenPipeError:
        log("Extension port broken (EPIPE), exiting")
        sys.exit(0)

def write_result(result):
    """Write result for MCP server to read."""
    output = {'timestamp': time.time(), 'data': result}
    with open(result_file, 'w') as f:
        json.dump(output, f)

def set_ipc_paths(browser, profile):
    """Set IPC file paths based on browser and profile identity."""
    global cmd_file, result_file, identity
    safe_profile = ''.join(c if c.isalnum() else '-' for c in profile)[:32]
    cmd_file = f"/tmp/tab-manager-{browser}-{safe_profile}-cmd.json"
    result_file = f"/tmp/tab-manager-{browser}-{safe_profile}-result.json"
    identity = {"browser": browser, "profile": safe_profile}
    log(f"Identity set: {browser}/{safe_profile}")
    update_registry(browser, safe_profile)

def _edit_registry(fn):
    """Read-modify-write the registry under an exclusive lock (one host per profile runs concurrently)."""
    with open(REGISTRY_FILE + '.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        registry = {}
        try:
            with open(REGISTRY_FILE, 'r') as f:
                registry = json.load(f)
        except Exception:
            pass
        fn(registry)
        with open(REGISTRY_FILE, 'w') as f:
            json.dump(registry, f)

def update_registry(browser, profile):
    """Register this profile in the shared registry."""
    _edit_registry(lambda r: r.__setitem__(f"{browser}-{profile}", {
        "browser": browser,
        "profile": profile,
        "cmd_file": cmd_file,
        "result_file": result_file,
        "pid": os.getpid(),
        "last_seen": time.time()
    }))

def remove_from_registry():
    """Remove this profile from the registry on exit."""
    if not identity:
        return
    try:
        _edit_registry(lambda r: r.pop(f"{identity['browser']}-{identity['profile']}", None))
    except Exception:
        pass

atexit.register(remove_from_registry)

def check_and_send_command():
    """Check for pending command and send to extension."""
    if not os.path.exists(cmd_file):
        return False
    try:
        with open(cmd_file, 'r') as f:
            cmd = json.load(f)
        if time.time() - cmd.get('timestamp', 0) < 30:
            os.remove(cmd_file)
            send_message({
                'id': int(cmd.get('timestamp', 0) * 1000),
                'action': cmd.get('action'),
                'payload': cmd.get('payload', {})
            })
            return True
        else:
            os.remove(cmd_file)  # Remove stale command
    except Exception:
        pass
    return False

def main():
    """Main loop with non-blocking I/O."""
    log("=== Host started ===")
    last_heartbeat = time.time()
    try:
        # Set stdin to non-blocking
        set_nonblocking(sys.stdin.buffer.fileno())
        log("Set stdin to non-blocking")

        while True:
            # Check for commands from MCP server
            if check_and_send_command():
                log("Sent command to extension")

            # Try to read response from extension (non-blocking)
            message = read_message_nonblocking()
            if message:
                log(f"Received message: {json.dumps(message)[:100]}")
                # Handle identity message from extension
                if message.get('action') == 'identify':
                    payload = message.get('payload', {})
                    set_ipc_paths(payload.get('browser', 'unknown'), payload.get('profile', 'default'))
                elif message.get('id') == 'ping':
                    # Pong: only a real round-trip proves the extension is alive
                    update_registry(identity['browser'], identity['profile'])
                elif 'result' in message:
                    write_result(message['result'])
                    log("Wrote result file")

            # Ping extension every 30s; registry last_seen updates only on pong
            now = time.time()
            if identity and now - last_heartbeat > 30:
                send_message({'id': 'ping', 'action': 'ping', 'payload': {}})
                last_heartbeat = now

            # Small sleep to avoid busy loop
            time.sleep(0.05)

    except Exception as e:
        log(f"CRASH: {e}")
        log(traceback.format_exc())
        raise

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log(f"TOP LEVEL CRASH: {e}")
        log(traceback.format_exc())
