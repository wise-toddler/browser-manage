const NATIVE_HOST = 'com.tabmanager.host';

let port = null;
let pendingChanges = null;

// Known memory-heavy URL patterns
const MEMORY_HOG_PATTERNS = [
  { pattern: 'console.cloud.google.com/logs', reason: 'GCP Logs Explorer' },
  { pattern: 'console.cloud.google.com/bigquery', reason: 'BigQuery' },
  { pattern: 'console.cloud.google.com/sql', reason: 'Cloud SQL Studio' },
  { pattern: 'console.cloud.google.com/kubernetes', reason: 'GKE Workloads' },
  { pattern: 'vscode.dev', reason: 'VS Code Web' },
  { pattern: 'github.dev', reason: 'GitHub Codespace' },
  { pattern: 'colab.research.google.com', reason: 'Google Colab' },
  { pattern: 'sentry.io', reason: 'Sentry' },
  { pattern: 'app.datadoghq.com', reason: 'Datadog' },
  { pattern: 'one.newrelic.com', reason: 'New Relic' },
  { pattern: 'grafana.com', reason: 'Grafana' },
  { pattern: 'figma.com/design', reason: 'Figma Design' },
  { pattern: 'stackblitz.com', reason: 'StackBlitz' },
  { pattern: 'replit.com', reason: 'Replit' },
  { pattern: 'idx.google.com', reason: 'Project IDX' },
];

function checkMemoryHog(url) {
  for (const { pattern, reason } of MEMORY_HOG_PATTERNS) {
    if (url.includes(pattern)) return { hog: true, reason };
  }
  return { hog: false, reason: null };
}

// --- Great Suspender integration (auto-detect extension ID) ---
const SUSPENDED_URL_PATTERN = /^chrome-extension:\/\/[a-z]+\/suspended\.html/;
let suspenderExtId = null;

function isSuspendedTab(url) {
  return SUSPENDED_URL_PATTERN.test(url);
}

// Auto-detect suspender extension ID from installed extensions or existing tabs
async function getSuspenderPrefix() {
  if (suspenderExtId) return `chrome-extension://${suspenderExtId}/suspended.html`;
  // Scan installed extensions for anything with "suspend" in the name
  try {
    const exts = await chrome.management.getAll();
    for (const ext of exts) {
      if (ext.enabled && ext.type === 'extension' && /suspend/i.test(ext.name)) {
        suspenderExtId = ext.id;
        return `chrome-extension://${suspenderExtId}/suspended.html`;
      }
    }
  } catch {}
  // Fallback: check existing tabs for a suspended URL
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (SUSPENDED_URL_PATTERN.test(t.url)) {
      suspenderExtId = t.url.split('/')[2];
      return `chrome-extension://${suspenderExtId}/suspended.html`;
    }
  }
  return null;
}

function parseSuspendedUrl(url) {
  const hash = url.split('#')[1] || '';
  const params = new URLSearchParams(hash);
  return { title: params.get('ttl') || params.get('title') || '', originalUrl: params.get('uri') || params.get('url') || '' };
}

async function listSuspendedTabs() {
  const tabs = await getTabs();
  return tabs.filter(t => isSuspendedTab(t.url)).map(t => {
    const parsed = parseSuspendedUrl(t.url);
    return { ...t, original_url: parsed.originalUrl, original_title: parsed.title, suspended: true };
  });
}

async function suspendTabs(tabIds) {
  const prefix = await getSuspenderPrefix();
  if (!prefix) return { error: 'Great Suspender extension not found' };
  const tabs = await getTabs();
  const whitelist = await getWhitelist();
  const results = { suspended: 0, skipped_whitelisted: 0, skipped_already: 0 };

  for (const tabId of tabIds) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) continue;
    if (isSuspendedTab(tab.url)) { results.skipped_already++; continue; }
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://')) continue;
    try {
      const domain = new URL(tab.url).hostname.replace('www.', '');
      if (whitelist.some(d => domain.includes(d))) { results.skipped_whitelisted++; continue; }
    } catch {}
    const suspendUrl = `${prefix}#ttl=${encodeURIComponent(tab.title)}&uri=${encodeURIComponent(tab.url)}`;
    await chrome.tabs.update(tabId, { url: suspendUrl });
    results.suspended++;
  }
  return results;
}

async function unsuspendTabs(tabIds) {
  const tabs = await chrome.tabs.query({});
  let unsuspended = 0;
  for (const tabId of tabIds) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !isSuspendedTab(tab.url)) continue;
    const parsed = parseSuspendedUrl(tab.url);
    if (parsed.originalUrl) {
      await chrome.tabs.update(tabId, { url: parsed.originalUrl });
      unsuspended++;
    }
  }
  return { unsuspended };
}

async function getWhitelist() {
  const data = await chrome.storage.local.get('suspendWhitelist');
  return data.suspendWhitelist || [];
}

async function updateWhitelist(action, domains) {
  let whitelist = await getWhitelist();
  if (action === 'add') {
    whitelist = [...new Set([...whitelist, ...domains])];
  } else if (action === 'remove') {
    whitelist = whitelist.filter(d => !domains.includes(d));
  } else if (action === 'list') {
    return whitelist;
  }
  await chrome.storage.local.set({ suspendWhitelist: whitelist });
  return whitelist;
}

// --- Tab time tracking ---
let tabTracking = {};
let persistTimer = null;

chrome.storage.local.get('tabTracking', (data) => {
  tabTracking = data.tabTracking || {};
});

function persistTracking() {
  // Debounce: batch writes within 5s
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.local.set({ tabTracking });
  }, 5000);
}

chrome.tabs.onCreated.addListener((tab) => {
  const now = Date.now();
  tabTracking[tab.id] = { createdAt: now, lastVisitedAt: now };
  persistTracking();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (tabTracking[activeInfo.tabId]) {
    tabTracking[activeInfo.tabId].lastVisitedAt = Date.now();
  } else {
    const now = Date.now();
    tabTracking[activeInfo.tabId] = { createdAt: now, lastVisitedAt: now };
  }
  persistTracking();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabTracking[tabId];
  persistTracking();
});

// Backfill existing tabs that predate tracking
chrome.tabs.query({}, (tabs) => {
  const now = Date.now();
  for (const tab of tabs) {
    if (!tabTracking[tab.id]) {
      tabTracking[tab.id] = { createdAt: now, lastVisitedAt: now };
    }
  }
  persistTracking();
});

async function getTabActivity() {
  const tabs = await getTabs();
  const now = Date.now();
  return tabs.map(t => {
    const tracking = tabTracking[t.id] || { createdAt: now, lastVisitedAt: now };
    return {
      ...t,
      created_at: tracking.createdAt,
      last_visited_at: tracking.lastVisitedAt,
      open_duration_mins: Math.round((now - tracking.createdAt) / 60000),
      idle_duration_mins: Math.round((now - tracking.lastVisitedAt) / 60000),
    };
  });
}

async function getStaleTabs(thresholdHours = 2) {
  const activity = await getTabActivity();
  const thresholdMs = thresholdHours * 3600000;
  const now = Date.now();
  return activity.filter(t => {
    const lastVisited = tabTracking[t.id]?.lastVisitedAt || now;
    return (now - lastVisited) > thresholdMs;
  });
}

// Detect browser type and generate unique profile ID per browser profile
async function getBrowserInfo() {
  const ua = navigator.userAgent;
  let browser = 'chrome';
  if (ua.includes('Edg/')) browser = 'edge';
  // chrome.runtime.id is same across profiles for unpacked extensions, so use a persistent UUID
  const data = await chrome.storage.local.get('profileId');
  let profileId = data.profileId;
  if (!profileId) {
    profileId = crypto.randomUUID().slice(0, 8);
    await chrome.storage.local.set({ profileId });
  }
  return { browser, profile: profileId };
}

// Connect to native host on startup
function connectNative() {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    console.log('Connected to native host');

    // Identify browser+profile on connect
    getBrowserInfo().then(info => port.postMessage({ action: 'identify', payload: info }));

    port.onMessage.addListener((message) => {
      console.log('Received from native:', message);
      handleNativeMessage(message);
    });

    port.onDisconnect.addListener(() => {
      console.log('Native host disconnected:', chrome.runtime.lastError?.message);
      port = null;
      // Reconnect after 2 seconds
      setTimeout(connectNative, 2000);
    });
  } catch (err) {
    console.error('Failed to connect to native host:', err);
    setTimeout(connectNative, 5000);
  }
}

async function handleNativeMessage(message) {
  const { action, id, payload } = message;
  let result;

  try {
    switch (action) {
      case 'getTabs':
        result = await getTabs();
        break;
      case 'getTabsWithMemory':
        result = await getTabsWithMemory();
        break;
      case 'getTabMetrics':
        result = await getTabMemoryViaDebugger(payload.tabId, true);
        break;
      case 'closeTabs':
        result = await closeTabs(payload.tabIds);
        break;
      case 'createGroup':
        result = await createGroup(payload.name, payload.color, payload.tabIds);
        break;
      case 'addToGroup':
        result = await addToGroup(payload.groupId, payload.tabIds);
        break;
      case 'previewChanges':
        result = await previewChanges(payload);
        break;
      case 'applyChanges':
        result = await applyChanges();
        break;
      case 'getTabActivity':
        result = await getTabActivity();
        break;
      case 'getStaleTabs':
        result = await getStaleTabs(payload.thresholdHours || 2);
        break;
      case 'listSuspended':
        result = await listSuspendedTabs();
        break;
      case 'suspendTabs':
        result = await suspendTabs(payload.tabIds);
        break;
      case 'unsuspendTabs':
        result = await unsuspendTabs(payload.tabIds);
        break;
      case 'suspendWhitelist':
        result = await updateWhitelist(payload.action, payload.domains || []);
        break;
      default:
        result = { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    result = { error: err.message };
  }

  // Send result back to native host
  if (port) {
    port.postMessage({ id, result });
  }
}

async function getTabs() {
  const windows = await chrome.windows.getAll({});
  const normalWindowIds = new Set(windows.filter(w => w.type === 'normal').map(w => w.id));

  const tabs = await chrome.tabs.query({});
  const groups = await chrome.tabGroups.query({});

  const groupMap = {};
  for (const g of groups) {
    groupMap[g.id] = { title: g.title, color: g.color };
  }

  return tabs.filter(t => normalWindowIds.has(t.windowId)).map(t => ({
    id: t.id,
    windowId: t.windowId,
    title: t.title,
    url: t.url,
    groupId: t.groupId,
    groupInfo: t.groupId !== -1 ? groupMap[t.groupId] : null
  }));
}

async function getTabMemoryViaDebugger(tabId, returnAllMetrics = false) {
  return new Promise(async (resolve) => {
    try {
      // Attach debugger
      await chrome.debugger.attach({ tabId }, "1.3");

      // Enable performance metrics
      await chrome.debugger.sendCommand({ tabId }, "Performance.enable");

      // Get metrics
      const result = await chrome.debugger.sendCommand({ tabId }, "Performance.getMetrics");

      // Detach debugger
      await chrome.debugger.detach({ tabId });

      if (returnAllMetrics) {
        resolve(result.metrics);
        return;
      }

      // Find JSHeapUsedSize
      const heapMetric = result.metrics.find(m => m.name === "JSHeapUsedSize");
      const heapMb = heapMetric ? heapMetric.value / (1024 * 1024) : 0;

      resolve(Math.round(heapMb * 10) / 10);
    } catch (e) {
      // Detach if attached
      try { await chrome.debugger.detach({ tabId }); } catch {}
      resolve(returnAllMetrics ? [] : 0);
    }
  });
}

async function getTabsWithMemory() {
  const tabs = await getTabs();
  let totalMemory = 0;

  // Get memory for each tab via debugger API
  const tabsWithMemory = await Promise.all(tabs.map(async (tab) => {
    // Skip chrome:// and edge:// URLs (can't attach debugger)
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://')) {
      return { ...tab, memory_mb: 0 };
    }

    const memoryMb = await getTabMemoryViaDebugger(tab.id);
    totalMemory += memoryMb;
    const hogInfo = checkMemoryHog(tab.url);
    const suspended = isSuspendedTab(tab.url);
    // Flag as hog if URL pattern matches OR actual memory exceeds 100MB
    const isHog = hogInfo.hog || memoryMb > 100;
    const hogReason = hogInfo.hog ? hogInfo.reason : (memoryMb > 100 ? `High memory: ${memoryMb}MB` : null);
    return { ...tab, memory_mb: memoryMb, hog: isHog, hog_reason: hogReason, suspended };
  }));

  // Sort by memory descending
  tabsWithMemory.sort((a, b) => b.memory_mb - a.memory_mb);
  const hogCount = tabsWithMemory.filter(t => t.hog).length;

  return {
    tabs: tabsWithMemory,
    total_memory_mb: Math.round(totalMemory * 10) / 10,
    total_memory_gb: Math.round(totalMemory / 1024 * 100) / 100,
    hog_count: hogCount
  };
}

async function closeTabs(tabIds) {
  await chrome.tabs.remove(tabIds);
  return { closed: tabIds.length };
}

async function createGroup(name, color, tabIds) {
  if (!tabIds || tabIds.length === 0) {
    return { error: 'No tab IDs provided' };
  }

  const groupId = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(groupId, {
    title: name,
    color: color || 'blue'
  });
  return { groupId, name, tabIds, success: true };
}

async function addToGroup(groupId, tabIds) {
  await chrome.tabs.group({ groupId, tabIds });
  return { groupId, added: tabIds.length };
}

async function previewChanges(changes) {
  pendingChanges = changes;
  await chrome.action.openPopup();
  return { status: 'preview_opened' };
}

async function applyChanges() {
  if (!pendingChanges) {
    return { error: 'No pending changes' };
  }

  const { toClose, groups } = pendingChanges;
  const results = { closed: 0, groupsCreated: 0 };

  if (toClose && toClose.length > 0) {
    await chrome.tabs.remove(toClose);
    results.closed = toClose.length;
  }

  if (groups) {
    for (const [name, config] of Object.entries(groups)) {
      if (config.tabIds && config.tabIds.length > 0) {
        const groupId = await chrome.tabs.group({ tabIds: config.tabIds });
        await chrome.tabGroups.update(groupId, {
          title: name,
          color: config.color || 'blue'
        });
        results.groupsCreated++;
      }
    }
  }

  pendingChanges = null;
  return results;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getPendingChanges') {
    sendResponse(pendingChanges);
  } else if (message.action === 'updatePendingChanges') {
    pendingChanges = message.changes;
    sendResponse({ ok: true });
  } else if (message.action === 'applyChanges') {
    applyChanges().then(sendResponse);
    return true;
  } else if (message.action === 'getTabs') {
    getTabs().then(sendResponse);
    return true;
  } else if (message.action === 'getTabsWithMemory') {
    getTabsWithMemory().then(sendResponse);
    return true;
  } else if (message.action === 'suspendStaleTabs') {
    suspendTabs(message.tabIds).then(sendResponse);
    return true;
  }
});

// Connect on startup
connectNative();
console.log('Tab Manager extension loaded');
