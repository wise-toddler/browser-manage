"""Record a tab as a storyboard GIF: while recording, every screenshot of that tab becomes a frame.

Frames come from screenshots (explicit ones and the auto-screenshot after browser_action), not a
continuous screencast: hidden tabs never produce frames, and focus-stealing to get them is off-limits.
"""

import base64
import os
import shutil
import tempfile
import time

from PIL import Image, ImageDraw, ImageFont

from tools import tool, schema, text
from tools import capture

MAX_FRAMES = 300
MAX_WIDTH = 960
FRAME_MS = 800
LAST_FRAME_MS = 2000
BAR_H = 28
# tab_id -> {profile, active, started, dir, frames: [{file, label, at, dpr, full}], capped}
RECORDINGS = {}


def _same_profile(a, b) -> bool:
    """Profile args are substrings of the registry key; treat unset or overlapping ones as the same."""
    return not a or not b or a in b or b in a


def on_capture(tab_id, profile, result, label, at):
    """capture.screenshot listener: append the frame to an active recording of this tab."""
    rec = RECORDINGS.get(tab_id)
    if not rec or not rec["active"] or not _same_profile(rec["profile"], profile):
        return
    if len(rec["frames"]) >= MAX_FRAMES:
        rec["capped"] = True
        return
    ext = "png" if result.get("format") == "png" else "jpg"
    path = os.path.join(rec["dir"], f"{len(rec['frames']):04d}.{ext}")
    with open(path, "wb") as f:
        f.write(base64.b64decode(result["data"]))
    rec["frames"].append({"file": path, "label": label or "screenshot", "at": at, "dpr": result.get("dpr"), "full": bool(result.get("fullPage"))})


capture.FRAME_LISTENERS.append(on_capture)


def _render(frame, width, height, index, total, font):
    """One GIF frame: screenshot fitted into width×height, click marker, label bar."""
    im = Image.open(frame["file"]).convert("RGB")
    scale = min(width / im.width, height / im.height, 1.0)
    if scale < 1.0:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    draw = ImageDraw.Draw(im)
    # `at` is in CSS px of the viewport; screenshots are device px, so it needs dpr. Full-page frames start at the
    # page top, not the viewport, so the point can't be placed there.
    at, dpr = frame.get("at"), frame.get("dpr")
    if at and dpr and not frame["full"] and at.get("x") is not None:
        x, y, r = at["x"] * dpr * scale, at["y"] * dpr * scale, 14
        draw.ellipse([x - r, y - r, x + r, y + r], outline=(255, 40, 40), width=4)
        draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(255, 40, 40))
    canvas = Image.new("RGB", (width, height + BAR_H), (17, 17, 17))
    canvas.paste(im, ((width - im.width) // 2, 0))
    ImageDraw.Draw(canvas).text((8, height + 6), f"{index + 1}/{total}  {frame['label']}"[:110], fill=(255, 255, 255), font=font)
    return canvas.quantize(colors=256, method=Image.Quantize.FASTOCTREE)


def export_gif(rec: dict, path: str, fps: float = None) -> dict:
    """Write the recording's frames as an animated GIF; returns path, frames, size and duration."""
    frames = rec["frames"]
    first = Image.open(frames[0]["file"])
    width = min(MAX_WIDTH, first.width)
    height = round(first.height * width / first.width)
    font = ImageFont.load_default(size=15)
    images = [_render(f, width, height, i, len(frames), font) for i, f in enumerate(frames)]
    per = round(1000 / fps) if fps else FRAME_MS
    durations = [per] * (len(images) - 1) + [LAST_FRAME_MS]
    images[0].save(path, save_all=True, append_images=images[1:], duration=durations, loop=0, optimize=True)
    return {"path": path, "frames": len(images), "kb": os.path.getsize(path) // 1024, "seconds": sum(durations) / 1000}


def _discard(tab_id):
    """Forget a recording and delete its frame files."""
    rec = RECORDINGS.pop(tab_id, None)
    if rec:
        shutil.rmtree(rec["dir"], ignore_errors=True)


@tool("browser_record", "Record what happens in a tab as a GIF storyboard. start grabs a first frame; after that every screenshot of the tab (including the automatic one after each browser_action) becomes a labelled frame, with a red circle where clicks landed. stop pauses, export writes the GIF (≤960px wide, ~0.8s per frame), status reports frame count. No video: frames only appear when screenshots are taken.", schema({
    "tab_id": {"type": "integer"},
    "action": {"type": "string", "enum": ["start", "stop", "export", "status"]},
    "path": {"type": "string", "description": "export: output .gif path; default /tmp/tab-manager-rec-<tab_id>-<ts>.gif"},
    "fps": {"type": "number", "description": "export: frames per second (default 1.25, i.e. 0.8s per frame)"},
}, ["tab_id", "action"]))
async def browser_record(args):
    tab_id, profile, action = args.get("tab_id"), args.get("profile"), args.get("action")
    if not isinstance(tab_id, int):
        return [text("Error: tab_id (integer) is required")]
    if action == "start":
        _discard(tab_id)
        RECORDINGS[tab_id] = {"profile": profile, "active": True, "started": time.time(), "frames": [], "capped": False,
                              "dir": tempfile.mkdtemp(prefix=f"tab-manager-rec-{tab_id}-", dir="/tmp")}
        shot = capture.screenshot(tab_id, profile, label="start")
        return [text(f"Recording tab {tab_id}: {len(RECORDINGS[tab_id]['frames'])} frame(s); every screenshot of it now adds a frame")] + shot
    rec = RECORDINGS.get(tab_id)
    if not rec:
        return [text(f"Error: tab {tab_id} isn't being recorded; use action=start")]
    if action == "stop":
        rec["active"] = False
        return [text(f"Stopped recording tab {tab_id}: {len(rec['frames'])} frame(s) kept; export to write the GIF")]
    if action == "status":
        return [text(f"Tab {tab_id}: {'recording' if rec['active'] else 'stopped'}, {len(rec['frames'])} frame(s)"
                     f"{f', capped at {MAX_FRAMES}' if rec['capped'] else ''}, started {time.strftime('%H:%M:%S', time.localtime(rec['started']))}")]
    if action == "export":
        if not rec["frames"]:
            return [text("Error: no frames recorded yet")]
        path = args.get("path") or f"/tmp/tab-manager-rec-{tab_id}-{int(time.time())}.gif"
        r = export_gif(rec, path, args.get("fps"))
        return [text(f"Saved {r['path']}: {r['frames']} frames, {r['kb']} KB, {r['seconds']:.1f}s")]
    return [text(f"Error: unknown action {action!r}")]
