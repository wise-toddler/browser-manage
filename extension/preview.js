let allTabs = [];
let memoryData = null;
let staleData = [];
let suspendedData = [];
let disposableData = [];
let triageData = [];
let pendingChanges = null;
let tabTrackingData = {};
let decisionLog = [];
let domainStats = {};
let currentView = 'all';

const STALE_THRESHOLD_HOURS = 2;

async function init() {
  try {
    // Load tabs and pending changes in parallel
    const [tabs, pending] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'getTabs' }),
      chrome.runtime.sendMessage({ action: 'getPendingChanges' }),
    ]);
    allTabs = tabs || [];
    pendingChanges = pending;

    // Set profile badge
    const data = await chrome.storage.local.get('profileId');
    const ua = navigator.userAgent;
    const browser = ua.includes('Edg/') ? 'Edge' : 'Chrome';
    document.getElementById('profile-badge').textContent = `${browser} · ${data.profileId || 'unknown'}`;

    renderStats();
    renderPending();
    renderTabs();
    updateTabCounts();

    // Load memory and stale data in background
    loadExtendedData();
  } catch (e) {
    document.getElementById('tab-list').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

async function loadExtendedData() {
  // These use the background script's internal functions via message passing
  try {
    // Get tab tracking data from storage
    const storage = await chrome.storage.local.get('tabTracking');
    const tracking = storage.tabTracking || {};
    tabTrackingData = tracking;
    const now = Date.now();
    const threshold = STALE_THRESHOLD_HOURS * 3600000;

    staleData = allTabs.filter(t => {
      const tr = tracking[t.id];
      return tr && (now - tr.lastVisitedAt) > threshold;
    }).map(t => {
      const tr = tracking[t.id];
      return { ...t, idle_mins: Math.round((now - tr.lastVisitedAt) / 60000) };
    });

    // Load decision log and domain stats
    const dlStore = await chrome.storage.local.get('decisionLog');
    decisionLog = dlStore.decisionLog || [];
    const dsStore = await chrome.storage.local.get('domainStats');
    domainStats = dsStore.domainStats || {};

    // Compute dispose predictions per tab
    disposableData = computeDisposable(allTabs, tracking, decisionLog, domainStats);

    // Load triage window tabs
    triageData = await new Promise(r => chrome.runtime.sendMessage({ action: 'listTriageTabs' }, r)) || [];

    // Load triage toggle state
    const triageSettings = await chrome.storage.local.get('autoTriageEnabled');
    document.getElementById('triage-toggle').checked = triageSettings.autoTriageEnabled || false;

    // Update learned stat
    document.getElementById('stat-decisions').textContent = decisionLog.length;

    // Detect suspended tabs
    const suspendPattern = /^(?:chrome-extension|extension):\/\/[a-z]+\/suspended\.html/;
    suspendedData = allTabs.filter(t => suspendPattern.test(t.url)).map(t => {
      const hash = t.url.split('#')[1] || '';
      const params = new URLSearchParams(hash);
      return { ...t, original_url: params.get('uri') || params.get('url') || '', original_title: params.get('ttl') || params.get('title') || '' };
    });

    updateTabCounts();
    // Re-render if on a filtered view
    if (currentView !== 'all') renderTabs();

    // Update stale stat
    document.getElementById('stat-stale').textContent = staleData.length;
    if (staleData.length > 3) {
      document.getElementById('stat-stale').closest('.stat-card').classList.add('warn');
    }

    // Fetch memory data (slow — runs after UI is ready)
    memoryData = await chrome.runtime.sendMessage({ action: 'getTabsWithMemory' });
    if (memoryData && memoryData.total_memory_gb) {
      const memEl = document.getElementById('stat-memory');
      memEl.textContent = memoryData.total_memory_gb + 'G';
      if (memoryData.total_memory_gb > 2) memEl.closest('.stat-card').classList.add('warn');
      if (memoryData.total_memory_gb > 4) memEl.closest('.stat-card').classList.add('danger');
      // Update hog count in tab nav
      const hogs = (memoryData.tabs || []).filter(t => t.hog);
      const counts = { hogs: hogs.length };
      document.querySelectorAll('.tab-btn').forEach(btn => {
        if (btn.dataset.view === 'hogs') {
          const countEl = btn.querySelector('.count');
          if (countEl) countEl.textContent = hogs.length;
        }
      });
    }
  } catch (e) {
    console.log('Extended data load error:', e);
  }
}

function computeDisposable(tabs, tracking, log, stats) {
  const closed = log.filter(d => d.outcome === 'closed');
  const kept = log.filter(d => d.outcome === 'kept');
  if (closed.length < 10 || kept.length < 5) return [];

  // Compute centroids for numeric features
  const featureKeys = ['ageMinutes','idleMinutes','activationCount','avgGapMinutes','maxGapMinutes','totalFocusMs','avgFocusPerVisit','sessionCount','domainTabCount','redirectCount'];
  const centroid = (decisions) => {
    const c = {};
    for (const k of featureKeys) c[k] = 0;
    for (const d of decisions) for (const k of featureKeys) c[k] += (d.features?.[k] || 0);
    const n = decisions.length || 1;
    for (const k of featureKeys) c[k] /= n;
    return c;
  };
  const dist = (a, b) => Math.sqrt(featureKeys.reduce((s, k) => s + (a[k] - b[k]) ** 2, 0));

  const closedC = centroid(closed);
  const keptC = centroid(kept);
  const now = Date.now();
  const results = [];

  for (const t of tabs) {
    const tr = tracking[t.id];
    if (!tr) continue;
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
    let domainCount = 0;
    const domain = tr.domain || '';
    for (const [, v] of Object.entries(tracking)) { if (v.domain === domain) domainCount++; }

    const features = {
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

    const dClose = dist(features, closedC);
    const dKept = dist(features, keptC);
    const prob = (dClose + dKept) > 0 ? dKept / (dClose + dKept) : 0.5;
    results.push({ ...t, dispose_probability: prob, domain });
  }
  return results.filter(t => t.dispose_probability > 0.6).sort((a, b) => b.dispose_probability - a.dispose_probability);
}

function updateTabCounts() {
  const counts = { all: allTabs.length, hogs: 0, stale: staleData.length, disposable: disposableData.length, triage: triageData.length, suspended: suspendedData.length };
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const view = btn.dataset.view;
    const count = counts[view] || 0;
    const countEl = btn.querySelector('.count');
    if (countEl) countEl.textContent = count;
    else btn.innerHTML = `${btn.textContent.trim()} <span class="count">${count}</span>`;
  });
}

function renderStats() {
  document.getElementById('stat-total').textContent = allTabs.length;
  // Count unique groups
  const groups = new Set(allTabs.filter(t => t.groupId && t.groupId !== -1).map(t => t.groupId));
  document.getElementById('stat-groups').textContent = groups.size;
  document.getElementById('stat-memory').textContent = '...';
  document.getElementById('stat-stale').textContent = '-';
}

function renderPending() {
  const banner = document.getElementById('pending-banner');
  if (!pendingChanges || (!pendingChanges.toClose?.length && !Object.keys(pendingChanges.groups || {}).length)) {
    banner.style.display = 'none';
    return;
  }
  const closeCount = pendingChanges.toClose?.length || 0;
  const groupCount = Object.keys(pendingChanges.groups || {}).length;
  document.getElementById('pending-text').textContent =
    `${closeCount} to close, ${groupCount} groups to create`;
  banner.style.display = 'flex';
}

function renderTabs() {
  const listEl = document.getElementById('tab-list');
  let tabs = [];

  switch (currentView) {
    case 'hogs':
      if (memoryData && memoryData.tabs) {
        tabs = memoryData.tabs.filter(t => t.hog);
      } else {
        // Fallback before memory loads: match known heavy URL patterns
        const patterns = ['console.cloud.google.com', 'bigquery', 'figma.com', 'sentry.io', 'datadoghq.com', 'colab.research', 'vscode.dev', 'github.dev'];
        tabs = allTabs.filter(t => patterns.some(p => t.url.includes(p)));
      }
      break;
    case 'stale':
      tabs = staleData;
      break;
    case 'disposable':
      tabs = disposableData;
      break;
    case 'triage':
      tabs = triageData;
      break;
    case 'suspended':
      tabs = suspendedData;
      break;
    default:
      tabs = allTabs;
  }

  if (tabs.length === 0) {
    listEl.innerHTML = `<div class="empty">No ${currentView} tabs found</div>`;
    return;
  }

  listEl.innerHTML = tabs.map(t => {
    const badges = [];
    // Temperature badge from tracking data
    const tr = tabTrackingData[t.id];
    if (tr && tr.lastVisitedAt) {
      const idleMins = (Date.now() - tr.lastVisitedAt) / 60000;
      let temp, tempClass;
      if (idleMins > 10080) { temp = 'frozen'; tempClass = 'badge-frozen'; }
      else if (idleMins > 1440) { temp = 'cold'; tempClass = 'badge-cold'; }
      else if (idleMins > 120) { temp = 'warm'; tempClass = 'badge-warm'; }
      else { temp = 'hot'; tempClass = 'badge-hot'; }
      badges.push(`<span class="badge ${tempClass}">${temp}</span>`);
    }
    // Dispose probability badge
    const dispTab = disposableData.find(d => d.id === t.id);
    if (dispTab) {
      const pct = Math.round(dispTab.dispose_probability * 100);
      const cls = pct > 80 ? 'badge-dispose' : pct > 60 ? 'badge-maybe' : 'badge-safe';
      badges.push(`<span class="badge ${cls}">${pct}%</span>`);
    }
    // Memory badge from memoryData
    const memTab = memoryData?.tabs?.find(m => m.id === t.id);
    if (memTab && memTab.memory_mb > 0) {
      const cls = memTab.hog ? 'badge-hog' : 'badge-memory';
      badges.push(`<span class="badge ${cls}">${memTab.memory_mb}MB</span>`);
    }
    if (staleData.find(s => s.id === t.id)) {
      const mins = staleData.find(s => s.id === t.id).idle_mins;
      badges.push(`<span class="badge badge-stale">${mins >= 60 ? Math.round(mins/60) + 'h' : mins + 'm'} idle</span>`);
    }
    if (t.groupInfo) {
      badges.push(`<span class="badge badge-group">${escapeHtml(t.groupInfo.title || t.groupInfo.color)}</span>`);
    }
    if (t.original_url) {
      badges.push(`<span class="badge badge-suspended">suspended</span>`);
    }
    const domain = getDomain(t.original_url || t.url);
    const favicon = `https://www.google.com/s2/favicons?sz=16&domain=${domain}`;
    const title = t.original_title || t.title || 'Untitled';

    return `
      <div class="tab-item" data-tab-id="${t.id}">
        <img class="favicon" src="${favicon}" onerror="this.style.display='none'">
        <div class="info">
          <div class="title">${escapeHtml(title)}</div>
          <div class="url">${escapeHtml(domain)}</div>
        </div>
        <div class="meta">
          ${badges.join('')}
          ${currentView === 'triage' ? `<button class="btn-restore" data-tab-id="${t.id}" title="Restore to main">Keep</button>` : ''}
          ${currentView === 'disposable' || (currentView === 'all' && disposableData.find(d => d.id === t.id)) ? `<button class="btn-triage-tab" data-tab-id="${t.id}" title="Move to triage">Triage</button>` : ''}
          <button class="btn-close-tab" data-tab-id="${t.id}" title="Close tab">&times;</button>
        </div>
      </div>
    `;
  }).join('');

  // Close tab buttons
  listEl.querySelectorAll('.btn-close-tab').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tabId = parseInt(btn.dataset.tabId);
      await chrome.tabs.remove(tabId);
      allTabs = allTabs.filter(t => t.id !== tabId);
      staleData = staleData.filter(t => t.id !== tabId);
      suspendedData = suspendedData.filter(t => t.id !== tabId);
      renderStats();
      updateTabCounts();
      renderTabs();
      showToast('Tab closed');
    });
  });

  // Restore from triage buttons
  listEl.querySelectorAll('.btn-restore').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tabId = parseInt(btn.dataset.tabId);
      await new Promise(r => chrome.runtime.sendMessage({ action: 'restoreFromTriage', tabIds: [tabId] }, r));
      triageData = triageData.filter(t => t.id !== tabId);
      updateTabCounts();
      renderTabs();
      showToast('Restored to main window');
    });
  });

  // Triage buttons
  listEl.querySelectorAll('.btn-triage-tab').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tabId = parseInt(btn.dataset.tabId);
      await new Promise(r => chrome.runtime.sendMessage({ action: 'triageTabs', tabIds: [tabId] }, r));
      allTabs = allTabs.filter(t => t.id !== tabId);
      disposableData = disposableData.filter(t => t.id !== tabId);
      triageData = await new Promise(r => chrome.runtime.sendMessage({ action: 'listTriageTabs' }, r)) || [];
      renderStats();
      updateTabCounts();
      renderTabs();
      showToast('Moved to triage');
    });
  });

  // Click to activate tab
  listEl.querySelectorAll('.tab-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.btn-close-tab')) return;
      const tabId = parseInt(item.dataset.tabId);
      chrome.tabs.update(tabId, { active: true });
      const tab = allTabs.find(t => t.id === tabId);
      if (tab) chrome.windows.update(tab.windowId, { focused: true });
    });
  });
}

// Tab navigation
document.getElementById('tabs-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentView = btn.dataset.view;
  renderTabs();
});

// Close duplicates
document.getElementById('btn-dupes').addEventListener('click', async () => {
  const btn = document.getElementById('btn-dupes');
  btn.disabled = true;
  btn.textContent = 'Finding...';

  const urlToTabs = {};
  for (const tab of allTabs) {
    if (!urlToTabs[tab.url]) urlToTabs[tab.url] = [];
    urlToTabs[tab.url].push(tab);
  }

  const toClose = [];
  const newTabUrls = ['edge://newtab/', 'chrome://newtab/', 'about:newtab', 'about:blank'];
  for (const [url, tabs] of Object.entries(urlToTabs)) {
    if (newTabUrls.some(nt => url.startsWith(nt))) {
      toClose.push(...tabs.map(t => t.id));
    } else if (tabs.length > 1) {
      toClose.push(...tabs.slice(1).map(t => t.id));
    }
  }

  if (toClose.length === 0) {
    showToast('No duplicates found');
    btn.textContent = 'Close Duplicates';
    btn.disabled = false;
    return;
  }

  await chrome.tabs.remove(toClose);
  allTabs = allTabs.filter(t => !toClose.includes(t.id));
  renderStats();
  updateTabCounts();
  renderTabs();
  showToast(`Closed ${toClose.length} duplicate tabs`);
  btn.textContent = 'Close Duplicates';
  btn.disabled = false;
});

// Suspend stale tabs
document.getElementById('btn-suspend-stale').addEventListener('click', async () => {
  const btn = document.getElementById('btn-suspend-stale');
  if (staleData.length === 0) {
    showToast('No stale tabs to suspend');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Suspending...';

  const tabIds = staleData.map(t => t.id);
  // Send suspend command to background
  const result = await new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'suspendStaleTabs', tabIds }, resolve);
  });

  showToast(result?.error || `Suspended ${result?.suspended || 0} tabs`);
  // Refresh
  allTabs = await chrome.runtime.sendMessage({ action: 'getTabs' });
  await loadExtendedData();
  renderStats();
  renderTabs();
  btn.textContent = 'Suspend Stale';
  btn.disabled = false;
});

// Triage all disposable tabs
document.getElementById('btn-triage').addEventListener('click', async () => {
  const btn = document.getElementById('btn-triage');
  if (disposableData.length === 0) { showToast('No disposable tabs'); return; }
  btn.disabled = true;
  btn.textContent = 'Triaging...';
  const tabIds = disposableData.map(t => t.id);
  await new Promise(r => chrome.runtime.sendMessage({ action: 'triageTabs', tabIds }, r));
  allTabs = await chrome.runtime.sendMessage({ action: 'getTabs' });
  triageData = await new Promise(r => chrome.runtime.sendMessage({ action: 'listTriageTabs' }, r)) || [];
  await loadExtendedData();
  renderStats();
  updateTabCounts();
  renderTabs();
  showToast(`Triaged ${tabIds.length} tabs`);
  btn.textContent = 'Triage Disposable';
  btn.disabled = false;
});

// Auto-triage toggle
document.getElementById('triage-toggle').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ autoTriageEnabled: e.target.checked });
  showToast(e.target.checked ? 'Auto-triage enabled' : 'Auto-triage disabled');
});

// Refresh
document.getElementById('btn-refresh').addEventListener('click', async () => {
  document.getElementById('tab-list').innerHTML = '<div class="loading"><div class="spinner"></div>Refreshing...</div>';
  allTabs = await chrome.runtime.sendMessage({ action: 'getTabs' });
  renderStats();
  renderTabs();
  await loadExtendedData();
  showToast('Refreshed');
});

// Apply pending changes
document.getElementById('apply-btn').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ action: 'applyChanges' });
  if (result?.error) {
    showToast('Error: ' + result.error);
  } else {
    pendingChanges = null;
    renderPending();
    allTabs = await chrome.runtime.sendMessage({ action: 'getTabs' });
    renderStats();
    renderTabs();
    showToast('Changes applied');
  }
});

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url || ''; }
}

init();
