// Ways to run things in a tab: a shared chrome.debugger session manager, and a chrome.scripting runner
import { withTimeout, CDP_TIMEOUT_MS } from './util.js';

// One debugger attachment per tab, shared by every caller. Sessions stay attached between calls (no
// infobar flicker, no re-attach cost) and detach after IDLE_DETACH_MS without use, unless pinned
// (e.g. by a console/network capture). Refcounting keeps one call from detaching under another.
const IDLE_DETACH_MS = 30000;
const sessions = new Map(); // tabId -> session

async function acquire(tabId) {
  let s = sessions.get(tabId);
  if (!s) {
    s = { tabId, refs: 0, pins: 0, attached: false, attaching: null, idleTimer: null, dropAfter: false };
    sessions.set(tabId, s);
  }
  clearTimeout(s.idleTimer);
  s.refs++; // counted before awaiting so a concurrent release can't detach mid-attach
  try {
    if (!s.attached) {
      s.attaching ||= chrome.debugger.attach({ tabId }, '1.3')
        // Survives a service worker restart where Chrome kept our attachment but this map was lost
        .catch(e => { if (!/already attached/i.test(e?.message || '')) throw e; })
        .then(() => { s.attached = true; })
        .finally(() => { s.attaching = null; });
      await s.attaching;
    }
    return s;
  } catch (e) {
    s.refs--;
    if (!s.refs && !s.pins && sessions.get(tabId) === s) sessions.delete(tabId);
    throw e;
  }
}

function release(s, { keep = true } = {}) {
  s.refs = Math.max(0, s.refs - 1);
  if (s.refs || s.pins) return;
  if (!keep || s.dropAfter) { detachNow(s); return; }
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => { if (!s.refs && !s.pins) detachNow(s); }, IDLE_DETACH_MS);
}

function detachNow(s) {
  clearTimeout(s.idleTimer);
  if (sessions.get(s.tabId) !== s) return; // already gone (onDetach or replaced)
  sessions.delete(s.tabId);
  if (s.attached) { s.attached = false; chrome.debugger.detach({ tabId: s.tabId }).catch(() => {}); }
}

// Tab closed, navigated to a non-debuggable page, or the user hit Cancel on the infobar
chrome.debugger.onDetach.addListener(({ tabId }) => {
  const s = sessions.get(tabId);
  if (!s) return;
  clearTimeout(s.idleTimer);
  s.attached = false;
  sessions.delete(tabId);
});

// Run fn(cmd) with the tab's debugger session. cmd(method, params, ms, label) is a timed sendCommand.
// Attach errors (incl. the foreign-extension-frame refusal) propagate so callers can fall back.
// keep=false detaches right after (bulk scans); any timeout drops the session so a hung command dies with it.
export async function withDebugger(tabId, fn, { keep = true } = {}) {
  const s = await acquire(tabId);
  const cmd = (method, params, ms = CDP_TIMEOUT_MS, label = method) =>
    withTimeout(chrome.debugger.sendCommand({ tabId }, method, params), ms, label);
  try {
    return await fn(cmd);
  } catch (e) {
    if (/timed out/.test(e?.message || '')) s.dropAfter = true;
    throw e;
  } finally {
    release(s, { keep });
  }
}

// Hold a tab's session open regardless of idle time (for upcoming console/network capture)
export async function pin(tabId) {
  const s = await acquire(tabId);
  s.pins++;
  release(s);
}

export function unpin(tabId) {
  const s = sessions.get(tabId);
  if (!s || !s.pins) return;
  s.pins--;
  s.refs++;
  // A pin ending (viewport reset, capture stopped) means the caller is done: drop the infobar now, not after idle
  release(s, { keep: false });
}

// Run a function in the page's main world without the debugger
export async function inPage(tabId, func, args, ms = CDP_TIMEOUT_MS) {
  const [r] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args }), ms, 'executeScript');
  return r?.result;
}
