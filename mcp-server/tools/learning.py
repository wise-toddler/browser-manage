"""Cleanup categorization and the learning loop: decision log, domain stats, dispose predictions."""

from analysis import categorize_tabs, extract_features_server_side, predict_dispose_probability
from ipc import send_extension_command
from tools import tool, schema, text, as_json, ext_result, unwrap


def learning_data(profile):
    """Decision log, domain stats and tab tracking for a profile, unwrapped from the extension's {data: ...}."""
    return (
        unwrap(send_extension_command("getDecisionLog", {}, profile=profile), list),
        unwrap(send_extension_command("getDomainStats", {}, profile=profile), dict),
        unwrap(send_extension_command("getTabTracking", {}, profile=profile), dict),
    )


def predict_tabs(tabs, decision_log, domain_stats, tab_tracking):
    """Yield (tab, features, prediction) for each tab."""
    for t in tabs:
        tracking = tab_tracking.get(str(t.get('id')), {})
        features = extract_features_server_side(t, tracking, tab_tracking)
        yield t, features, predict_dispose_probability(features, decision_log, domain_stats)


@tool("browser_smart_cleanup", "Auto-categorize tabs: checks GitHub PR merge status, finds duplicates, sign-in pages, search results, one-time tabs. Returns categorized report with tab IDs ready for closing.", schema({
    "check_prs": {"type": "boolean", "description": "Check GitHub PR statuses via gh CLI (slower but accurate)", "default": True},
}))
async def smart_cleanup(args):
    profile = args.get("profile")
    tabs = send_extension_command("getTabs", {}, profile=profile)
    if isinstance(tabs, dict) and "error" in tabs:
        return [text(f"Error: {tabs['error']}")]
    decision_log, domain_stats, tab_tracking = learning_data(profile)
    cats = categorize_tabs(tabs, check_prs=args.get("check_prs", True))
    # Build summary with IDs for easy closing
    safe_to_close = []
    report = {"total": len(tabs)}
    for cat in ['merged_prs', 'closed_prs', 'signin_pages', 'new_tabs', 'search_results', 'one_time', 'duplicates']:
        items = cats[cat]
        if items:
            report[cat] = [{"id": t["id"], "title": t.get("title", "")[:60], "url": t.get("url", "")[:80]} for t in items]
            safe_to_close.extend([t["id"] for t in items])
    report["safe_to_close_ids"] = safe_to_close
    report["safe_to_close_count"] = len(safe_to_close)
    # Info sections
    for cat in ['open_prs', 'suspended', 'grouped', 'keep']:
        if cats[cat]:
            report[f"{cat}_count"] = len(cats[cat])
    # Add predictions for kept tabs
    if decision_log:
        predictions = [
            {'id': t['id'], 'title': t.get('title', '')[:60], 'domain': f.get('domain', ''),
             'dispose_probability': p['probability'], 'confidence': p['confidence']}
            for t, f, p in predict_tabs(cats.get('keep', []), decision_log, domain_stats, tab_tracking)
            if p.get('probability') is not None
        ]
        if predictions:
            predictions.sort(key=lambda x: x['dispose_probability'], reverse=True)
            report['predicted_disposable'] = [p for p in predictions if p['dispose_probability'] > 0.6]
            report['prediction_stats'] = {
                'total_decisions': len(decision_log),
                'confidence': 'cold_start' if len(decision_log) < 30 else ('low' if len(decision_log) < 100 else 'high'),
            }
    return as_json(report)


@tool("browser_get_decision_log", "Get raw decision log (last 500 tab close/keep decisions with features).", schema())
async def get_decision_log(args):
    return ext_result(send_extension_command("getDecisionLog", {}, profile=args.get("profile")))


@tool("browser_get_domain_stats", "Get per-domain aggregates: close rate, avg lifespan, avg activations.", schema())
async def get_domain_stats(args):
    return ext_result(send_extension_command("getDomainStats", {}, profile=args.get("profile")))


@tool("browser_record_cleanup", "Record cleanup results for learning. Call AFTER closing tabs to train the model.", schema({
    "kept": {"type": "array", "description": "Tabs that survived: [{tabId, domain}]", "items": {"type": "object"}},
    "closed": {"type": "array", "description": "Tabs that were closed: [{tabId, domain}]", "items": {"type": "object"}},
}))
async def record_cleanup(args):
    payload = {"kept": args.get("kept", []), "closed": args.get("closed", [])}
    return ext_result(send_extension_command("recordCleanupResult", payload, profile=args.get("profile")))


@tool("browser_get_predictions", "Get dispose probability for all current tabs. Shows which tabs the model predicts you'll close.", schema())
async def get_predictions(args):
    profile = args.get("profile")
    tabs = send_extension_command("getTabs", {}, profile=profile)
    if isinstance(tabs, dict) and "error" in tabs:
        return [text(f"Error: {tabs['error']}")]
    predictions = [
        {'id': t['id'], 'title': t.get('title', '')[:60], 'domain': f.get('domain', ''),
         'dispose_probability': p.get('probability'), 'confidence': p.get('confidence'),
         'total_decisions': p.get('total_decisions'), 'top_features': p.get('top_features')}
        for t, f, p in predict_tabs(tabs, *learning_data(profile))
    ]
    predictions.sort(key=lambda x: x.get('dispose_probability') or 0, reverse=True)
    return as_json(predictions)
