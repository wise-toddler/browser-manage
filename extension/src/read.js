// --- Page reading (read_page / find / page text), wait_for and file upload ---
// Reading runs through chrome.scripting in the isolated world: no debugger needed, so it works on hidden
// tabs, on tabs where another extension's frame blocks the debugger, and never flashes the infobar.
import { withDebugger, inPage } from './cdp.js';
import { snapshotPage, pageText, waitProbe, uploadTarget, setInputFiles } from './page.js';
import { withTimeout, sleep, isForeignFrameError, CDP_TIMEOUT_MS } from './util.js';

const WAIT_POLL_MS = 200;
const WAIT_MAX_MS = 60000;

// read_page refs are data-bm-ref attributes; accept "ref_12", "12" or 12
export function refSelector(ref) {
  const n = String(ref).replace(/\D/g, '');
  return n ? `[data-bm-ref="${n}"]` : null;
}

async function isolated(tabId, func, args) {
  const [r] = await withTimeout(
    chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func, args }), CDP_TIMEOUT_MS, 'executeScript');
  return r?.result;
}

export async function readPage(tabId, p = {}) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
  const filter = p.filter === 'all' ? 'all' : 'interactive';
  const r = await isolated(tabId, snapshotPage, [{ mode: 'tree', filter, maxChars: p.maxChars || 30000, ref: p.ref ?? null }]);
  return r ?? { error: 'page returned nothing (not scriptable: browser/extension page?)' };
}

export async function findInPage(tabId, query) {
  if (typeof tabId !== 'number' || !query) return { error: 'tabId (number) and query required' };
  const r = await isolated(tabId, snapshotPage, [{ mode: 'find', query }]);
  return r ?? { error: 'page returned nothing (not scriptable: browser/extension page?)' };
}

export async function getPageText(tabId, maxChars = 50000) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
  const r = await isolated(tabId, pageText, [maxChars]);
  return r ?? { error: 'page returned nothing (not scriptable: browser/extension page?)' };
}

// Polls from here rather than in-page: hidden tabs throttle page timers (down to once a minute),
// and a navigation mid-wait would kill an in-page loop
export async function waitFor(tabId, p = {}) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
  const selector = p.ref != null ? refSelector(p.ref) : p.selector;
  const { text, urlContains } = p;
  if (!selector && !text && !urlContains) return { error: 'wait_for needs selector, ref, text or url_contains' };
  const gone = !!p.gone;
  const timeout = Math.min(p.timeoutMs ?? 10000, WAIT_MAX_MS);
  const want = [selector && `selector ${selector}`, text && `text "${text}"`, urlContains && `url containing "${urlContains}"`].filter(Boolean).join(' and ');
  const t0 = Date.now();
  let last = {};
  for (;;) {
    try {
      const url = (await chrome.tabs.get(tabId)).url || '';
      const probe = selector || text ? await isolated(tabId, waitProbe, [{ selector, text }]) : {};
      if (probe?.error) return { error: probe.error };
      last = { ...(probe || {}), ...(urlContains ? { url: url.includes(urlContains) } : {}) };
      // url is never inverted by `gone`: it's a "navigated there" condition
      const ok = (!selector || last.selector === !gone) && (!text || last.text === !gone) && (!urlContains || last.url);
      if (ok) return { ok: true, matched: `${gone ? 'gone: ' : ''}${want}`, elapsedMs: Date.now() - t0, url };
    } catch (e) {
      if (/No tab with id/.test(e.message)) return { error: e.message };
      // page mid-navigation (frame gone / not yet scriptable): keep polling
    }
    if (Date.now() - t0 >= timeout) return { error: `timed out after ${timeout}ms waiting for ${gone ? 'gone: ' : ''}${want}`, last, elapsedMs: Date.now() - t0 };
    await sleep(WAIT_POLL_MS);
  }
}

// Debugger path: DOM.setFileInputFiles with real paths (any size, fires input + change).
// Fallback when another extension's frame blocks the debugger: p.files = [{name, type, b64}] sent by the server
export async function uploadFiles(tabId, p = {}) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
  const selector = p.ref != null ? refSelector(p.ref) : p.selector;
  if (!selector) return { error: 'upload needs ref or selector of the file input' };
  if (!Array.isArray(p.paths) || !p.paths.length) return { error: 'paths required' };
  try {
    return await withDebugger(tabId, async (cmd) => {
      const r = await cmd('Runtime.evaluate', { expression: `(${uploadTarget})(${JSON.stringify(selector)})`, returnByValue: false });
      if (r.result.type === 'string') return { error: r.result.value };
      try {
        await cmd('DOM.setFileInputFiles', { files: p.paths, objectId: r.result.objectId });
      } finally {
        cmd('Runtime.releaseObject', { objectId: r.result.objectId }).catch(() => {});
      }
      return { ok: true, uploaded: p.paths.length, mode: 'debugger' };
    });
  } catch (e) {
    if (!isForeignFrameError(e)) return { error: e.message };
  }
  if (!Array.isArray(p.files) || !p.files.length) {
    return { error: "Debugger blocked by another extension's frame, and the files are too large for the in-page fallback (700KB total)" };
  }
  const r = await inPage(tabId, setInputFiles, [selector, p.files]);
  return r === 'ok' ? { ok: true, uploaded: p.files.length, mode: "in-page (debugger blocked by another extension's frame)" } : { error: r };
}
