"""Google Sheets cell writes in a tab (background works, no focus change), verified by reading every cell back."""

import asyncio
import csv
import io
import json
import re

from ipc import send_extension_command
from tools import tool, schema, text, ext_error, tab_id_error

CELL_RE = re.compile(r"^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}$")
SHEET_RE = re.compile(r"/spreadsheets/d/([A-Za-z0-9_-]+)")
GID_RE = re.compile(r"[#&?]gid=([0-9]+)")
SAVE_WAIT_S = 1.5


def _act(tab_id: int, profile: str, **p):
    """One type step in the tab; its error or warning text, else None."""
    r = send_extension_command("action", {"tabId": tab_id, "wait": 200, **p}, timeout=60, profile=profile)
    return ext_error(r, dict) or r.get("warning")


def _first_cell(csv_text: str) -> str:
    """The single value in a one-cell gviz CSV answer ('' for an empty cell)."""
    rows = list(csv.reader(io.StringIO(csv_text or "")))
    return rows[0][0] if rows and rows[0] else ""


def _read(tab_id: int, profile: str, sheet_id: str, gid: str, refs: list):
    """Current values of refs via the gviz CSV endpoint, fetched inside the tab so it uses the user's session."""
    gid_q = f"&gid={gid}" if gid else ""
    code = (f"const out = {{}}; for (const ref of {json.dumps(refs)}) {{ const r = await fetch('/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv{gid_q}"
            f"&range=' + encodeURIComponent(ref) + '&t=' + Date.now(), {{cache: 'no-store'}}); out[ref] = await r.text(); }} return out;")
    r = send_extension_command("runScript", {"tabId": tab_id, "code": code, "timeoutMs": 30000}, timeout=45, profile=profile)
    if (err := ext_error(r, dict)) or not isinstance(r.get("result"), dict):
        return err or f"Error: read-back failed: {r}"
    return {ref: _first_cell(v) for ref, v in r["result"].items()}


def _landed(expected: str, got: str) -> bool:
    """Whether a read-back value is what was written (formulas: any non-error result; numbers compared as numbers)."""
    if expected.startswith("="):
        return got != "" and not got.startswith("#")
    # A leading ' only tells Sheets to keep the rest as text; it isn't stored
    if expected.startswith("'"):
        return got == expected[1:]
    if got == expected:
        return True
    try:
        return float(got.replace(",", "")) == float(expected.replace(",", ""))
    except ValueError:
        return False


@tool("browser_sheets_write", "Write values into Google Sheets cells of the sheet open in a tab (a background tab works; no focus change), then read every cell back via gviz and report per cell whether it landed. Cells that didn't land are retried once. ok is true only when every read-back matches. Values starting with = are formulas (landed = a non-error result); start a value with ' to store it as literal text.", schema({
    "tab_id": {"type": "integer"},
    "cells": {"type": "object", "description": "Cell ref -> value on the sheet tab currently shown, e.g. {\"F25\": \"Asked infra\", \"H25\": \"done\"}; one line per value", "additionalProperties": {"type": "string"}},
}, ["tab_id", "cells"]))
async def browser_sheets_write(args):
    if (err := tab_id_error(args)):
        return [text(err)]
    tab_id, profile, cells = args["tab_id"], args.get("profile"), args.get("cells") or {}
    if not isinstance(cells, dict) or not cells:
        return [text("Error: cells must be a non-empty object of cell ref -> value")]
    bad = [k for k, v in cells.items() if not CELL_RE.match(str(k)) or not isinstance(v, str) or "\n" in v]
    if bad:
        return [text(f"Error: bad cells {bad}: refs like F25, values single-line strings")]
    tabs = send_extension_command("getTabs", {}, profile=profile)
    if (err := ext_error(tabs, list)):
        return [text(err)]
    url = next((t.get("url", "") for t in tabs if t.get("id") == tab_id), "")
    m = SHEET_RE.search(url)
    if "docs.google.com" not in url or not m:
        return [text(f"Error: tab {tab_id} isn't a Google Sheet ({url[:80]})")]
    gid = (GID_RE.search(url) or [None, None])[1]

    pending, got, notes = list(cells), {}, {}
    for _ in range(2):
        for ref in pending:
            for step in ({"selector": "#t-name-box", "clear": True, "text": f"{ref}\n"},
                         {"selector": "#waffle-rich-text-editor", "text": f"{cells[ref]}\n"}):
                if (note := _act(tab_id, profile, action="type", **step)):
                    notes[ref] = note
        await asyncio.sleep(SAVE_WAIT_S)
        read = _read(tab_id, profile, m[1], gid, pending)
        if isinstance(read, str):
            return [text(read)]
        got.update(read)
        pending = [ref for ref in pending if not _landed(cells[ref], got.get(ref, ""))]
        if not pending:
            break
    report = {ref: {"value": cells[ref], "read_back": got.get(ref, ""), "landed": ref not in pending,
                    **({"note": notes[ref]} if ref in notes and ref in pending else {})} for ref in cells}
    summary = f"{len(cells) - len(pending)}/{len(cells)} cells landed" + (f"; NOT landed: {pending}" if pending else "")
    return [text(summary), text(json.dumps({"ok": not pending, "cells": report}))]
