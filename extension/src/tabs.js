// --- Tab listing, open/close/group, memory, and the popup's pending-changes preview ---
import { withDebugger } from './cdp.js';
import { getTriageWindowId } from './triage.js';
import { isSuspendedTab } from './suspend.js';
import { markExtensionClosing } from './tracking.js';

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

export async function getTabs() {
  const windows = await chrome.windows.getAll({});
  const triageWin = await getTriageWindowId();
  const normalWindowIds = new Set(windows.filter(w => w.type === 'normal' && w.id !== triageWin).map(w => w.id));

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

// keep=false: a whole-browser memory scan shouldn't leave every tab attached for the idle window
export async function getTabMemoryViaDebugger(tabId, returnAllMetrics = false) {
  try {
    const result = await withDebugger(tabId, async (cmd) => {
      await cmd('Performance.enable');
      return cmd('Performance.getMetrics');
    }, { keep: false });
    if (returnAllMetrics) return result.metrics;
    // Find JSHeapUsedSize
    const heapMetric = result.metrics.find(m => m.name === 'JSHeapUsedSize');
    const heapMb = heapMetric ? heapMetric.value / (1024 * 1024) : 0;
    return Math.round(heapMb * 10) / 10;
  } catch {
    return returnAllMetrics ? [] : 0;
  }
}

export async function getTabsWithMemory() {
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

export async function closeTabs(tabIds) {
  markExtensionClosing(tabIds);
  await chrome.tabs.remove(tabIds);
  return { closed: tabIds.length };
}

// Open URLs in the main (non-triage) window, in the background unless active is set (callers gate focus)
export async function openTabs(urls, active) {
  if (!urls || urls.length === 0) return { error: 'No URLs provided' };
  const triageWin = await getTriageWindowId();
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const win = windows.find(w => w.id !== triageWin && w.focused) || windows.find(w => w.id !== triageWin);
  const tabIds = [], tabs = [];
  for (const url of urls) {
    const tab = await chrome.tabs.create({ url, active: false, ...(win ? { windowId: win.id } : {}) });
    tabIds.push(tab.id);
    // The requested URL: a just-created tab's own url is often still empty while it starts loading
    tabs.push({ tabId: tab.id, url, windowId: tab.windowId });
  }
  if (active) await chrome.tabs.update(tabIds[0], { active: true });
  return { opened: tabIds.length, tabIds, tabs };
}

export async function createGroup(name, color, tabIds) {
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

export async function addToGroup(groupId, tabIds) {
  await chrome.tabs.group({ groupId, tabIds });
  return { groupId, added: tabIds.length };
}

// --- Pending changes previewed in the popup before applying ---
let pendingChanges = null;

export const getPendingChanges = () => pendingChanges;

export function setPendingChanges(changes) {
  pendingChanges = changes;
}

export async function previewChanges(changes) {
  pendingChanges = changes;
  await chrome.action.openPopup();
  return { status: 'preview_opened' };
}

export async function applyChanges() {
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
