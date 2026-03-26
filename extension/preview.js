let allTabs = [];
let memoryData = null;
let staleData = [];
let suspendedData = [];
let pendingChanges = null;
let tabTrackingData = {};
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

    // Detect suspended tabs
    const suspendPattern = /^chrome-extension:\/\/[a-z]+\/suspended\.html/;
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

function updateTabCounts() {
  const counts = { all: allTabs.length, hogs: 0, stale: staleData.length, suspended: suspendedData.length };
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
