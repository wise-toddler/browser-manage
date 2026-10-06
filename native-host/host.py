#!/opt/homebrew/bin/python3.13
"""Native messaging host for Tab Manager extension."""

import json
import struct
import sys
import os
import time
import fcntl
import socket
import selectors
import traceback
import atexit

# All paths live under one dir; TAB_MANAGER_DIR is only overridden by tests so they never touch the live hosts
BASE_DIR = os.environ.get("TAB_MANAGER_DIR", "/tmp")
# Default IPC files (backward compatible)
DEFAULT_CMD_FILE = os.path.join(BASE_DIR, "tab-manager-cmd.json")
DEFAULT_RESULT_FILE = os.path.join(BASE_DIR, "tab-manager-result.json")
LOG_FILE = os.path.join(BASE_DIR, "tab-manager-host.log")
REGISTRY_FILE = os.path.join(BASE_DIR, "tab-manager-registry.json")
PENDING_TTL_S = 120

# Dynamic per-profile IPC paths (set after identify message)
cmd_file = DEFAULT_CMD_FILE
result_file = DEFAULT_RESULT_FILE
sock_path = None
identity = None

sel = selectors.DefaultSelector()
listener = None
# Per socket client: bytes received but not yet a full newline-terminated request
clients = {}
# Extension request id we assigned -> (client socket, the client's own id, sent_at)
pending = {}
_next_id = 0

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

def read_stdin():
    """Pull whatever bytes stdin has into the frame buffer; exit on EOF."""
    try:
        chunk = os.read(sys.stdin.fileno(), 1 << 20)
        # b'' on a non-blocking fd is EOF: extension port closed, don't linger as an orphan
        if chunk == b'':
            log("Extension port closed (EOF), exiting")
            sys.exit(0)
        _inbuf.extend(chunk)
    except BlockingIOError:
        pass

def next_message():
    """Pop the next complete message from the frame buffer, or None if one hasn't fully arrived yet."""
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
        # Not None: the drain loop stops on None and would strand any frames queued behind this one
        return {}

def read_message_nonblocking():
    """Return the next complete message from stdin, or None if one hasn't fully arrived yet."""
    read_stdin()
    return next_message()

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
    """Set IPC file/socket paths based on browser and profile identity."""
    global cmd_file, result_file, identity
    safe_profile = ''.join(c if c.isalnum() else '-' for c in profile)[:32]
    cmd_file = os.path.join(BASE_DIR, f"tab-manager-{browser}-{safe_profile}-cmd.json")
    result_file = os.path.join(BASE_DIR, f"tab-manager-{browser}-{safe_profile}-result.json")
    identity = {"browser": browser, "profile": safe_profile}
    log(f"Identity set: {browser}/{safe_profile}")
    open_listener(os.path.join(BASE_DIR, f"tab-manager-{browser}-{safe_profile}.sock"))
    update_registry(browser, safe_profile)

def open_listener(path):
    """Listen for MCP server clients on a 0600 Unix socket (replaces any stale socket at that path)."""
    global listener, sock_path
    close_listener()
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        s.bind(path)
    finally:
        os.umask(old)
    s.listen(32)
    s.setblocking(False)
    sel.register(s, selectors.EVENT_READ, 'listener')
    listener, sock_path = s, path
    log(f"Listening on {path}")

def close_listener():
    """Stop listening and remove our socket file."""
    global listener, sock_path
    if listener:
        try:
            sel.unregister(listener)
        except Exception:
            pass
        listener.close()
        listener = None
    if sock_path:
        try:
            os.unlink(sock_path)
        except FileNotFoundError:
            pass
        sock_path = None

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
        "sock": sock_path,
        "pid": os.getpid(),
        "last_seen": time.time()
    }))

def remove_from_registry():
    """Remove this profile from the registry on exit."""
    if not identity:
        return
    try:
        # Only remove our own entry: a newer host for the same profile may already have replaced it
        def drop(r):
            key = f"{identity['browser']}-{identity['profile']}"
            if r.get(key, {}).get('pid') == os.getpid():
                r.pop(key, None)
        _edit_registry(drop)
    except Exception:
        pass

def cleanup():
    """Exit hook: socket file and registry entry go away with the process."""
    close_listener()
    remove_from_registry()

atexit.register(cleanup)

def check_and_send_command():
    """Check for pending command and send to extension (file-IPC fallback, kept for one release)."""
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

def accept_client():
    """Accept a waiting MCP server connection."""
    try:
        conn, _ = listener.accept()
    except BlockingIOError:
        return
    conn.setblocking(False)
    sel.register(conn, selectors.EVENT_READ, 'client')
    clients[conn] = bytearray()

def drop_client(conn):
    """Forget a client and any responses still owed to it."""
    try:
        sel.unregister(conn)
    except Exception:
        pass
    conn.close()
    clients.pop(conn, None)
    for rid in [rid for rid, (c, _, _) in pending.items() if c is conn]:
        pending.pop(rid, None)

def read_client(conn):
    """Read newline-delimited requests {id, action, payload} and forward each to the extension."""
    global _next_id
    try:
        chunk = conn.recv(1 << 16)
    except BlockingIOError:
        return
    except OSError:
        chunk = b''
    if not chunk:
        drop_client(conn)
        return
    buf = clients[conn]
    buf.extend(chunk)
    while b'\n' in buf:
        line, _, rest = bytes(buf).partition(b'\n')
        buf[:] = rest
        try:
            req = json.loads(line)
        except Exception:
            reply(conn, None, {'error': 'bad request: not JSON'})
            continue
        # Our own ids: client ids could collide across clients, and file-IPC ids are numeric timestamps
        _next_id += 1
        rid = f"s{os.getpid()}-{_next_id}"
        pending[rid] = (conn, req.get('id'), time.time())
        send_message({'id': rid, 'action': req.get('action'), 'payload': req.get('payload', {})})

def reply(conn, client_id, result):
    """Send one newline-terminated response; a client that can't take it is dropped."""
    data = json.dumps({'id': client_id, 'result': result}).encode('utf-8') + b'\n'
    try:
        conn.setblocking(True)
        conn.settimeout(10)
        conn.sendall(data)
        conn.setblocking(False)
    except OSError:
        drop_client(conn)

def handle_extension_message(message):
    """Route one message from the extension: identify, pong, socket reply, or file-IPC result."""
    log(f"Received message: {json.dumps(message)[:100]}")
    mid = message.get('id')
    if message.get('action') == 'identify':
        payload = message.get('payload', {})
        set_ipc_paths(payload.get('browser', 'unknown'), payload.get('profile', 'default'))
    elif mid == 'ping':
        # Pong: only a real round-trip proves the extension is alive
        if identity:
            update_registry(identity['browser'], identity['profile'])
    elif mid in pending:
        conn, client_id, _ = pending.pop(mid)
        reply(conn, client_id, message.get('result'))
    elif 'result' in message:
        write_result(message['result'])
        log("Wrote result file")

def expire_pending():
    """Drop bookkeeping for requests the extension never answered."""
    now = time.time()
    for rid in [rid for rid, (_, _, t) in pending.items() if now - t > PENDING_TTL_S]:
        pending.pop(rid, None)

def main():
    """Event loop over stdin (extension) and the Unix socket (MCP server); file IPC polled every 20ms."""
    log("=== Host started ===")
    last_heartbeat = time.time()
    try:
        # Set stdin to non-blocking
        set_nonblocking(sys.stdin.buffer.fileno())
        sel.register(sys.stdin.fileno(), selectors.EVENT_READ, 'stdin')
        log("Set stdin to non-blocking")

        while True:
            for key, _ in sel.select(timeout=0.02):
                if key.data == 'stdin':
                    read_stdin()
                    # Drain every complete frame: several replies can arrive in one read
                    while (message := next_message()) is not None:
                        handle_extension_message(message)
                elif key.data == 'listener':
                    accept_client()
                else:
                    read_client(key.fileobj)

            # Check for commands from MCP server (file-IPC fallback)
            if check_and_send_command():
                log("Sent command to extension")

            # Ping extension every 30s; registry last_seen updates only on pong
            now = time.time()
            if identity and now - last_heartbeat > 30:
                send_message({'id': 'ping', 'action': 'ping', 'payload': {}})
                last_heartbeat = now
                expire_pending()

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
