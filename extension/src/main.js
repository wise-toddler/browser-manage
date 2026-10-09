// Service worker entry: native port, one action registry shared by the native host and the popup, alarms
import { focusBlocked } from './util.js';
import { doAction } from './actions.js';
import { screenshotTab } from './capture.js';
import { runScript, getScriptInfo } from './script.js';
import {
  getTabs, getTabsWithMemory, getTabMemoryViaDebugger, closeTabs, openTabs, createGroup, addToGroup,
  previewChanges, applyChanges, getPendingChanges, setPendingChanges,
} from './tabs.js';
import { listSuspendedTabs, suspendTabs, unsuspendTabs, updateWhitelist } from './suspend.js';
import { triageTabs, restoreFromTriage, listTriageTabs } from './triage.js';
import {
  getTabTracking, getTabActivity, getStaleTabs, getDecisionLog, getDomainStats, recordCleanupResult, runCheckpoint,
} from './tracking.js';
// P2 debug
import { debugCapture, readConsole, readNetwork } from './debug.js';
// P1 page
import { readPage, findInPage, getPageText, waitFor, uploadFiles } from './read.js';
// feedback: capture
import { setViewport } from './viewport.js';

const NATIVE_HOST = 'com.tabmanager.host';
let port = null;

// handler(payload, ctx): ctx.source is 'native' (an agent via the host) or 'popup' (a human, via an
// extension page); ctx.sender is the runtime sender for popup calls
export const ACTIONS = {
  // native + popup
  ping: () => 'pong',
  getTabs: () => getTabs(),
  getTabsWithMemory: () => getTabsWithMemory(),
  getTabMetrics: p => getTabMemoryViaDebugger(p.tabId, true),
  closeTabs: p => closeTabs(p.tabIds),
  action: (p, ctx) => doAction(p.tabId, p, ctx),
  screenshot: p => screenshotTab(p.tabId, p),
  runScript: p => runScript(p.tabId, p.code, p.timeoutMs), // feedback: small (timeoutMs)
  getScriptInfo: () => getScriptInfo(),
  openTabs: (p, ctx) => (p.active && focusBlocked(p, ctx, 'open_tabs active=true')) || openTabs(p.urls, p.active),
  createGroup: p => createGroup(p.name, p.color, p.tabIds),
  addToGroup: p => addToGroup(p.groupId, p.tabIds),
  previewChanges: p => previewChanges(p),
  applyChanges: () => applyChanges(),
  getTabActivity: () => getTabActivity(),
  getStaleTabs: p => getStaleTabs(p.thresholdHours || 2),
  listSuspended: () => listSuspendedTabs(),
  suspendTabs: p => suspendTabs(p.tabIds),
  unsuspendTabs: p => unsuspendTabs(p.tabIds),
  suspendWhitelist: p => updateWhitelist(p.action, p.domains || []),
  getDecisionLog: async () => ({ data: await getDecisionLog() }),
  getDomainStats: async () => ({ data: await getDomainStats() }),
  getTabTracking: () => ({ data: getTabTracking() }),
  triageTabs: p => triageTabs(p.tabIds),
  // Tabs always move back; activating them and focusing the window is gated for agents
  restoreFromTriage: (p, ctx) => restoreFromTriage(p.tabIds, !focusBlocked(p, ctx, 'restore_from_triage focus')),
  listTriageTabs: () => listTriageTabs(),
  recordCleanupResult: p => recordCleanupResult(p.kept || [], p.closed || []),
  // The reply is sent as soon as this resolves; the reload fires after, so the caller still gets an ack
  // (the port then dies with the worker and the host exits on EOF)
  reloadExtension: () => {
    setTimeout(() => chrome.runtime.reload(), 200);
    return { reloading: true };
  },
  // P1 page
  readPage: p => readPage(p.tabId, p),
  findInPage: p => findInPage(p.tabId, p.query),
  getPageText: p => getPageText(p.tabId, p.maxChars),
  waitFor: p => waitFor(p.tabId, p),
  uploadFiles: p => uploadFiles(p.tabId, p),
  // P2 debug
  debugCapture: p => debugCapture(p.tabId, p),
  readConsole: p => readConsole(p.tabId, p),
  readNetwork: p => readNetwork(p.tabId, p),
  // feedback: capture
  setViewport: p => setViewport(p.tabId, p),

  // popup / extension pages
  getPendingChanges: () => getPendingChanges(),
  updatePendingChanges: p => { setPendingChanges(p.changes); return { ok: true }; },
  suspendStaleTabs: p => suspendTabs(p.tabIds),
  // From suspended.html: navigate that tab back in place, staying in its window
  unsuspendCurrent: (p, ctx) => {
    chrome.tabs.update(ctx.sender.tab.id, { url: p.url });
    return { ok: true };
  },
};

export async function dispatch(action, payload = {}, ctx = { source: 'native' }) {
  const handler = ACTIONS[action];
  if (!handler) return { error: `Unknown action: ${action}` };
  try {
    return await handler(payload, ctx);
  } catch (err) {
    return { error: err.message };
  }
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

    port.onMessage.addListener(async (message) => {
      console.log('Received from native:', message);
      const { action, id, payload } = message;
      const result = await dispatch(action, payload || {}, { source: 'native' });
      // Send result back to native host
      if (port) port.postMessage({ id, result });
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

// Messages from the popup and other extension pages (suspended.html). Unknown actions get no reply,
// and a failing handler replies with nothing, as before (preview.js treats a missing reply as empty)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = ACTIONS[message?.action];
  if (!handler) return;
  const { action, ...payload } = message;
  Promise.resolve()
    .then(() => handler(payload, { source: 'popup', sender }))
    .then(sendResponse, () => sendResponse());
  return true;
});

// MV3 keepalive: 20s alarm keeps service worker alive (SW suspends after 30s idle)
chrome.alarms.create('keepalive', { periodInMinutes: 20/60 });
// Periodic checkpoint: tabs still alive = survived signal
chrome.alarms.create('checkpoint', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') {
    // Ping native port to keep both SW and connection alive
    if (!port) connectNative();
    return;
  }
  if (alarm.name === 'checkpoint') await runCheckpoint();
});

// Connect on startup
connectNative();
console.log('Tab Manager extension loaded');
