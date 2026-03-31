#!/usr/bin/env python3
"""CLI for browser-manage data inspection and actions."""

import sys
import json
import asyncio
import time
import server


PROFILES = {
    'work': 'edge-3982a3d4',
    'personal': 'edge-e3b7c502',
    'chrome': 'chrome-75cec1fc',
}


def resolve_profile(name=None):
    """Resolve profile alias to ID."""
    if not name:
        name = 'work'
    return PROFILES.get(name, name)


async def call(tool, args=None):
    """Call an MCP tool and return parsed JSON."""
    result = await server.call_tool(tool, args or {})
    data = json.loads(result[0].text)
    if isinstance(data, dict) and 'data' in data:
        return data['data']
    return data


def cmd_status(profile):
    """Show data collection status."""
    log = asyncio.run(call('browser_get_decision_log', {'profile': profile}))
    stats = asyncio.run(call('browser_get_domain_stats', {'profile': profile}))

    closed = [d for d in log if d.get('outcome') == 'closed']
    kept = [d for d in log if d.get('outcome') == 'kept']
    manual = [d for d in closed if d.get('source') == 'manual']
    ext = [d for d in closed if d.get('source') == 'extension']

    print(f'Decisions: {len(log)}/500 (closed={len(closed)} kept={len(kept)})')
    print(f'Sources:   manual={len(manual)} extension={len(ext)} cleanup={len(kept)}')
    print(f'Domains:   {len(stats)} tracked')

    readiness = len(log)
    if readiness < 30:
        print(f'\nPredictions: COLD START ({30 - readiness} more decisions needed)')
    elif readiness < 100:
        pct = (readiness - 30) / 70 * 100
        print(f'\nPredictions: BLEND MODE ({pct:.0f}% data-driven)')
    else:
        print(f'\nPredictions: PURE DATA MODE')

    if not kept:
        print('\nWARNING: 0 "kept" decisions — classifier needs both closed AND kept.')
        print('Run: bm seed-kept <profile> to record kept tabs from current session.')


def cmd_domains(profile):
    """Show per-domain behavior report."""
    stats = asyncio.run(call('browser_get_domain_stats', {'profile': profile}))
    if not stats:
        print('No domain stats yet.')
        return

    print(f'{"Domain":<50} {"Close":>5} {"Keep":>5} {"Alive":>5} {"CloseRate":>9} {"AvgLife":>8} {"AvgAct":>7}')
    print('-' * 95)

    for dom, s in sorted(stats.items(), key=lambda x: -(x[1].get('totalClosed', 0) + x[1].get('totalKept', 0))):
        total = s.get('totalClosed', 0) + s.get('totalKept', 0)
        if total == 0 and s.get('totalOpened', 0) < 10:
            continue
        close_rate = s.get('totalClosed', 0) / total * 100 if total > 0 else 0
        life = s.get('avgLifespanMinutes', 0)
        life_str = f'{life:.0f}m' if life < 1440 else f'{life/1440:.1f}d'
        print(f'{dom:<50} {s.get("totalClosed",0):>5} {s.get("totalKept",0):>5} {s.get("totalOpened",0):>5} {close_rate:>8.0f}% {life_str:>8} {s.get("avgActivations",0):>6.1f}')


def cmd_predictions(profile):
    """Show dispose predictions for current tabs."""
    preds = asyncio.run(call('browser_get_predictions', {'profile': profile}))
    if not preds:
        print('No predictions available.')
        return

    has_probs = any(p.get('dispose_probability') is not None for p in preds)
    if not has_probs:
        cold = preds[0].get('confidence', '') if preds else ''
        total = preds[0].get('total_decisions', 0) if preds else 0
        print(f'Predictions not ready: {cold} (total_decisions={total})')
        print('Need both "closed" and "kept" decisions to compute centroids.')
        return

    print(f'{"Prob":>5} {"Confidence":>10} {"Domain":<40} {"Title":<45}')
    print('-' * 105)
    for p in preds:
        prob = p.get('dispose_probability')
        if prob is None:
            continue
        conf = p.get('confidence', '?')
        emoji = 'X' if prob > 0.7 else '~' if prob > 0.4 else '.'
        print(f'{prob:>4.0%} {emoji} {conf:>10} {p.get("domain",""):<40} {p.get("title","")[:45]}')


def cmd_seed_kept(profile):
    """Record current open tabs as 'kept' to seed the classifier."""
    tabs = asyncio.run(call('browser_get_tabs_ext', {'profile': profile}))
    kept_items = []
    for t in tabs:
        url = t.get('url', '')
        # Skip internal pages
        if url.startswith('chrome://') or url.startswith('edge://') or 'suspended' in url:
            continue
        if 'chrome-extension://' in url or 'extension://' in url:
            continue
        domain = ''
        try:
            from urllib.parse import urlparse
            domain = urlparse(url).hostname or ''
            domain = domain.replace('www.', '')
        except Exception:
            pass
        kept_items.append({'tabId': t['id'], 'domain': domain})

    result = asyncio.run(call('browser_record_cleanup', {
        'profile': profile,
        'kept': kept_items,
        'closed': [],
    }))
    print(f'Recorded {len(kept_items)} tabs as "kept"')
    print(json.dumps(result, indent=2))


def cmd_log(profile, n=20):
    """Show recent decision log entries."""
    log = asyncio.run(call('browser_get_decision_log', {'profile': profile}))
    entries = log[-n:]
    print(f'{"Time":>8} {"Outcome":>8} {"Source":>10} {"Domain":<40} {"Age":>6} {"Idle":>6} {"Act":>4} {"Focus":>8}')
    print('-' * 100)
    now = time.time() * 1000
    for d in reversed(entries):
        ts = d.get('timestamp', 0)
        ago = (now - ts) / 60000
        ago_str = f'{ago:.0f}m' if ago < 1440 else f'{ago/1440:.1f}d'
        f = d.get('features', {})
        focus_ms = f.get('totalFocusMs', 0)
        focus_str = f'{focus_ms/1000:.0f}s' if focus_ms < 60000 else f'{focus_ms/60000:.1f}m'
        print(f'{ago_str:>8} {d.get("outcome",""):>8} {d.get("source",""):>10} {d.get("domain",""):<40} {f.get("ageMinutes",0):>5.0f}m {f.get("idleMinutes",0):>5.0f}m {f.get("activationCount",0):>4} {focus_str:>8}')


def cmd_insights(profile):
    """Show behavioral insights from collected data."""
    log = asyncio.run(call('browser_get_decision_log', {'profile': profile}))
    stats = asyncio.run(call('browser_get_domain_stats', {'profile': profile}))

    if len(log) < 10:
        print(f'Not enough data ({len(log)} decisions). Need at least 10.')
        return

    closed = [d for d in log if d.get('outcome') == 'closed']
    kept = [d for d in log if d.get('outcome') == 'kept']

    # Avg features of closed tabs
    if closed:
        print('=== CLOSED TAB PROFILE ===')
        features = ['ageMinutes', 'idleMinutes', 'activationCount', 'totalFocusMs', 'sessionCount', 'avgGapMinutes']
        for feat in features:
            vals = [d.get('features', {}).get(feat, 0) for d in closed]
            avg = sum(vals) / len(vals)
            mn, mx = min(vals), max(vals)
            unit = 'ms' if 'Ms' in feat else 'm' if 'Minutes' in feat else ''
            print(f'  {feat:<25} avg={avg:>10.1f}{unit}  min={mn:>10.1f}  max={mx:>10.1f}')

    if kept:
        print('\n=== KEPT TAB PROFILE ===')
        for feat in features:
            vals = [d.get('features', {}).get(feat, 0) for d in kept]
            avg = sum(vals) / len(vals)
            mn, mx = min(vals), max(vals)
            unit = 'ms' if 'Ms' in feat else 'm' if 'Minutes' in feat else ''
            print(f'  {feat:<25} avg={avg:>10.1f}{unit}  min={mn:>10.1f}  max={mx:>10.1f}')

    # Most disposable domains (high close rate + volume)
    print('\n=== DISPOSABLE DOMAINS (close-only, 3+ closes) ===')
    for dom, s in sorted(stats.items(), key=lambda x: -x[1].get('totalClosed', 0)):
        if s.get('totalClosed', 0) >= 3 and s.get('totalKept', 0) == 0:
            print(f'  {dom:<50} closed={s["totalClosed"]:>3}  avgLife={s.get("avgLifespanMinutes",0):>6.0f}m')

    # Stickiest domains (high survived, low close)
    print('\n=== STICKY DOMAINS (high survived, low close) ===')
    for dom, s in sorted(stats.items(), key=lambda x: -x[1].get('totalOpened', 0)):
        opened = s.get('totalOpened', 0)
        closed_n = s.get('totalClosed', 0)
        if opened >= 50 and closed_n <= 2:
            print(f'  {dom:<50} survived={opened:>4}  closed={closed_n:>2}')

    # One-shot domains (1 close, 0 keep, low activations)
    oneshots = [(d, s) for d, s in stats.items() if s.get('totalClosed', 0) == 1 and s.get('totalKept', 0) == 0 and s.get('avgActivations', 0) <= 1.5]
    if oneshots:
        print(f'\n=== ONE-SHOT DOMAINS ({len(oneshots)} domains, opened once then closed) ===')
        for dom, s in oneshots[:10]:
            print(f'  {dom}')


def cmd_tabs(profile):
    """Show current tabs with tracking data."""
    tabs = asyncio.run(call('browser_get_tabs_ext', {'profile': profile}))
    tracking = asyncio.run(call('browser_get_domain_stats', {'profile': profile}))

    now = time.time() * 1000
    print(f'{"Group":<12} {"Temp":>6} {"Title":<40} {"Domain":<35}')
    print('-' * 97)
    for t in tabs:
        gid = t.get('groupId', -1)
        group = f'grp-{gid}' if gid != -1 else 'ungrouped'
        url = t.get('url', '')
        title = t.get('title', '')[:38]
        domain = ''
        try:
            from urllib.parse import urlparse
            domain = (urlparse(url).hostname or '').replace('www.', '')[:33]
        except Exception:
            pass
        # Can't get per-tab tracking from this tool, just show domain
        print(f'{group:<12} {"":>6} {title:<40} {domain:<35}')


COMMANDS = {
    'status': ('Show data collection status', cmd_status),
    'domains': ('Per-domain behavior report', cmd_domains),
    'predictions': ('Dispose predictions for current tabs', cmd_predictions),
    'seed-kept': ('Record current open tabs as kept', cmd_seed_kept),
    'log': ('Recent decision log entries', cmd_log),
    'insights': ('Behavioral insights from data', cmd_insights),
    'tabs': ('Current tabs overview', cmd_tabs),
}


def main():
    """Entry point."""
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help', 'help'):
        print('Usage: bm <command> [profile]')
        print(f'Profiles: {", ".join(f"{k}={v}" for k, v in PROFILES.items())}')
        print('\nCommands:')
        for name, (desc, _) in COMMANDS.items():
            print(f'  {name:<15} {desc}')
        return

    cmd = args[0]
    profile = resolve_profile(args[1] if len(args) > 1 else None)

    if cmd not in COMMANDS:
        print(f'Unknown command: {cmd}')
        print(f'Available: {", ".join(COMMANDS.keys())}')
        sys.exit(1)

    _, fn = COMMANDS[cmd]
    fn(profile)


if __name__ == '__main__':
    main()
