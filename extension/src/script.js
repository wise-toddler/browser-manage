// --- Script execution (console-like), gated by a human-managed domain allowlist ---
// Default allowlist is ['*'] (all sites). To lock down, remove '*' in the popup and add domains;
// the list is only editable from the popup, so the MCP side cannot widen it again.
import { withDebugger, inPage } from './cdp.js';
import { pageEval } from './page.js';
import { isForeignFrameError } from './util.js';

const SCRIPT_TIMEOUT_MS = 8000;
const SCRIPT_RESULT_CAP = 20000;

// '*' allows every site (the default); otherwise exact host or true subdomain only
// ('evil-github.com' must not match 'github.com')
export function hostAllowed(host, list) {
  return list.includes('*') || list.some(d => host === d || host.endsWith('.' + d));
}

async function logScript(entry) {
  const { scriptLog = [] } = await chrome.storage.local.get('scriptLog');
  scriptLog.push({ ts: Date.now(), ...entry, code: entry.code.slice(0, 2000) });
  await chrome.storage.local.set({ scriptLog: scriptLog.slice(-100) });
}

export async function getScriptInfo() {
  const { scriptAllowlist = ['*'], scriptLog = [] } = await chrome.storage.local.get(['scriptAllowlist', 'scriptLog']);
  return { allowlist: scriptAllowlist, recent: scriptLog.slice(-20) };
}

// Fallback when the debugger is refused: indirect eval in the page's main world (subject to the page's CSP)
async function evalInPage(tabId, code) {
  try {
    const r = await inPage(tabId, pageEval, [code]);
    if (!r.ok) return { error: r.err, mode: 'page-eval' };
    if (r.s.length > SCRIPT_RESULT_CAP) return { result: r.s.slice(0, SCRIPT_RESULT_CAP), truncated: true, type: r.t, mode: 'page-eval' };
    return { result: r.s === 'undefined' ? undefined : JSON.parse(r.s), type: r.t, mode: 'page-eval' };
  } catch (e) {
    return { error: e.message, mode: 'page-eval' };
  }
}

export async function runScript(tabId, code) {
  if (typeof tabId !== 'number' || typeof code !== 'string' || !code) {
    return { error: 'tabId (number) and code (non-empty string) required' };
  }
  const tab = await chrome.tabs.get(tabId);
  let host = '';
  try {
    const u = new URL(tab.url);
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname;
  } catch {}
  const { scriptAllowlist = ['*'] } = await chrome.storage.local.get('scriptAllowlist');
  if (!host || !hostAllowed(host, scriptAllowlist)) {
    await logScript({ tabId, url: tab.url, code, ok: false, error: 'domain not allowlisted' });
    return { error: `Domain '${host || tab.url.slice(0, 60)}' is not in the script allowlist. Add it from the extension popup (Script allowlist).`, allowlist: scriptAllowlist };
  }

  let out;
  try {
    out = await withDebugger(tabId, async (cmd) => {
      // Re-check after attach: the tab may have navigated since the URL check above
      const live = await cmd('Runtime.evaluate', { expression: 'location.hostname', returnByValue: true });
      if (!hostAllowed(live.result?.value || '', scriptAllowlist)) throw new Error('tab navigated to a non-allowlisted domain');
      // A timeout drops the debugger session, which is what cancels a still-pending evaluate
      const r = await cmd('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true }, SCRIPT_TIMEOUT_MS, 'script');
      if (r.exceptionDetails) {
        return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
      }
      const s = JSON.stringify(r.result.value) ?? 'undefined';
      return s.length > SCRIPT_RESULT_CAP
        ? { result: s.slice(0, SCRIPT_RESULT_CAP), truncated: true, type: r.result.type }
        : { result: r.result.value, type: r.result.type };
    });
  } catch (e) {
    out = isForeignFrameError(e) ? await evalInPage(tabId, code) : { error: e.message };
  }
  await logScript({ tabId, url: tab.url, code, ok: !out.error, error: out.error });
  return out;
}
