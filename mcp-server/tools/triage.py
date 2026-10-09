"""Triage window tools: park disposable tabs in a minimized window, list and restore them."""

import json

from ipc import send_extension_command
from tools import tool, schema, text, as_json, ext_error, TAB_IDS
from tools.learning import learning_data, predict_tabs


@tool("browser_triage_tabs", "Move tabs to triage window (suspend + move). User reviews them later to keep or close.", schema({
    "tab_ids": {**TAB_IDS, "description": "Tab IDs to triage"},
}, ["tab_ids"]))
async def triage_tabs(args):
    return as_json(send_extension_command("triageTabs", {"tabIds": args.get("tab_ids", [])}, profile=args.get("profile")))


@tool("browser_restore_from_triage", "Move tabs back from triage window to main window. Focuses that window, so it needs allow_focus=true.", schema({
    "tab_ids": {**TAB_IDS, "description": "Tab IDs to restore"},
    "allow_focus": {"type": "boolean", "description": "Permit stealing the user's window focus; refused by the extension otherwise", "default": False},
}, ["tab_ids"]))
async def restore_from_triage(args):
    payload = {"tabIds": args.get("tab_ids", []), "allowFocus": args.get("allow_focus", False)}
    return as_json(send_extension_command("restoreFromTriage", payload, profile=args.get("profile")))


@tool("browser_list_triage", "List all tabs in the triage window.", schema())
async def list_triage(args):
    return as_json(send_extension_command("listTriageTabs", {}, profile=args.get("profile")))


@tool("browser_triage_disposable", "Auto-triage: move all tabs with dispose probability above threshold to triage window.", schema({
    "threshold": {"type": "number", "description": "Dispose probability threshold (0-1). Default 0.8", "default": 0.8},
}))
async def triage_disposable(args):
    profile, threshold = args.get("profile"), args.get("threshold", 0.8)
    tabs = send_extension_command("getTabs", {}, profile=profile)
    if (err := ext_error(tabs)):
        return [text(err)]
    # Find ungrouped tabs above threshold
    to_triage = [
        {'id': t['id'], 'title': t.get('title', '')[:60], 'probability': p['probability']}
        for t, _, p in predict_tabs(tabs, *learning_data(profile))
        if p.get('probability') is not None and p['probability'] >= threshold and t.get('groupId', -1) == -1
    ]
    if not to_triage:
        return [text(json.dumps({"triaged": 0, "message": f"No ungrouped tabs above {threshold:.0%} threshold"}))]
    result = send_extension_command("triageTabs", {"tabIds": [t['id'] for t in to_triage]}, profile=profile)
    result['tabs'] = to_triage
    return as_json(result)
