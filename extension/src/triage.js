// --- Triage window: staging area for disposable tabs ---
import { isSuspendedTab, parseSuspendedUrl, suspendUrlFor, getWhitelist } from './suspend.js';

let triageWindowId = null;

async function getOrCreateTriageWindow() {
  // Check if stored window still exists
  if (triageWindowId) {
    try {
      await chrome.windows.get(triageWindowId);
      return triageWindowId;
    } catch { triageWindowId = null; }
  }
  // Check storage
  const stored = await chrome.storage.local.get('triageWindowId');
  if (stored.triageWindowId) {
    try {
      await chrome.windows.get(stored.triageWindowId);
      triageWindowId = stored.triageWindowId;
      return triageWindowId;
    } catch { /* window gone */ }
  }
  // Create new minimized window
  const win = await chrome.windows.create({ state: 'minimized', focused: false });
  triageWindowId = win.id;
  await chrome.storage.local.set({ triageWindowId });
  return triageWindowId;
}

export async function getTriageWindowId() {
  if (triageWindowId) {
    try { await chrome.windows.get(triageWindowId); return triageWindowId; } catch { triageWindowId = null; }
  }
  const stored = await chrome.storage.local.get('triageWindowId');
  if (stored.triageWindowId) {
    try { await chrome.windows.get(stored.triageWindowId); triageWindowId = stored.triageWindowId; return triageWindowId; } catch { /* gone */ }
  }
  return null;
}

export async function triageTabs(tabIds) {
  if (!tabIds || tabIds.length === 0) return { error: 'No tab IDs provided' };
  const winId = await getOrCreateTriageWindow();
  const results = { triaged: 0, skipped: 0 };
  const whitelist = await getWhitelist();

  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      // Skip pinned, grouped, or already in triage
      if (tab.pinned || tab.windowId === winId) { results.skipped++; continue; }
      if (tab.groupId !== -1) { results.skipped++; continue; }
      // Skip whitelisted domains
      try {
        const domain = new URL(tab.url).hostname.replace('www.', '');
        if (whitelist.some(d => domain.includes(d))) { results.skipped++; continue; }
      } catch {}
      // Suspend first to save memory
      if (!isSuspendedTab(tab.url) && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://')) {
        await chrome.tabs.update(tabId, { url: suspendUrlFor(tab) });
      }
      // Move to triage window
      await chrome.tabs.move(tabId, { windowId: winId, index: -1 });
      results.triaged++;
    } catch { results.skipped++; }
  }
  // Keep triage minimized
  try { await chrome.windows.update(winId, { state: 'minimized' }); } catch {}
  return results;
}

// Move tabs back to the main window. focus=true also activates them and focuses that window
// (popup "Keep" button, or an agent passing allow_focus); without it the move happens silently
export async function restoreFromTriage(tabIds, focus = true) {
  const triageWin = await getTriageWindowId();
  if (!triageWin) return { error: 'No triage window found' };
  // Find the last focused non-triage window
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const mainWin = windows.find(w => w.id !== triageWin && w.focused) || windows.find(w => w.id !== triageWin);
  if (!mainWin) return { error: 'No main window to restore to' };
  let restored = 0;
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.move(tabId, { windowId: mainWin.id, index: -1 });
      if (focus) await chrome.tabs.update(tabId, { active: true });
      restored++;
    } catch {}
  }
  if (focus) await chrome.windows.update(mainWin.id, { focused: true });
  return { restored, windowId: mainWin.id };
}

export async function listTriageTabs() {
  const triageWin = await getTriageWindowId();
  if (!triageWin) return [];
  const tabs = await chrome.tabs.query({ windowId: triageWin });
  return tabs.map(t => {
    const parsed = isSuspendedTab(t.url) ? parseSuspendedUrl(t.url) : { title: '', originalUrl: '' };
    return {
      id: t.id, windowId: t.windowId,
      title: parsed.title || t.title,
      url: parsed.originalUrl || t.url,
      suspended: isSuspendedTab(t.url),
    };
  });
}
