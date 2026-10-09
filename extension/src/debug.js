// Console + network capture for a tab over a pinned debugger session. CDP events are folded into
// per-tab ring buffers; the "debugging this browser" infobar stays visible while a capture is on
import { withDebugger, pin, unpin } from './cdp.js';
import { isForeignFrameError, sleep } from './util.js';

export const DEBUG_BUFFER_CAP = 500;
const BODY_CAP = 20000;
const LOAD_WAIT_MS = 10000;
const DURATION_MAX_MS = 60000;
// tabId -> capture. A stopped capture keeps its buffers (active=false) so it can still be read after the
// session is released and the infobar is gone; it's replaced by the next start, dropped when the tab closes
const captures = new Map();

export function newCapture(now = Date.now()) {
  return { startedAt: now, active: true, console: [], network: new Map(), dropped: { console: 0, network: 0 } };
}

// Not the page's own output: other extensions' scripts, DevTools hook banners, and the browser's
// interventions / tracking-prevention notices
const EXTENSION_URL = /^(chrome-extension|extension|moz-extension):\/\//;
const NOISE_TEXT = /React DevTools|Redux DevTools|__REACT_DEVTOOLS|Tracking Prevention/i;
export function isPageMessage(e) {
  if (EXTENSION_URL.test(e.url || '')) return false;
  if (e.source === 'intervention') return false;
  return !NOISE_TEXT.test(e.text || '');
}

// One console argument (a CDP RemoteObject) as readable text
function formatArg(a) {
  if (!a) return '';
  if ('value' in a) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  if (a.unserializableValue) return a.unserializableValue;
  const props = a.preview?.properties;
  if (props?.length) {
    const body = props.map(p => (a.subtype === 'array' ? '' : `${p.name}: `) + (p.type === 'string' ? JSON.stringify(p.value) : p.value)).join(', ');
    const more = a.preview.overflow ? ', …' : '';
    return a.subtype === 'array' ? `[${body}${more}]` : `{${body}${more}}`;
  }
  return a.description || a.type || '';
}

function pushConsole(cap, entry) {
  cap.console.push(entry);
  if (cap.console.length > DEBUG_BUFFER_CAP) { cap.console.shift(); cap.dropped.console++; }
}

function netEntry(cap, id, now) {
  let e = cap.network.get(id);
  if (!e) {
    e = { requestId: id, ts: now };
    cap.network.set(id, e);
    if (cap.network.size > DEBUG_BUFFER_CAP) {
      cap.network.delete(cap.network.keys().next().value);
      cap.dropped.network++;
    }
  }
  return e;
}

// Pure: fold one CDP event into a capture. Returns true if the event was one we track
export function reduceEvent(cap, method, params, now = Date.now()) {
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const level = params.type === 'warning' ? 'warning' : (params.type === 'error' || params.type === 'assert') ? 'error' : params.type;
      // First non-extension frame: another extension wrapping console.* puts its own frame on top of the page's call
      const frames = params.stackTrace?.callFrames || [];
      const frame = frames.find(f => !EXTENSION_URL.test(f.url || '')) || frames[0];
      pushConsole(cap, { ts: params.timestamp || now, level, source: 'console', text: (params.args || []).map(formatArg).join(' '), url: frame?.url, line: frame ? frame.lineNumber + 1 : undefined });
      return true;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails || {};
      pushConsole(cap, { ts: params.timestamp || now, level: 'error', source: 'exception', text: d.exception?.description || d.text || 'Uncaught exception', url: d.url, line: d.lineNumber != null ? d.lineNumber + 1 : undefined });
      return true;
    }
    case 'Log.entryAdded': {
      const e = params.entry || {};
      pushConsole(cap, { ts: e.timestamp || now, level: e.level, source: e.source, text: e.text, url: e.url, line: e.lineNumber != null ? e.lineNumber + 1 : undefined });
      return true;
    }
    case 'Network.requestWillBeSent': {
      const e = netEntry(cap, params.requestId, now);
      if (params.redirectResponse) e.redirects = (e.redirects || 0) + 1; // same requestId reused for the hop
      Object.assign(e, { method: params.request?.method, url: params.request?.url, type: params.type, ts: params.wallTime ? params.wallTime * 1000 : now, _t0: params.timestamp });
      delete e.status; delete e.error;
      return true;
    }
    case 'Network.responseReceived': {
      const e = netEntry(cap, params.requestId, now);
      const r = params.response || {};
      Object.assign(e, { status: r.status, statusText: r.statusText, mime: r.mimeType, type: e.type || params.type, url: e.url || r.url });
      if (r.fromDiskCache || r.fromServiceWorker) e.cached = true;
      return true;
    }
    case 'Network.loadingFinished': {
      const e = netEntry(cap, params.requestId, now);
      e.size = params.encodedDataLength;
      if (e._t0 != null) e.durationMs = Math.round((params.timestamp - e._t0) * 1000);
      return true;
    }
    case 'Network.loadingFailed': {
      const e = netEntry(cap, params.requestId, now);
      e.error = params.blockedReason ? `blocked: ${params.blockedReason}` : params.errorText;
      if (params.canceled) e.canceled = true;
      if (e._t0 != null) e.durationMs = Math.round((params.timestamp - e._t0) * 1000);
      return true;
    }
  }
  return false;
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  const cap = captures.get(tabId);
  if (cap?.active) reduceEvent(cap, method, params || {});
});

// User hit Cancel on the infobar or the session dropped: capture ends, what it recorded stays readable
chrome.debugger.onDetach.addListener(({ tabId }) => {
  const cap = captures.get(tabId);
  if (cap?.active) { cap.active = false; cap.endedAt = Date.now(); }
});
chrome.tabs.onRemoved.addListener(tabId => { captures.delete(tabId); });

const BLOCKED = "Console/network capture needs the debugger, which this tab refuses because another extension has a frame in it";

async function waitComplete(tabId) {
  const end = Date.now() + LOAD_WAIT_MS;
  while (Date.now() < end) {
    try { if ((await chrome.tabs.get(tabId)).status === 'complete') return; } catch { return; }
    await sleep(150);
  }
}

function status(tabId) {
  const cap = captures.get(tabId);
  if (!cap) return { capturing: false };
  const s = { capturing: cap.active, startedAt: cap.startedAt, console: cap.console.length, network: cap.network.size, dropped: cap.dropped };
  if (!cap.active) s.endedAt = cap.endedAt;
  return s;
}

async function start(tabId, reload, durationMs) {
  if (captures.get(tabId)?.active) return { ...status(tabId), already: true };
  try {
    await pin(tabId);
  } catch (e) {
    return { error: isForeignFrameError(e) ? BLOCKED : e.message };
  }
  // Buffer before enabling: Runtime.enable replays console messages logged so far, Log.enable its entries
  captures.set(tabId, newCapture());
  try {
    await withDebugger(tabId, async cmd => {
      await cmd('Runtime.enable');
      await cmd('Log.enable');
      await cmd('Network.enable', { maxPostDataSize: 0 });
      if (reload) await cmd('Page.reload', { ignoreCache: false });
    });
  } catch (e) {
    captures.delete(tabId);
    unpin(tabId);
    return { error: isForeignFrameError(e) ? BLOCKED : e.message };
  }
  if (reload) { await sleep(300); await waitComplete(tabId); }
  if (!durationMs) return { ...status(tabId), started: true, reloaded: !!reload };
  // One-shot: record for durationMs, then release the session so the infobar goes away; buffers stay readable
  await sleep(Math.min(durationMs, DURATION_MAX_MS));
  await stop(tabId);
  return { ...status(tabId), started: true, reloaded: !!reload, stopped: true, durationMs: Math.min(durationMs, DURATION_MAX_MS) };
}

async function stop(tabId) {
  const cap = captures.get(tabId);
  if (!cap?.active) return { capturing: false, stopped: false };
  cap.active = false;
  cap.endedAt = Date.now();
  try { await withDebugger(tabId, async cmd => { await cmd('Network.disable'); await cmd('Log.disable'); }); } catch {}
  unpin(tabId);
  return { capturing: false, stopped: true, console: cap.console.length, network: cap.network.size };
}

export async function debugCapture(tabId, { mode = 'status', reload = false, durationMs = 0 } = {}) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
  if (mode === 'start') return start(tabId, reload, Number(durationMs) > 0 ? Number(durationMs) : 0);
  if (mode === 'stop') return stop(tabId);
  return status(tabId);
}

// Reading a tab with no capture starts one (that read is necessarily near empty); a stopped capture is
// read as-is, without restarting it
async function ensure(tabId) {
  if (captures.has(tabId)) return { cap: captures.get(tabId), started: false };
  const r = await start(tabId, false);
  if (r.error) return { error: r.error };
  return { cap: captures.get(tabId), started: true };
}

const STOPPED_NOTE = 'Capture is stopped: showing what it recorded. browser_debug action=start begins a new one.';

function matcher(pattern) {
  if (!pattern) return () => true;
  try { const re = new RegExp(pattern, 'i'); return s => re.test(s || ''); }
  catch { const p = pattern.toLowerCase(); return s => (s || '').toLowerCase().includes(p); }
}

const STARTED_NOTE = 'Capture started just now: only what was logged before this (console) is here. Reproduce, then read again.';

export async function readConsole(tabId, { pattern, onlyErrors = false, limit = 100, clear = false, pageOnly = true } = {}) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
  const { cap, started, error } = await ensure(tabId);
  if (error) return { error };
  const m = matcher(pattern);
  const own = pageOnly ? cap.console.filter(isPageMessage) : cap.console;
  const hits = own.filter(e => (!onlyErrors || e.level === 'error') && (m(e.text) || m(e.url)));
  const out = { total: cap.console.length, matched: hits.length, dropped: cap.dropped.console, messages: hits.slice(-limit) };
  if (pageOnly) out.hiddenNoise = cap.console.length - own.length;
  if (started) out.note = STARTED_NOTE;
  else if (!cap.active) out.note = STOPPED_NOTE;
  if (clear) cap.console = [];
  return out;
}

function decodeBody(body, base64, mime) {
  if (!base64) return { body };
  if (/^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded))|\+json|\+xml/.test(mime || '')) {
    try { return { body: new TextDecoder().decode(Uint8Array.from(atob(body), c => c.charCodeAt(0))) }; } catch {}
  }
  return { body, base64: true };
}

export async function readNetwork(tabId, { urlPattern, onlyFailed = false, limit = 100, clear = false, requestId } = {}) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
  const { cap, started, error } = await ensure(tabId);
  if (error) return { error };
  if (requestId) {
    if (!cap.active) return { error: 'Capture is stopped, and the browser drops response bodies with it. Start a capture (browser_debug action=start) and repeat the request.' };
    const e = cap.network.get(requestId);
    try {
      const r = await withDebugger(tabId, cmd => cmd('Network.getResponseBody', { requestId }));
      const { body, base64 } = decodeBody(r.body, r.base64Encoded, e?.mime);
      return { requestId, url: e?.url, status: e?.status, mime: e?.mime, base64: !!base64, length: body.length, truncated: body.length > BODY_CAP, body: body.slice(0, BODY_CAP) };
    } catch (err) {
      return { error: `no body for ${requestId}: ${err.message}` };
    }
  }
  const all = [...cap.network.values()];
  const hits = all.filter(e => (!urlPattern || (e.url || '').includes(urlPattern)) && (!onlyFailed || e.error || e.status >= 400));
  const out = { total: all.length, matched: hits.length, dropped: cap.dropped.network, requests: hits.slice(-limit).map(({ _t0, ...e }) => e) };
  if (started) out.note = STARTED_NOTE.replace('(console)', '(nothing for network)');
  else if (!cap.active) out.note = STOPPED_NOTE + ' Response bodies are only available while capture is on.';
  if (clear) cap.network.clear();
  return out;
}
