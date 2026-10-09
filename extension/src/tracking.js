// --- Tab time tracking, decision log, domain stats, periodic checkpoint ---
import { getDomainFromUrl } from './util.js';
import { isSuspendedTab, parseSuspendedUrl } from './suspend.js';
import { getTabs } from './tabs.js';
import { triageTabs } from './triage.js';

let tabTracking = {};
let activeTabId = null;
const extensionClosing = new Set();
let persistTimer = null;

export const getTabTracking = () => tabTracking;

// Closes we initiate are logged as 'extension', not as the user's own 'manual' decisions
export function markExtensionClosing(tabIds) {
  tabIds.forEach(id => extensionClosing.add(id));
}

// Resolve domain for suspended tabs by extracting original URL
function resolveTrackingDomain(url) {
  if (isSuspendedTab(url)) {
    const parsed = parseSuspendedUrl(url);
    if (parsed.originalUrl) return getDomainFromUrl(parsed.originalUrl);
  }
  return getDomainFromUrl(url);
}

// Skip internal/noise pages from decision logging
function isTrackableDomain(domain) {
  if (!domain) return false;
  if (domain === 'newtab' || domain === 'extensions') return false;
  // Extension IDs (32-char lowercase alpha strings)
  if (/^[a-z]{32}$/.test(domain)) return false;
  return true;
}

function newTrackingEntry(tab) {
  const now = Date.now();
  const url = tab.pendingUrl || tab.url || '';
  const domain = isSuspendedTab(url) ? resolveTrackingDomain(url) : getDomainFromUrl(url);
  const openerDomain = tab.openerTabId ? (tabTracking[tab.openerTabId]?.domain || '') : '';
  return {
    createdAt: now, lastVisitedAt: now,
    totalFocusMs: 0, focusStartedAt: null,
    activationCount: 0, activationTimestamps: [],
    sessionCount: 1,
    openerTabId: tab.openerTabId || null,
    openerDomain: openerDomain,
    domain: domain,
    redirectCount: 0, redirectedFrom: '',
  };
}

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
  tabTracking[tab.id] = newTrackingEntry(tab);
  persistTracking();
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const now = Date.now();
  // End focus for previous tab
  if (activeTabId && tabTracking[activeTabId]) {
    const prev = tabTracking[activeTabId];
    if (prev.focusStartedAt) {
      prev.totalFocusMs += (now - prev.focusStartedAt);
      prev.focusStartedAt = null;
    }
  }
  // Start focus for new tab
  const entry = tabTracking[activeInfo.tabId];
  if (entry) {
    entry.lastVisitedAt = now;
    entry.activationCount++;
    entry.activationTimestamps.push(now);
    if (entry.activationTimestamps.length > 20) entry.activationTimestamps.shift();
    // Session detection: 30min gap = new session
    const ts = entry.activationTimestamps;
    if (ts.length >= 2 && (ts[ts.length - 1] - ts[ts.length - 2]) > 30 * 60 * 1000) {
      entry.sessionCount++;
    }
    entry.focusStartedAt = now;
  } else {
    tabTracking[activeInfo.tabId] = newTrackingEntry({ id: activeInfo.tabId, url: '' });
    tabTracking[activeInfo.tabId].focusStartedAt = now;
    tabTracking[activeInfo.tabId].activationCount = 1;
    tabTracking[activeInfo.tabId].activationTimestamps = [now];
  }
  activeTabId = activeInfo.tabId;
  persistTracking();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = tabTracking[tabId];
  if (entry && isTrackableDomain(entry.domain)) {
    const features = extractFeatures(tabId);
    const source = extensionClosing.has(tabId) ? 'extension' : 'manual';
    extensionClosing.delete(tabId);
    logDecision(features, 'closed', source, entry.domain);
    updateDomainStats(entry.domain, 'closed', features);
  }
  delete tabTracking[tabId];
  persistTracking();
});

// Detect redirects: domain change within same tab
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tabTracking[tabId]) {
    const newDomain = getDomainFromUrl(changeInfo.url);
    const oldDomain = tabTracking[tabId].domain;
    if (oldDomain && newDomain && oldDomain !== newDomain) {
      tabTracking[tabId].redirectCount++;
      tabTracking[tabId].redirectedFrom = oldDomain;
    }
    tabTracking[tabId].domain = newDomain;
    persistTracking();
  }
});

// Backfill existing tabs that predate tracking + migrate old entries
chrome.tabs.query({}, (tabs) => {
  for (const tab of tabs) {
    if (!tabTracking[tab.id]) {
      tabTracking[tab.id] = newTrackingEntry(tab);
    } else {
      // Migrate old entries
      const e = tabTracking[tab.id];
      if (e.totalFocusMs === undefined) e.totalFocusMs = 0;
      if (e.focusStartedAt === undefined) e.focusStartedAt = null;
      if (e.activationCount === undefined) e.activationCount = 0;
      if (e.activationTimestamps === undefined) e.activationTimestamps = [];
      if (e.sessionCount === undefined) e.sessionCount = 1;
      if (e.domain === undefined) e.domain = getDomainFromUrl(tab.url || '');
      if (e.openerTabId === undefined) e.openerTabId = null;
      if (e.openerDomain === undefined) e.openerDomain = '';
      if (e.redirectCount === undefined) e.redirectCount = 0;
      if (e.redirectedFrom === undefined) e.redirectedFrom = '';
    }
  }
  persistTracking();
});

// Extract full feature vector from a tab's tracking data
function extractFeatures(tabId) {
  const entry = tabTracking[tabId];
  if (!entry) return {};
  const now = Date.now();
  let totalFocus = entry.totalFocusMs || 0;
  if (entry.focusStartedAt) totalFocus += (now - entry.focusStartedAt);
  const ageMinutes = (now - entry.createdAt) / 60000;
  const idleMinutes = (now - entry.lastVisitedAt) / 60000;
  const ts = entry.activationTimestamps || [];
  let avgGap = 0, maxGap = 0;
  if (ts.length > 1) {
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
    avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length / 60000;
    maxGap = Math.max(...gaps) / 60000;
  }
  let domainTabCount = 0;
  for (const [, t] of Object.entries(tabTracking)) {
    if (t.domain === entry.domain) domainTabCount++;
  }
  return {
    ageMinutes: Math.round(ageMinutes * 10) / 10,
    idleMinutes: Math.round(idleMinutes * 10) / 10,
    activationCount: entry.activationCount || 0,
    avgGapMinutes: Math.round(avgGap * 10) / 10,
    maxGapMinutes: Math.round(maxGap * 10) / 10,
    totalFocusMs: Math.round(totalFocus),
    avgFocusPerVisit: entry.activationCount > 0 ? Math.round(totalFocus / entry.activationCount) : 0,
    sessionCount: entry.sessionCount || 1,
    hasOpener: entry.openerTabId !== null,
    openerDomain: entry.openerDomain || '',
    domainTabCount,
    isDuplicate: domainTabCount > 1,
    redirectCount: entry.redirectCount || 0,
    isGrouped: false,
  };
}

// Decision log + domain stats writes go through one queue, applied in a single storage read-modify-write.
// Closing many tabs at once fires an onRemoved per tab; when each did its own concurrent read-modify-write,
// entries were lost (last write wins) and the worker got busy enough that the close reply timed out
const DECISION_LOG_CAP = 500;
const FLUSH_DELAY_MS = 250;
const FLUSH_EAGER_AT = 200;
const pendingOps = []; // (decisionLog, domainStats) => void
let flushTimer = null;
let flushChain = Promise.resolve();

function enqueue(op) {
  pendingOps.push(op);
  if (pendingOps.length >= FLUSH_EAGER_AT) { flushDecisions(); return; }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushDecisions, FLUSH_DELAY_MS);
}

// Apply everything queued; serialized so two flushes never interleave their read-modify-writes
export function flushDecisions() {
  clearTimeout(flushTimer);
  flushTimer = null;
  flushChain = flushChain.then(async () => {
    if (!pendingOps.length) return;
    const ops = pendingOps.splice(0);
    const { decisionLog = [], domainStats = {} } = await chrome.storage.local.get(['decisionLog', 'domainStats']);
    for (const op of ops) op(decisionLog, domainStats);
    await chrome.storage.local.set({ decisionLog: decisionLog.slice(-DECISION_LOG_CAP), domainStats });
  }).catch(e => console.error('decision flush failed', e));
  return flushChain;
}

function logDecision(features, outcome, source, domain) {
  const entry = { features, outcome, source, domain, timestamp: Date.now() };
  enqueue(log => { log.push(entry); });
}

function emptyDomainStats() {
  return { totalClosed: 0, totalKept: 0, totalOpened: 0, avgLifespanMinutes: 0, avgActivations: 0, avgFocusMs: 0, decisionCount: 0 };
}

function updateDomainStats(domain, outcome, features) {
  if (!domain) return;
  enqueue((_, stats) => {
    if (!stats[domain]) stats[domain] = emptyDomainStats();
    const s = stats[domain];
    if (outcome === 'closed') s.totalClosed++;
    else if (outcome === 'kept') s.totalKept++;
    s.decisionCount++;
    const n = s.decisionCount;
    s.avgLifespanMinutes += ((features.ageMinutes || 0) - s.avgLifespanMinutes) / n;
    s.avgActivations += ((features.activationCount || 0) - s.avgActivations) / n;
    s.avgFocusMs += ((features.totalFocusMs || 0) - s.avgFocusMs) / n;
  });
}

function updateDomainStatsSurvived(domain) {
  if (!domain) return;
  enqueue((_, stats) => {
    if (!stats[domain]) stats[domain] = emptyDomainStats();
    stats[domain].totalOpened++;
  });
}

export async function getDecisionLog() {
  await flushDecisions();
  const data = await chrome.storage.local.get('decisionLog');
  return data.decisionLog || [];
}

export async function getDomainStats() {
  await flushDecisions();
  const data = await chrome.storage.local.get('domainStats');
  return data.domainStats || {};
}

export async function recordCleanupResult(kept = [], closed = []) {
  for (const item of kept) {
    const features = extractFeatures(item.tabId);
    if (features && Object.keys(features).length) {
      logDecision(features, 'kept', 'cleanup', item.domain || '');
      updateDomainStats(item.domain || '', 'kept', features);
    }
  }
  await flushDecisions();
  return { data: { recorded: true, kept: kept.length, closed: closed.length } };
}

export async function getTabActivity() {
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

export async function getStaleTabs(thresholdHours = 2) {
  const activity = await getTabActivity();
  const thresholdMs = thresholdHours * 3600000;
  const now = Date.now();
  return activity.filter(t => {
    const lastVisited = tabTracking[t.id]?.lastVisitedAt || now;
    return (now - lastVisited) > thresholdMs;
  });
}

// Periodic checkpoint: tabs still alive = survived signal, trim the log, optional auto-triage
export async function runCheckpoint() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const entry = tabTracking[tab.id];
    if (entry && entry.domain) updateDomainStatsSurvived(entry.domain);
  }
  // One write for all the survival bumps; the flush also trims the log
  const log = await getDecisionLog();

  // Auto-triage if enabled
  const settings = await chrome.storage.local.get('autoTriageEnabled');
  if (settings.autoTriageEnabled) {
    const closed = log.filter(d => d.outcome === 'closed');
    const kept = log.filter(d => d.outcome === 'kept');
    if (closed.length >= 10 && kept.length >= 5) {
      // Simple dispose check: tabs idle > 1 day + high dispose signal
      const now = Date.now();
      const idleThreshold = 24 * 60 * 60000; // 1 day
      const toTriage = [];
      for (const tab of tabs) {
        const tr = tabTracking[tab.id];
        if (!tr || !isTrackableDomain(tr.domain)) continue;
        if (tab.pinned || tab.groupId !== -1) continue;
        if ((now - tr.lastVisitedAt) > idleThreshold && (tr.activationCount || 0) <= 2) {
          toTriage.push(tab.id);
        }
      }
      if (toTriage.length > 0) await triageTabs(toTriage);
    }
  }
}
