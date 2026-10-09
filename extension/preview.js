// Popup (preview.html): loads tabs + derived views from the worker's ACTIONS registry (src/main.js) and storage
let allTabs = [];
let memoryData = null;
let staleData = [];
let suspendedData = [];
let disposableData = [];
let triageData = [];
let pendingChanges = null;
let tabTrackingData = {};
let currentView = 'all';
let toastTimer = null;

const STALE_THRESHOLD_HOURS = 2;
// Hogs view fallback before memory loads (src/tabs.js has the worker's own list)
const HOG_URL_PATTERNS = ['console.cloud.google.com', 'bigquery', 'figma.com', 'sentry.io', 'datadoghq.com', 'colab.research', 'vscode.dev', 'github.dev'];
// Our own or Great Suspender's suspended page (same pattern as src/suspend.js)
const SUSPENDED_RE = /^(?:chrome-extension|extension):\/\/[a-z]+\/suspended\.html/;
// Close Duplicates also closes every new tab page
const NEW_TAB_URLS = ['edge://newtab/', 'chrome://newtab/', 'about:newtab', 'about:blank'];
const FEATURE_KEYS = ['ageMinutes','idleMinutes','activationCount','avgGapMinutes','maxGapMinutes','totalFocusMs','avgFocusPerVisit','sessionCount','domainTabCount','redirectCount'];

const $ = id => document.getElementById(id);

// One request to the worker; resolves with its reply (nothing when the handler failed)
function send(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

// --- Data loading ---

async function init() {
  try {
    // Load tabs and pending changes in parallel
    const [tabs, pending] = await Promise.all([send('getTabs'), send('getPendingChanges')]);
    allTabs = tabs || [];
    pendingChanges = pending;

    // Set profile badge
    const data = await chrome.storage.local.get('profileId');
    const browser = navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome';
    $('profile-badge').textContent = `${browser} · ${data.profileId || 'unknown'}`;

    renderStats();
    renderStatsLoading();
    renderPending();
    renderTabs();
    updateTabCounts();

    // Load memory and stale data in background
    loadExtendedData();
  } catch (e) {
    renderListMessage(`Error: ${e.message}`);
  }
}

// Re-fetch tabs and everything derived from them (Refresh, and after bulk actions)
async function reloadTabs() {
  allTabs = (await send('getTabs')) || [];
  renderStats();
  renderStatsLoading();
  renderTabs();
  await loadExtendedData();
}

async function loadExtendedData() {
  // These use the background script's internal functions via message passing
  try {
    // Get tab tracking data, decision log and triage toggle state from storage
    const store = await chrome.storage.local.get(['tabTracking', 'decisionLog', 'autoTriageEnabled']);
    tabTrackingData = store.tabTracking || {};
    const decisionLog = store.decisionLog || [];
    staleData = findStale(allTabs, tabTrackingData);

    // Compute dispose predictions per tab
    disposableData = computeDisposable(allTabs, tabTrackingData, decisionLog);

    // Load triage window tabs
    triageData = (await send('listTriageTabs')) || [];

    // Load triage toggle state
    $('triage-toggle').checked = store.autoTriageEnabled || false;

    // Update learned stat
    $('stat-decisions').textContent = decisionLog.length;

    // Detect suspended tabs
    suspendedData = findSuspended(allTabs);

    updateTabCounts();
    // Re-render if on a filtered view
    if (currentView !== 'all') renderTabs();

    // Update stale stat
    renderStaleStat();

    // Fetch memory data (slow — runs after UI is ready)
    memoryData = await send('getTabsWithMemory');
    if (memoryData && memoryData.total_memory_gb) {
      const gb = memoryData.total_memory_gb;
      const memCard = $('stat-memory').closest('.stat-card');
      $('stat-memory').textContent = gb + 'G';
      memCard.classList.toggle('warn', gb > 2);
      memCard.classList.toggle('danger', gb > 4);
      // Update hog count in tab nav
      updateTabCounts();
    }
  } catch (e) {
    console.log('Extended data load error:', e);
  }
}

// Tabs idle longer than STALE_THRESHOLD_HOURS, with their idle minutes
function findStale(tabs, tracking) {
  const now = Date.now();
  const threshold = STALE_THRESHOLD_HOURS * 3600000;
  return tabs
    .filter(t => tracking[t.id] && (now - tracking[t.id].lastVisitedAt) > threshold)
    .map(t => ({ ...t, idle_mins: Math.round((now - tracking[t.id].lastVisitedAt) / 60000) }));
}

// Suspended tabs, with the original URL/title parsed from the page's hash
function findSuspended(tabs) {
  return tabs.filter(t => SUSPENDED_RE.test(t.url)).map(t => {
    const params = new URLSearchParams(t.url.split('#')[1] || '');
    return { ...t, original_url: params.get('uri') || params.get('url') || '', original_title: params.get('ttl') || params.get('title') || '' };
  });
}

// Nearest centroid over the decision log: closer to past 'closed' than 'kept' tabs = disposable (> 0.6)
function computeDisposable(tabs, tracking, log) {
  const closed = log.filter(d => d.outcome === 'closed');
  const kept = log.filter(d => d.outcome === 'kept');
  if (closed.length < 10 || kept.length < 5) return [];

  // Compute centroids for numeric features
  const closedC = centroid(closed);
  const keptC = centroid(kept);
  const now = Date.now();
  const results = [];

  for (const t of tabs) {
    const tr = tracking[t.id];
    if (!tr) continue;
    const features = tabFeatures(tr, tracking, now);
    const dClose = distance(features, closedC);
    const dKept = distance(features, keptC);
    const prob = (dClose + dKept) > 0 ? dKept / (dClose + dKept) : 0.5;
    results.push({ ...t, dispose_probability: prob, domain: tr.domain || '' });
  }
  return results.filter(t => t.dispose_probability > 0.6).sort((a, b) => b.dispose_probability - a.dispose_probability);
}

function centroid(decisions) {
  const c = {};
  for (const k of FEATURE_KEYS) c[k] = 0;
  for (const d of decisions) for (const k of FEATURE_KEYS) c[k] += (d.features?.[k] || 0);
  const n = decisions.length || 1;
  for (const k of FEATURE_KEYS) c[k] /= n;
  return c;
}

function distance(a, b) {
  return Math.sqrt(FEATURE_KEYS.reduce((s, k) => s + (a[k] - b[k]) ** 2, 0));
}

// A tab's features from its tracking entry (unrounded subset of extractFeatures in src/tracking.js)
function tabFeatures(tr, tracking, now) {
  const totalFocus = tr.totalFocusMs || 0;
  const actCount = tr.activationCount || 0;
  const ts = tr.activationTimestamps || [];
  let avgGap = 0, maxGap = 0;
  if (ts.length > 1) {
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i-1]);
    avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length / 60000;
    maxGap = Math.max(...gaps) / 60000;
  }
  const domain = tr.domain || '';
  const domainCount = Object.values(tracking).filter(v => v.domain === domain).length;
  return {
    ageMinutes: (now - tr.createdAt) / 60000,
    idleMinutes: (now - tr.lastVisitedAt) / 60000,
    activationCount: actCount,
    avgGapMinutes: avgGap,
    maxGapMinutes: maxGap,
    totalFocusMs: totalFocus,
    avgFocusPerVisit: actCount > 0 ? totalFocus / actCount : 0,
    sessionCount: tr.sessionCount || 1,
    domainTabCount: domainCount,
    redirectCount: tr.redirectCount || 0,
  };
}

// New tab pages, plus every tab of a URL after its first
function findDuplicates(tabs) {
  const urlToTabs = {};
  for (const tab of tabs) (urlToTabs[tab.url] ||= []).push(tab);
  const toClose = [];
  for (const [url, sameUrl] of Object.entries(urlToTabs)) {
    if (NEW_TAB_URLS.some(nt => url.startsWith(nt))) toClose.push(...sameUrl.map(t => t.id));
    else if (sameUrl.length > 1) toClose.push(...sameUrl.slice(1).map(t => t.id));
  }
  return toClose;
}

// Forget tabs closed or triaged from here in every view, so they don't linger until the next refresh
function dropTabs(ids) {
  const keep = t => !ids.includes(t.id);
  allTabs = allTabs.filter(keep);
  staleData = staleData.filter(keep);
  suspendedData = suspendedData.filter(keep);
  disposableData = disposableData.filter(keep);
  triageData = triageData.filter(keep);
  if (memoryData?.tabs) memoryData.tabs = memoryData.tabs.filter(keep);
}

// --- Rendering ---

function renderStats() {
  $('stat-total').textContent = allTabs.length;
  // Count unique groups
  const groups = new Set(allTabs.filter(t => t.groupId && t.groupId !== -1).map(t => t.groupId));
  $('stat-groups').textContent = groups.size;
}

function renderStaleStat() {
  $('stat-stale').textContent = staleData.length;
  $('stat-stale').closest('.stat-card').classList.toggle('warn', staleData.length > 3);
}

// Memory and stale placeholders until loadExtendedData fills them in
function renderStatsLoading() {
  $('stat-memory').textContent = '...';
  $('stat-stale').textContent = '-';
}

function updateTabCounts() {
  const hogs = (memoryData?.tabs || []).filter(t => t.hog).length;
  const counts = { all: allTabs.length, hogs, stale: staleData.length, disposable: disposableData.length, triage: triageData.length, suspended: suspendedData.length };
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const count = counts[btn.dataset.view] || 0;
    const countEl = btn.querySelector('.count');
    if (countEl) countEl.textContent = count;
    else btn.innerHTML = `${btn.textContent.trim()} <span class="count">${count}</span>`;
  });
}

// Stats, nav counts and the list, from what's already loaded
function rerender() {
  renderStats();
  renderStaleStat();
  updateTabCounts();
  renderTabs();
}

function renderPending() {
  const banner = $('pending-banner');
  const closeCount = pendingChanges?.toClose?.length || 0;
  const groupCount = Object.keys(pendingChanges?.groups || {}).length;
  if (!closeCount && !groupCount) {
    banner.style.display = 'none';
    return;
  }
  $('pending-text').textContent = `${closeCount} to close, ${groupCount} groups to create`;
  banner.style.display = 'flex';
}

function tabsForView(view) {
  switch (view) {
    case 'hogs':
      if (memoryData && memoryData.tabs) return memoryData.tabs.filter(t => t.hog);
      // Fallback before memory loads: match known heavy URL patterns
      return allTabs.filter(t => HOG_URL_PATTERNS.some(p => t.url.includes(p)));
    case 'stale': return staleData;
    case 'disposable': return disposableData;
    case 'triage': return triageData;
    case 'suspended': return suspendedData;
    default: return allTabs;
  }
}

function renderTabs() {
  const tabs = tabsForView(currentView);
  if (tabs.length === 0) {
    renderListMessage(`No ${currentView} tabs found`);
    return;
  }
  $('tab-list').innerHTML = tabs.map(tabItemHtml).join('');
}

function renderListMessage(text) {
  $('tab-list').innerHTML = `<div class="empty">${escapeHtml(text)}</div>`;
}

// Every untrusted string (title, URL/domain, group name) goes through escapeHtml, attributes included
function tabItemHtml(t) {
  const disposable = disposableData.find(d => d.id === t.id);
  const domain = getDomain(t.original_url || t.url);
  const favicon = `https://www.google.com/s2/favicons?sz=16&domain=${domain}`;
  const title = t.original_title || t.title || 'Untitled';
  const canTriage = currentView === 'disposable' || (currentView === 'all' && disposable);

  return `
      <div class="tab-item" data-tab-id="${t.id}">
        <img class="favicon" src="${escapeHtml(favicon)}">
        <div class="info">
          <div class="title">${escapeHtml(title)}</div>
          <div class="url">${escapeHtml(domain)}</div>
        </div>
        <div class="meta">
          ${tabBadges(t, disposable).join('')}
          ${currentView === 'triage' ? `<button class="btn-restore" data-tab-id="${t.id}" title="Restore to main">Keep</button>` : ''}
          ${canTriage ? `<button class="btn-triage-tab" data-tab-id="${t.id}" title="Move to triage">Triage</button>` : ''}
          <button class="btn-close-tab" data-tab-id="${t.id}" title="Close tab">&times;</button>
        </div>
      </div>
    `;
}

function tabBadges(t, disposable) {
  const badges = [];
  // Temperature badge from tracking data
  const tr = tabTrackingData[t.id];
  if (tr && tr.lastVisitedAt) {
    const temp = temperature((Date.now() - tr.lastVisitedAt) / 60000);
    badges.push(`<span class="badge badge-${temp}">${temp}</span>`);
  }
  // Dispose probability badge
  if (disposable) {
    const pct = Math.round(disposable.dispose_probability * 100);
    const cls = pct > 80 ? 'badge-dispose' : pct > 60 ? 'badge-maybe' : 'badge-safe';
    badges.push(`<span class="badge ${cls}">${pct}%</span>`);
  }
  // Memory badge from memoryData
  const memTab = memoryData?.tabs?.find(m => m.id === t.id);
  if (memTab && memTab.memory_mb > 0) {
    const cls = memTab.hog ? 'badge-hog' : 'badge-memory';
    badges.push(`<span class="badge ${cls}">${memTab.memory_mb}MB</span>`);
  }
  const stale = staleData.find(s => s.id === t.id);
  if (stale) {
    const mins = stale.idle_mins;
    badges.push(`<span class="badge badge-stale">${mins >= 60 ? Math.round(mins/60) + 'h' : mins + 'm'} idle</span>`);
  }
  if (t.groupInfo) {
    badges.push(`<span class="badge badge-group">${escapeHtml(t.groupInfo.title || t.groupInfo.color)}</span>`);
  }
  if (t.original_url) {
    badges.push(`<span class="badge badge-suspended">suspended</span>`);
  }
  return badges;
}

// Idle minutes -> hot (up to 2h), warm (up to 1 day), cold (up to 7 days), frozen
function temperature(idleMins) {
  if (idleMins > 10080) return 'frozen';
  if (idleMins > 1440) return 'cold';
  if (idleMins > 120) return 'warm';
  return 'hot';
}

// --- Tab row actions ---

// Close tab buttons
async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  dropTabs([tabId]);
  rerender();
  showToast('Tab closed');
}

// Restore from triage buttons
async function keepTab(tabId) {
  await send('restoreFromTriage', { tabIds: [tabId] });
  triageData = triageData.filter(t => t.id !== tabId);
  rerender();
  showToast('Restored to main window');
}

// Triage buttons
async function triageTab(tabId) {
  await send('triageTabs', { tabIds: [tabId] });
  dropTabs([tabId]);
  triageData = (await send('listTriageTabs')) || [];
  rerender();
  showToast('Moved to triage');
}

// Click to activate tab
function activateTab(tabId) {
  chrome.tabs.update(tabId, { active: true });
  const tab = allTabs.find(t => t.id === tabId);
  if (tab) chrome.windows.update(tab.windowId, { focused: true });
}

// --- Event wiring ---

// Rows are re-rendered often, so their clicks are handled once here
$('tab-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab-id]');
  if (btn) {
    const tabId = parseInt(btn.dataset.tabId);
    if (btn.classList.contains('btn-close-tab')) closeTab(tabId);
    else if (btn.classList.contains('btn-restore')) keepTab(tabId);
    else if (btn.classList.contains('btn-triage-tab')) triageTab(tabId);
    return;
  }
  const item = e.target.closest('.tab-item');
  if (item) activateTab(parseInt(item.dataset.tabId));
});

// Hide favicons that fail to load. The MV3 popup CSP blocks inline onerror; error doesn't bubble, so capture
$('tab-list').addEventListener('error', (e) => {
  if (e.target.classList?.contains('favicon')) e.target.style.display = 'none';
}, true);

// Tab navigation
$('tabs-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentView = btn.dataset.view;
  renderTabs();
});

// Disable an action button with a busy label while fn runs
async function withBusy(btn, busyLabel, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    await fn();
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}

// Close duplicates
$('btn-dupes').addEventListener('click', () => withBusy($('btn-dupes'), 'Finding...', async () => {
  const toClose = findDuplicates(allTabs);
  if (toClose.length === 0) {
    showToast('No duplicates found');
    return;
  }
  await chrome.tabs.remove(toClose);
  dropTabs(toClose);
  rerender();
  showToast(`Closed ${toClose.length} duplicate tabs`);
}));

// Suspend stale tabs
$('btn-suspend-stale').addEventListener('click', async () => {
  if (staleData.length === 0) {
    showToast('No stale tabs to suspend');
    return;
  }
  await withBusy($('btn-suspend-stale'), 'Suspending...', async () => {
    // Send suspend command to background
    const result = await send('suspendStaleTabs', { tabIds: staleData.map(t => t.id) });
    showToast(result?.error || `Suspended ${result?.suspended || 0} tabs`);
    // Refresh, then re-render the list with the fresh tracking/memory data too
    await reloadTabs();
    rerender();
  });
});

// Triage all disposable tabs
$('btn-triage').addEventListener('click', async () => {
  if (disposableData.length === 0) { showToast('No disposable tabs'); return; }
  await withBusy($('btn-triage'), 'Triaging...', async () => {
    const tabIds = disposableData.map(t => t.id);
    await send('triageTabs', { tabIds });
    await reloadTabs();
    rerender();
    showToast(`Triaged ${tabIds.length} tabs`);
  });
});

// Auto-triage toggle
$('triage-toggle').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ autoTriageEnabled: e.target.checked });
  showToast(e.target.checked ? 'Auto-triage enabled' : 'Auto-triage disabled');
});

// Refresh
$('btn-refresh').addEventListener('click', async () => {
  $('tab-list').innerHTML = '<div class="loading"><div class="spinner"></div>Refreshing...</div>';
  await reloadTabs();
  showToast('Refreshed');
});

// Apply pending changes
$('apply-btn').addEventListener('click', async () => {
  const result = await send('applyChanges');
  if (result?.error) {
    showToast('Error: ' + result.error);
    return;
  }
  dropTabs(pendingChanges?.toClose || []);
  pendingChanges = null;
  renderPending();
  allTabs = (await send('getTabs')) || [];
  rerender();
  showToast('Changes applied');
});

// --- Script allowlist: the only place it can be edited (deliberately not exposed over MCP) ---
const DOMAIN_RE = /^(\*|([a-z0-9-]+\.)+[a-z]{2,}|localhost|\d{1,3}(\.\d{1,3}){3})$/;

// Unset means allowed everywhere, same default as src/script.js
async function getScriptAllowlist() {
  const { scriptAllowlist = ['*'] } = await chrome.storage.local.get('scriptAllowlist');
  return scriptAllowlist;
}

async function renderScriptAllowlist() {
  const scriptAllowlist = await getScriptAllowlist();
  $('script-allow-count').textContent = scriptAllowlist.length;
  const el = $('script-allow-list');
  el.innerHTML = scriptAllowlist.map(d =>
    `<div class="tab-item"><div class="info"><div class="title">${escapeHtml(d)}</div></div><button class="btn-close-tab" data-domain="${escapeHtml(d)}" title="Remove">&times;</button></div>`
  ).join('') || '<div class="empty">No domains allowed — scripts are blocked everywhere</div>';
  el.querySelectorAll('[data-domain]').forEach(btn => btn.addEventListener('click', async () => {
    const cur = await getScriptAllowlist();
    await chrome.storage.local.set({ scriptAllowlist: cur.filter(x => x !== btn.dataset.domain) });
    renderScriptAllowlist();
  }));
}

$('script-allow-add').addEventListener('click', async () => {
  const input = $('script-allow-input');
  const domain = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/:]/)[0].replace(/^www\./, '');
  if (!DOMAIN_RE.test(domain)) { showToast('Enter a domain like example.com, or * for all sites'); return; }
  const scriptAllowlist = await getScriptAllowlist();
  await chrome.storage.local.set({ scriptAllowlist: [...new Set([...scriptAllowlist, domain])] });
  input.value = '';
  renderScriptAllowlist();
  showToast(`Scripts allowed on ${domain}`);
});
renderScriptAllowlist();

// --- Helpers ---

function showToast(msg) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  // Restart the timer so an older toast's timeout doesn't hide this one early
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url || ''; }
}

init();
