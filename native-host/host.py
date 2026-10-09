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

def log(msg):
    """Log message to file."""
    with open(LOG_FILE, 'a') as f:
        f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")

def set_nonblocking(fd):
    """Set file descriptor to non-blocking mode."""
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

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

class Host:
    """One host process: extension stdin framing, MCP socket clients, file-IPC fallback and registry entry."""

    def __init__(self):
        """Start with default IPC paths and no listener until the extension identifies itself."""
        # Dynamic per-profile IPC paths (set after identify message)
        self.cmd_file = DEFAULT_CMD_FILE
        self.result_file = DEFAULT_RESULT_FILE
        self.sock_path = None
        self.identity = None

        self.sel = selectors.DefaultSelector()
        self.listener = None
        # Per socket client: bytes received but not yet a full newline-terminated request
        self.clients = {}
        # Extension request id we assigned -> (client socket, the client's own id, sent_at)
        self.pending = {}
        self._next_id = 0

        # Bytes read from the extension but not yet a complete frame; large messages (screenshots)
        # arrive across many reads, and dropping a partial read would desync the whole stream
        self._inbuf = bytearray()

    def read_stdin(self):
        """Pull whatever bytes stdin has into the frame buffer; exit on EOF."""
        try:
            chunk = os.read(sys.stdin.fileno(), 1 << 20)
            # b'' on a non-blocking fd is EOF: extension port closed, don't linger as an orphan
            if chunk == b'':
                log("Extension port closed (EOF), exiting")
                sys.exit(0)
            self._inbuf.extend(chunk)
        except BlockingIOError:
            pass

    def next_message(self):
        """Pop the next complete message from the frame buffer, or None if one hasn't fully arrived yet."""
        if len(self._inbuf) < 4:
            return None
        length = struct.unpack('=I', self._inbuf[:4])[0]
        if len(self._inbuf) < 4 + length:
            return None
        message = bytes(self._inbuf[4:4 + length])
        del self._inbuf[:4 + length]
        try:
            return json.loads(message.decode('utf-8'))
        except Exception:
            log("Dropped undecodable message")
            # Not None: the drain loop stops on None and would strand any frames queued behind this one
            return {}

    def read_message_nonblocking(self):
        """Return the next complete message from stdin, or None if one hasn't fully arrived yet."""
        self.read_stdin()
        return self.next_message()

    def write_result(self, result):
        """Write result for MCP server to read."""
        output = {'timestamp': time.time(), 'data': result}
        with open(self.result_file, 'w') as f:
            json.dump(output, f)

    def set_ipc_paths(self, browser, profile):
        """Set IPC file/socket paths based on browser and profile identity."""
        safe_profile = ''.join(c if c.isalnum() else '-' for c in profile)[:32]
        self.cmd_file = os.path.join(BASE_DIR, f"tab-manager-{browser}-{safe_profile}-cmd.json")
        self.result_file = os.path.join(BASE_DIR, f"tab-manager-{browser}-{safe_profile}-result.json")
        self.identity = {"browser": browser, "profile": safe_profile}
        log(f"Identity set: {browser}/{safe_profile}")
        self.open_listener(os.path.join(BASE_DIR, f"tab-manager-{browser}-{safe_profile}.sock"))
        self.update_registry(browser, safe_profile)

    def open_listener(self, path):
        """Listen for MCP server clients on a 0600 Unix socket (replaces any stale socket at that path)."""
        self.close_listener()
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
        self.sel.register(s, selectors.EVENT_READ, 'listener')
        self.listener, self.sock_path = s, path
        log(f"Listening on {path}")

    def close_listener(self):
        """Stop listening and remove our socket file."""
        if self.listener:
            try:
                self.sel.unregister(self.listener)
            except Exception:
                pass
            self.listener.close()
            self.listener = None
        if self.sock_path:
            try:
                os.unlink(self.sock_path)
            except FileNotFoundError:
                pass
            self.sock_path = None

    def update_registry(self, browser, profile):
        """Register this profile in the shared registry."""
        _edit_registry(lambda r: r.__setitem__(f"{browser}-{profile}", {
            "browser": browser,
            "profile": profile,
            "cmd_file": self.cmd_file,
            "result_file": self.result_file,
            "sock": self.sock_path,
            "pid": os.getpid(),
            "last_seen": time.time()
        }))

    def remove_from_registry(self):
        """Remove this profile from the registry on exit."""
        if not self.identity:
            return
        try:
            # Only remove our own entry: a newer host for the same profile may already have replaced it
            def drop(r):
                key = f"{self.identity['browser']}-{self.identity['profile']}"
                if r.get(key, {}).get('pid') == os.getpid():
                    r.pop(key, None)
            _edit_registry(drop)
        except Exception:
            pass

    def cleanup(self):
        """Exit hook: socket file and registry entry go away with the process."""
        self.close_listener()
        self.remove_from_registry()

    def check_and_send_command(self):
        """Check for pending command and send to extension (file-IPC fallback, kept for one release)."""
        if not os.path.exists(self.cmd_file):
            return False
        try:
            with open(self.cmd_file, 'r') as f:
                cmd = json.load(f)
            if time.time() - cmd.get('timestamp', 0) < 30:
                os.remove(self.cmd_file)
                send_message({
                    'id': int(cmd.get('timestamp', 0) * 1000),
                    'action': cmd.get('action'),
                    'payload': cmd.get('payload', {})
                })
                return True
            else:
                os.remove(self.cmd_file)  # Remove stale command
        except Exception:
            pass
        return False

    def accept_client(self):
        """Accept a waiting MCP server connection."""
        try:
            conn, _ = self.listener.accept()
        except BlockingIOError:
            return
        conn.setblocking(False)
        self.sel.register(conn, selectors.EVENT_READ, 'client')
        self.clients[conn] = bytearray()

    def drop_client(self, conn):
        """Forget a client and any responses still owed to it."""
        try:
            self.sel.unregister(conn)
        except Exception:
            pass
        conn.close()
        self.clients.pop(conn, None)
        for rid in [rid for rid, (c, _, _) in self.pending.items() if c is conn]:
            self.pending.pop(rid, None)

    def read_client(self, conn):
        """Read newline-delimited requests {id, action, payload} and forward each to the extension."""
        try:
            chunk = conn.recv(1 << 16)
        except BlockingIOError:
            return
        except OSError:
            chunk = b''
        if not chunk:
            self.drop_client(conn)
            return
        buf = self.clients[conn]
        buf.extend(chunk)
        while b'\n' in buf:
            line, _, rest = bytes(buf).partition(b'\n')
            buf[:] = rest
            try:
                req = json.loads(line)
            except Exception:
                self.reply(conn, None, {'error': 'bad request: not JSON'})
                continue
            # Our own ids: client ids could collide across clients, and file-IPC ids are numeric timestamps
            self._next_id += 1
            rid = f"s{os.getpid()}-{self._next_id}"
            self.pending[rid] = (conn, req.get('id'), time.time())
            send_message({'id': rid, 'action': req.get('action'), 'payload': req.get('payload', {})})

    def reply(self, conn, client_id, result):
        """Send one newline-terminated response; a client that can't take it is dropped."""
        data = json.dumps({'id': client_id, 'result': result}).encode('utf-8') + b'\n'
        try:
            conn.setblocking(True)
            conn.settimeout(10)
            conn.sendall(data)
            conn.setblocking(False)
        except OSError:
            self.drop_client(conn)

    def handle_extension_message(self, message):
        """Route one message from the extension: identify, pong, socket reply, or file-IPC result."""
        log(f"Received message: {json.dumps(message)[:100]}")
        mid = message.get('id')
        if message.get('action') == 'identify':
            payload = message.get('payload', {})
            self.set_ipc_paths(payload.get('browser', 'unknown'), payload.get('profile', 'default'))
        elif mid == 'ping':
            # Pong: only a real round-trip proves the extension is alive
            if self.identity:
                self.update_registry(self.identity['browser'], self.identity['profile'])
        elif mid in self.pending:
            conn, client_id, _ = self.pending.pop(mid)
            self.reply(conn, client_id, message.get('result'))
        elif 'result' in message:
            self.write_result(message['result'])
            log("Wrote result file")

    def expire_pending(self):
        """Drop bookkeeping for requests the extension never answered."""
        now = time.time()
        for rid in [rid for rid, (_, _, t) in self.pending.items() if now - t > PENDING_TTL_S]:
            self.pending.pop(rid, None)

    def run(self):
        """Event loop over stdin (extension) and the Unix socket (MCP server); file IPC polled every 20ms."""
        last_heartbeat = time.time()
        # Set stdin to non-blocking
        set_nonblocking(sys.stdin.buffer.fileno())
        self.sel.register(sys.stdin.fileno(), selectors.EVENT_READ, 'stdin')
        log("Set stdin to non-blocking")

        while True:
            for key, _ in self.sel.select(timeout=0.02):
                if key.data == 'stdin':
                    self.read_stdin()
                    # Drain every complete frame: several replies can arrive in one read
                    while (message := self.next_message()) is not None:
                        self.handle_extension_message(message)
                elif key.data == 'listener':
                    self.accept_client()
                else:
                    self.read_client(key.fileobj)

            # Check for commands from MCP server (file-IPC fallback)
            if self.check_and_send_command():
                log("Sent command to extension")

            # Ping extension every 30s; registry last_seen updates only on pong
            now = time.time()
            if self.identity and now - last_heartbeat > 30:
                send_message({'id': 'ping', 'action': 'ping', 'payload': {}})
                last_heartbeat = now
                self.expire_pending()

def main():
    """Create the one Host, tie its cleanup to process exit, and run its event loop."""
    log("=== Host started ===")
    host = Host()
    atexit.register(host.cleanup)
    try:
        host.run()
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
