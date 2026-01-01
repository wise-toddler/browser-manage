#!/opt/homebrew/bin/python3.13
"""Native messaging host for Tab Manager extension."""

import json
import struct
import sys
import os
import time
import fcntl
import traceback

CMD_FILE = "/tmp/tab-manager-cmd.json"
RESULT_FILE = "/tmp/tab-manager-result.json"
LOG_FILE = "/tmp/tab-manager-host.log"

def log(msg):
    """Log message to file."""
    with open(LOG_FILE, 'a') as f:
        f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")

def set_nonblocking(fd):
    """Set file descriptor to non-blocking mode."""
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

def read_message_nonblocking():
    """Try to read a message from stdin, return None if no data available."""
    try:
        raw_length = sys.stdin.buffer.read(4)
        if not raw_length:
            return None
        if len(raw_length) < 4:
            return None
        length = struct.unpack('=I', raw_length)[0]
        message = sys.stdin.buffer.read(length)
        if len(message) < length:
            return None
        return json.loads(message.decode('utf-8'))
    except BlockingIOError:
        return None
    except Exception:
        return None

def send_message(message):
    """Send a message to stdout (native messaging protocol)."""
    encoded = json.dumps(message).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

def write_result(result):
    """Write result for MCP server to read."""
    output = {'timestamp': time.time(), 'data': result}
    with open(RESULT_FILE, 'w') as f:
        json.dump(output, f)

def check_and_send_command():
    """Check for pending command and send to extension."""
    if not os.path.exists(CMD_FILE):
        return False
    try:
        with open(CMD_FILE, 'r') as f:
            cmd = json.load(f)
        if time.time() - cmd.get('timestamp', 0) < 30:
            os.remove(CMD_FILE)
            send_message({
                'id': int(cmd.get('timestamp', 0) * 1000),
                'action': cmd.get('action'),
                'payload': cmd.get('payload', {})
            })
            return True
        else:
            os.remove(CMD_FILE)  # Remove stale command
    except Exception:
        pass
    return False

def main():
    """Main loop with non-blocking I/O."""
    log("=== Host started ===")
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
                if 'result' in message:
                    write_result(message['result'])
                    log("Wrote result file")

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
