"""Transport to the extension: per-profile Unix socket to the native host, file IPC as fallback."""

import json
import os
import socket
import time
import uuid

# TAB_MANAGER_DIR is only overridden by tests so they never touch the live hosts
BASE_DIR = os.environ.get("TAB_MANAGER_DIR", "/tmp")
CMD_FILE = os.path.join(BASE_DIR, "tab-manager-cmd.json")
RESULT_FILE = os.path.join(BASE_DIR, "tab-manager-result.json")
REGISTRY_FILE = os.path.join(BASE_DIR, "tab-manager-registry.json")
FILE_POLL_S = 0.02
TIMEOUT_ERROR = "timeout waiting for extension"


def get_active_profiles() -> list:
    """Read the registry of active browser+profile connections."""
    if not os.path.exists(REGISTRY_FILE):
        return []
    try:
        with open(REGISTRY_FILE, 'r') as f:
            registry = json.load(f)
        now = time.time()
        return [v for v in registry.values() if now - v.get('last_seen', 0) < 300]
    except Exception:
        return []


def resolve_profile(profile: str):
    """Registry entry whose 'browser-profile' key contains `profile`, or None."""
    for p in get_active_profiles():
        if profile in f"{p['browser']}-{p['profile']}":
            return p
    return None


def send_to_entry(entry: dict, action: str, payload: dict, timeout: int = 10) -> dict:
    """Send to one registry entry: socket when the host offers one, else file IPC."""
    sock = entry.get('sock')
    if sock:
        try:
            return _send_to_socket(sock, action, payload, timeout)
        except (FileNotFoundError, ConnectionRefusedError):
            pass  # host predates sockets or just died: fall back
    return _send_to_ipc(action, payload, entry['cmd_file'], entry['result_file'], timeout)


def send_extension_command(action: str, payload: dict, timeout: int = 10, profile: str = None) -> dict:
    """Send a command to the extension of `profile` (or the legacy default IPC files) and return its result."""
    if not profile:
        return _send_to_ipc(action, payload, CMD_FILE, RESULT_FILE, timeout)
    match = resolve_profile(profile)
    if not match:
        active = [f"{p['browser']}-{p['profile']}" for p in get_active_profiles()]
        return {"error": f"Profile '{profile}' not found. Active: {active}"}
    result = send_to_entry(match, action, payload, timeout)
    if isinstance(result, dict) and result.get('error') == TIMEOUT_ERROR:
        age = time.time() - match.get('last_seen', 0)
        result['error'] = f"extension unresponsive (last pong {age:.0f}s ago, host pid {match.get('pid')})"
    return result


def _send_to_socket(path: str, action: str, payload: dict, timeout: int) -> dict:
    """One request/response over the host's Unix socket (newline-delimited JSON)."""
    rid = uuid.uuid4().hex
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        s.connect(path)
        s.sendall(json.dumps({"id": rid, "action": action, "payload": payload}).encode('utf-8') + b'\n')
        buf = bytearray()
        try:
            while b'\n' not in buf:
                chunk = s.recv(1 << 20)
                if not chunk:
                    return {"error": "native host closed the connection"}
                buf.extend(chunk)
        except socket.timeout:
            return {"error": TIMEOUT_ERROR}
    resp = json.loads(bytes(buf).split(b'\n', 1)[0])
    return resp.get('result')


def _send_to_ipc(action: str, payload: dict, cmd_path: str, result_path: str, timeout: int) -> dict:
    """Send command via specific IPC file pair."""
    cmd = {"action": action, "payload": payload, "timestamp": time.time()}
    with open(cmd_path, 'w') as f:
        json.dump(cmd, f)
    start = time.time()
    while time.time() - start < timeout:
        if os.path.exists(result_path):
            try:
                with open(result_path, 'r') as f:
                    result = json.load(f)
                if result.get('timestamp', 0) > cmd['timestamp']:
                    os.remove(result_path)
                    return result.get('data', result)
            except Exception:
                pass
        time.sleep(FILE_POLL_S)
    return {"error": TIMEOUT_ERROR}
