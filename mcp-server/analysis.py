"""Pure tab analysis: cleanup categories, PR status, and the nearest-centroid dispose classifier."""

import math
import re
import subprocess
import time
from urllib.parse import urlparse, unquote


# --- Personalized cleanup patterns ---
# Tabs matching these are always safe to suggest closing
STALE_PATTERNS = [
    'accounts.google.com',     # sign-in redirects
    'edge://newtab', 'chrome://newtab', 'about:blank',  # new tabs
    '/oauth/', '/signin/', '/callback',  # auth flows
    'google.com/search', 'bing.com/search',  # search results
]

# One-time tabs: usually opened, used once, forgotten
ONE_TIME_PATTERNS = [
    'slack.com/files',         # slack file downloads
    'mail.google.com',         # email opened in browser
]

# Domains to never suggest closing
KEEP_DOMAINS = [
    'notion.so',               # docs/TRDs — ask first
    'console.cloud.google.com',  # GCP — ask first
]


def check_pr_status(url: str) -> str:
    """Check if a GitHub PR is merged/closed/open via gh CLI."""
    match = re.search(r'github\.com/([^/]+/[^/]+)/pull/(\d+)', url)
    if not match:
        return 'unknown'
    repo, number = match.group(1), match.group(2)
    try:
        result = subprocess.run(
            ['gh', 'pr', 'view', f'https://github.com/{repo}/pull/{number}',
             '--json', 'state', '-q', '.state'],
            capture_output=True, text=True, timeout=10
        )
        return result.stdout.strip().lower() or 'unknown'
    except Exception:
        return 'unknown'


# --- Data-driven prediction (nearest-centroid classifier) ---
NUMERIC_FEATURES = [
    'ageMinutes', 'idleMinutes', 'activationCount', 'avgGapMinutes',
    'maxGapMinutes', 'totalFocusMs', 'avgFocusPerVisit', 'sessionCount',
    'domainTabCount', 'redirectCount', 'domainKeptRate', 'domainAvgLifespan',
    'domainTotalDecisions', 'hasOpener', 'isDuplicate', 'isGrouped',
]


def compute_centroid(decisions: list, feature_keys: list) -> dict:
    """Compute average feature vector from decisions."""
    if not decisions:
        return {k: 0.0 for k in feature_keys}
    centroid = {k: 0.0 for k in feature_keys}
    for d in decisions:
        feats = d.get('features', {})
        for k in feature_keys:
            val = feats.get(k, 0)
            if isinstance(val, bool):
                val = 1 if val else 0
            centroid[k] += float(val) if val else 0.0
    n = len(decisions)
    return {k: centroid[k] / n for k in feature_keys}


def compute_std(decisions: list, feature_keys: list, centroid: dict) -> dict:
    """Compute per-feature standard deviation."""
    if len(decisions) < 2:
        return {k: 1.0 for k in feature_keys}
    variance = {k: 0.0 for k in feature_keys}
    for d in decisions:
        feats = d.get('features', {})
        for k in feature_keys:
            val = feats.get(k, 0)
            if isinstance(val, bool):
                val = 1 if val else 0
            diff = (float(val) if val else 0.0) - centroid[k]
            variance[k] += diff * diff
    n = len(decisions)
    return {k: math.sqrt(variance[k] / n) or 1.0 for k in feature_keys}


def euclidean_distance(vec: dict, centroid: dict, feature_keys: list) -> float:
    """Euclidean distance between feature vector and centroid."""
    total = 0.0
    for k in feature_keys:
        val = vec.get(k, 0)
        if isinstance(val, bool):
            val = 1 if val else 0
        diff = (float(val) if val else 0.0) - centroid.get(k, 0)
        total += diff * diff
    return math.sqrt(total)


def predict_dispose_probability(features: dict, decision_log: list, domain_stats: dict) -> dict:
    """Nearest-centroid classifier for tab dispose probability."""
    # Enrich with domain historical data
    domain = features.get('domain', '')
    ds = domain_stats.get(domain, {})
    total_d = ds.get('totalClosed', 0) + ds.get('totalKept', 0)
    features['domainKeptRate'] = ds.get('totalKept', 0) / max(total_d, 1)
    features['domainAvgLifespan'] = ds.get('avgLifespanMinutes', 0)
    features['domainTotalDecisions'] = total_d
    # Bool to numeric
    for k in ['hasOpener', 'isDuplicate', 'isGrouped']:
        features[k] = 1 if features.get(k) else 0

    closed = [d for d in decision_log if d.get('outcome') == 'closed']
    kept = [d for d in decision_log if d.get('outcome') == 'kept']
    total = len(closed) + len(kept)

    if total < 30:
        return {'probability': None, 'confidence': 'cold_start', 'total_decisions': total}

    closed_centroid = compute_centroid(closed, NUMERIC_FEATURES)
    kept_centroid = compute_centroid(kept, NUMERIC_FEATURES)
    dist_closed = euclidean_distance(features, closed_centroid, NUMERIC_FEATURES)
    dist_kept = euclidean_distance(features, kept_centroid, NUMERIC_FEATURES)
    denom = dist_closed + dist_kept
    probability = dist_kept / denom if denom > 0 else 0.5

    # Feature importance
    overall_centroid = compute_centroid(decision_log, NUMERIC_FEATURES)
    std = compute_std(decision_log, NUMERIC_FEATURES, overall_centroid)
    importance = {}
    for k in NUMERIC_FEATURES:
        diff = abs(kept_centroid.get(k, 0) - closed_centroid.get(k, 0))
        importance[k] = round(diff / std.get(k, 1.0), 2)
    top_features = dict(sorted(importance.items(), key=lambda x: -x[1])[:5])

    return {
        'probability': round(probability, 3),
        'confidence': 'low' if total < 100 else 'high',
        'total_decisions': total,
        'top_features': top_features,
    }


def extract_features_server_side(tab: dict, tracking: dict, all_tracking: dict) -> dict:
    """Extract features from tab + tracking data on server side."""
    now = time.time() * 1000
    created = tracking.get('createdAt', now)
    last_visited = tracking.get('lastVisitedAt', now)
    domain = tracking.get('domain', '')
    # Fallback: extract domain from tab URL if tracking has none
    if not domain:
        tab_url = tab.get('url', '')
        # Resolve suspended tab URLs to original domain
        if 'suspended' in tab_url and ('chrome-extension://' in tab_url or 'extension://' in tab_url):
            frag = tab_url.split('#', 1)[1] if '#' in tab_url else ''
            params = dict(p.split('=', 1) for p in frag.split('&') if '=' in p)
            orig = params.get('uri', params.get('url', ''))
            if orig:
                domain = urlparse(unquote(orig)).hostname or ''
                domain = domain.replace('www.', '')
        if not domain and tab_url:
            domain = urlparse(tab_url).hostname or ''
            domain = domain.replace('www.', '')
    domain_count = sum(1 for t in all_tracking.values() if isinstance(t, dict) and t.get('domain') == domain) if domain else 1
    ts = tracking.get('activationTimestamps', [])
    gaps = [ts[i] - ts[i-1] for i in range(1, len(ts))] if len(ts) > 1 else []
    avg_gap = (sum(gaps) / len(gaps) / 60000) if gaps else 0
    max_gap = (max(gaps) / 60000) if gaps else 0
    total_focus = tracking.get('totalFocusMs') or 0
    act_count = tracking.get('activationCount') or 0
    return {
        'ageMinutes': round((now - created) / 60000, 1),
        'idleMinutes': round((now - last_visited) / 60000, 1),
        'activationCount': act_count,
        'avgGapMinutes': round(avg_gap, 1),
        'maxGapMinutes': round(max_gap, 1),
        'totalFocusMs': round(total_focus),
        'avgFocusPerVisit': round(total_focus / act_count) if act_count > 0 else 0,
        'sessionCount': tracking.get('sessionCount', 1),
        'hasOpener': tracking.get('openerTabId') is not None,
        'openerDomain': tracking.get('openerDomain', ''),
        'domainTabCount': domain_count,
        'isDuplicate': domain_count > 1,
        'redirectCount': tracking.get('redirectCount', 0),
        'isGrouped': tab.get('groupId', -1) != -1,
        'domain': domain,
    }


def categorize_tabs(tabs: list, check_prs: bool = True) -> dict:
    """Categorize tabs into actionable groups."""
    categories = {
        'merged_prs': [],      # safe to close
        'closed_prs': [],      # safe to close
        'open_prs': [],        # keep
        'signin_pages': [],    # safe to close
        'new_tabs': [],        # safe to close
        'one_time': [],        # suggest close
        'search_results': [],  # suggest close
        'suspended': [],       # info only
        'grouped': [],         # skip
        'duplicates': [],      # close extras
        'keep': [],            # remaining
    }

    seen_urls = {}
    for t in tabs:
        url = t.get('url', '')
        title = t.get('title', '')
        is_grouped = t.get('groupId', -1) != -1

        # Suspended (chrome-extension:// on Chrome, extension:// on Edge)
        if ('chrome-extension://' in url or 'extension://' in url) and 'suspended' in url:
            categories['suspended'].append(t)
            continue

        # Grouped tabs — skip
        if is_grouped:
            categories['grouped'].append(t)
            continue

        # GitHub PRs
        if 'github.com' in url and '/pull/' in url:
            if check_prs:
                status = check_pr_status(url)
                t['pr_status'] = status
                if status == 'merged':
                    categories['merged_prs'].append(t)
                elif status == 'closed':
                    categories['closed_prs'].append(t)
                else:
                    categories['open_prs'].append(t)
            else:
                categories['open_prs'].append(t)
            continue

        # Sign-in / auth pages
        if 'accounts.google.com' in url or 'Sign In' in title or 'Sign in' in title or '/signin' in url or '/oauth/' in url:
            categories['signin_pages'].append(t)
            continue

        # New tabs
        if any(p in url for p in ['edge://newtab', 'chrome://newtab', 'about:blank']):
            categories['new_tabs'].append(t)
            continue

        # Search results
        if 'google.com/search' in url or 'bing.com/search' in url:
            categories['search_results'].append(t)
            continue

        # One-time tabs
        if any(p in url for p in ONE_TIME_PATTERNS):
            categories['one_time'].append(t)
            continue

        # Duplicate detection
        clean_url = url.split('?')[0].split('#')[0]
        if clean_url in seen_urls:
            categories['duplicates'].append(t)
            continue
        seen_urls[clean_url] = t

        categories['keep'].append(t)

    return categories
