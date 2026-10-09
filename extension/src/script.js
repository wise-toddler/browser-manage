// --- Script execution (console-like), gated by a human-managed domain allowlist ---
// Default allowlist is ['*'] (all sites). To lock down, remove '*' in the popup and add domains;
// the list is only editable from the popup, so the MCP side cannot widen it again.
import { withDebugger, inPage } from './cdp.js';
import { pageEval } from './page.js';
import { isForeignFrameError, withTimeout } from './util.js';

const SCRIPT_TIMEOUT_MS = 8000;
const SCRIPT_TIMEOUT_MAX_MS = 60000;
const SCRIPT_RESULT_CAP = 20000;
const PROBE_MS = 1000;

// Task-queue probe: a MessageChannel message runs promptly in a merely throttled background tab (timer
// throttling doesn't touch it) but never in a frozen one. Edge "sleeping tabs" freeze the page: sync code
// still runs, but tasks, timers and network callbacks don't, so every awaited Promise hangs
const TASK_PROBE = 'new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(true); c.port2.postMessage(0); })';

const THROTTLE_HINT = ' Background tabs throttle timers (setTimeout fires at most once a second, about once a minute after ~5 min hidden), so avoid sleeps/timeouts in hidden-tab scripts.';

// Code with a top-level `return` is illegal as a script; run it as an async function body instead
const asFunctionBody = code => `(async () => {\n${code}\n})()`;
const isIllegalReturn = msg => /Illegal return statement/.test(msg || '');

export function clampScriptTimeout(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 1000), SCRIPT_TIMEOUT_MAX_MS) : SCRIPT_TIMEOUT_MS;
}

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
async function evalInPage(tabId, code, timeoutMs) {
  try {
    const r = await inPage(tabId, pageEval, [code], timeoutMs);
    if (!r.ok) return { error: r.err, mode: 'page-eval' };
    if (r.s.length > SCRIPT_RESULT_CAP) return { result: r.s.slice(0, SCRIPT_RESULT_CAP), truncated: true, type: r.t, mode: 'page-eval' };
    return { result: r.s === 'undefined' ? undefined : JSON.parse(r.s), type: r.t, mode: 'page-eval' };
  } catch (e) {
    return { error: e.message, mode: 'page-eval' };
  }
}

// Evaluate in a session: frozen-tab probe (and wake), then REPL-mode eval (top-level await, last expression
// is the result, a promise result is awaited), retried as an async function body when the code uses a top-level `return`
async function evalWithDebugger(tabId, code, timeoutMs, allowed) {
  return withDebugger(tabId, async (cmd) => {
    // Re-check after attach: the tab may have navigated since the URL check above
    const live = await cmd('Runtime.evaluate', { expression: 'location.hostname', returnByValue: true });
    if (!allowed(live.result?.value || '')) throw new Error('tab navigated to a non-allowlisted domain');

    // Raced outside cmd(): a probe timeout is an answer, and must not drop the session the way cmd timeouts do
    const probe = async () => {
      const p = chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: TASK_PROBE, awaitPromise: true, returnByValue: true });
      try { return (await withTimeout(p, PROBE_MS, 'probe')).result?.value === true; } catch { return false; }
    };
    let woke = false;
    if (!(await probe())) {
      try { await cmd('Page.setWebLifecycleState', { state: 'active' }); } catch {}
      if (!(await probe())) {
        return { error: 'Tab is frozen (a sleeping background tab): sync code runs but timers, fetch and other async work never complete, and waking it failed. Navigate or reload it (browser_action navigate to its URL) and retry.', frozen: true };
      }
      woke = true;
    }

    // A timeout drops the debugger session, which is what cancels a still-pending evaluate
    const started = Date.now();
    const left = () => Math.max(1, timeoutMs - (Date.now() - started));
    const timedOut = e => { throw /timed out/.test(e?.message || '') ? new Error(`script timed out after ${timeoutMs}ms.${THROTTLE_HINT}`) : e; };
    const evaluate = expression => cmd('Runtime.evaluate', { expression, objectGroup: 'bm-script', awaitPromise: true, replMode: true }, left(), 'script').catch(timedOut);
    const describe = r => r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    let r = await evaluate(code);
    if (r.exceptionDetails && isIllegalReturn(describe(r))) r = await evaluate(asFunctionBody(code));
    // REPL mode awaits top-level `await` but hands back a promise-valued last expression unsettled (so the
    // async body above, or a bare fetch(), would read as {}): settle it, and read any object by value
    if (!r.exceptionDetails && r.result.objectId) {
      r = await cmd('Runtime.callFunctionOn', { objectId: r.result.objectId, functionDeclaration: 'function () { return this; }', awaitPromise: true, returnByValue: true }, left(), 'script').catch(timedOut);
    }
    await cmd('Runtime.releaseObjectGroup', { objectGroup: 'bm-script' }).catch(() => {});
    if (r.exceptionDetails) return { error: describe(r) };
    const s = JSON.stringify(r.result.value) ?? 'undefined';
    const out = s.length > SCRIPT_RESULT_CAP
      ? { result: s.slice(0, SCRIPT_RESULT_CAP), truncated: true, type: r.result.type }
      : { result: r.result.value, type: r.result.type };
    if (woke) out.woke = 'tab was frozen (sleeping); woke it before running';
    return out;
  });
}

export async function runScript(tabId, code, timeoutMs) {
  if (typeof tabId !== 'number' || typeof code !== 'string' || !code) {
    return { error: 'tabId (number) and code (non-empty string) required' };
  }
  timeoutMs = clampScriptTimeout(timeoutMs);
  const tab = await chrome.tabs.get(tabId);
  if (tab.discarded) {
    // Attaching would reload it; a reload is a navigation the caller should choose, not a side effect
    return { error: 'Tab is discarded (the browser unloaded it to save memory), so its page is not running. Reloading it is a navigation: use browser_action action=navigate with its URL, then retry.', discarded: true };
  }
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
    out = await evalWithDebugger(tabId, code, timeoutMs, h => hostAllowed(h, scriptAllowlist));
  } catch (e) {
    out = isForeignFrameError(e) ? await evalInPage(tabId, code, timeoutMs) : { error: e.message };
  }
  await logScript({ tabId, url: tab.url, code, ok: !out.error, error: out.error });
  return out;
}
