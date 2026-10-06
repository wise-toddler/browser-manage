// Run: node extension/page.test.mjs   (needs Google Chrome; CHROME=/path overrides)
// Drives the real read/actions/capture modules against a throwaway headless Chrome: chrome.scripting and
// chrome.debugger are stubbed onto one CDP connection to a local test page. Never touches the user's browser.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log('SKIP page.test: Chrome not found'); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'bm-page-test-'));
const page = join(dir, 'page.html');
writeFileSync(page, `<!doctype html><html><head><title>BM Test</title></head><body>
<h1>Test Page</h1>
<nav><a href="/home">Home</a> <a href="https://example.org/docs">Docs</a></nav>
<form id="login">
  <label for="email">Email</label> <input id="email" type="email" placeholder="you@example.com">
  <label><input id="remember" type="checkbox" checked> Remember me</label>
  <select id="team"><option>Infra</option><option selected>Apps</option></select>
  <textarea aria-label="Notes"></textarea>
  <button type="button" id="login-btn">Log in</button>
  <input id="file" type="file" multiple>
</form>
<div role="button" aria-label="Refresh dashboard" id="refresh">↻</div>
<div id="open-panel" style="cursor:pointer" onclick="window.opened=(window.opened||0)+1"><span>Open panel</span></div>
<div style="display:none"><button>Secret</button></div>
<span aria-hidden="true"><button>Ghost</button></span>
<div style="visibility:hidden"><button>Invisible</button></div>
<x-card id="card"></x-card>
<article><p>This article explains how browser-manage reads pages for agents, with stable refs and no focus changes.</p>
<p>Second paragraph of the article body, long enough to count as the main content of this page for page text.</p></article>
<div id="spinner">Loading…</div>
<script>
  window.clicks = 0; window.shadowClicks = 0; window.inputs = 0; window.changes = 0;
  document.getElementById('login-btn').addEventListener('click', () => window.clicks++);
  const f = document.getElementById('file');
  f.addEventListener('input', () => window.inputs++);
  f.addEventListener('change', () => { window.changes++; window.files = [...f.files].map(x => x.name + ':' + x.size); });
  customElements.define('x-card', class extends HTMLElement {
    constructor() { super(); const r = this.attachShadow({ mode: 'open' });
      r.innerHTML = '<button id="s">Shadow Save</button><input placeholder="Shadow input">';
      r.getElementById('s').addEventListener('click', () => window.shadowClicks++); }
  });
  setTimeout(() => { const d = document.createElement('div'); d.id = 'late'; d.textContent = 'Loaded later'; document.body.append(d); }, 1200);
  setTimeout(() => document.getElementById('spinner').remove(), 1500);
</script></body></html>`);

const port = await new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let ws;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return; cleaned = true;
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
  // Chrome may still be flushing its profile dir; leftovers in tmp are harmless
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
};
process.on('exit', cleanup);

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?file://${page}`, { method: 'PUT' })).json(); }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const waiting = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  for (let i = 0; i < 50 && (await evaluate('document.readyState')) !== 'complete'; i++) await new Promise(r => setTimeout(r, 100));

  const TAB = 1;
  let blockDebugger = false;
  const detachListeners = [];
  // Like Chrome dropping our attachment (e.g. another extension's frame appeared): cdp.js forgets the session
  const block = on => { blockDebugger = on; if (on) detachListeners.forEach(fn => fn({ tabId: TAB })); };
  const noop = () => ({ addListener() {} });
  globalThis.chrome = {
    scripting: { executeScript: async ({ func, args }) => [{ result: await evaluate(`(${func})(...${JSON.stringify(args || [])})`) }] },
    debugger: {
      attach: async () => { if (blockDebugger) throw new Error('Cannot access a chrome-extension:// URL of different extension'); },
      detach: async () => {}, sendCommand: (_t, method, params) => send(method, params), onEvent: noop(),
      onDetach: { addListener: fn => detachListeners.push(fn) },
    },
    tabs: { get: async id => ({ id, windowId: 1, active: true, status: 'complete', url: await evaluate('location.href') }) },
    windows: { get: async id => ({ id, state: 'normal' }) },
  };
  const { readPage, findInPage, getPageText, waitFor, uploadFiles } = await import('./src/read.js');
  const { doAction } = await import('./src/actions.js');
  const { screenshotTab } = await import('./src/capture.js');
  const { domAction } = await import('./src/page.js');
  const native = { source: 'native' };
  const refFor = (tree, needle) => { const l = tree.split('\n').find(x => x.includes(needle)); assert(l, `no line with ${needle}:\n${tree}`); return l.match(/\[ref=(\d+)\]/)[1]; };

  // read_page, interactive
  let r = await readPage(TAB, {});
  assert.ifError(r.error);
  const t = r.tree;
  for (const want of ['link "Home"', 'link "Docs"', 'textbox "Email"', 'placeholder="you@example.com"', 'checkbox "Remember me"', 'checked',
    'combobox', 'value="Apps"', 'textbox "Notes"', 'button "Log in"', 'fileinput', 'button "Refresh dashboard"', 'clickable "Open panel"',
    'button "Shadow Save"', 'textbox [ref=', 'placeholder="Shadow input"']) assert(t.includes(want), `missing ${want}:\n${t}`);
  for (const no of ['Secret', 'Ghost', 'Invisible', 'Test Page']) assert(!t.includes(no), `should not list ${no}:\n${t}`);
  assert.match(t, /link "Docs" \[ref=\d+\] href="https:\/\/example.org\/docs"/);
  assert.strictEqual(r.title, 'BM Test');
  const loginRef = refFor(t, 'button "Log in"');
  assert.strictEqual(refFor((await readPage(TAB, {})).tree, 'button "Log in"'), loginRef, 'refs must be stable across reads');

  // filter=all: headings/text, no double-listed button text, hidden still excluded
  const all = (await readPage(TAB, { filter: 'all' })).tree;
  assert(all.includes('heading "Test Page" [ref=') && all.includes('level=1'), all);
  assert(all.includes('paragraph "This article explains'), all);
  assert.strictEqual(all.split('\n').filter(l => l.includes('Log in')).length, 1, 'button text must not repeat as text lines');
  assert(!all.includes('Secret'));

  // ref subtree + truncation
  const formRef = refFor(all, 'form');
  const sub = (await readPage(TAB, { ref: formRef })).tree;
  assert(sub.includes('textbox "Email"') && !sub.includes('link "Home"'), sub);
  const small = await readPage(TAB, { maxChars: 120 });
  assert(small.truncated && small.chars > 120 && small.tree.length <= 120, JSON.stringify(small).slice(0, 300));
  assert.match((await readPage(TAB, { ref: 99999 })).error, /ref 99999 not found/);

  // find
  const top = async q => (await findInPage(TAB, q)).lines[0];
  assert.match(await top('login button'), /^button "Log in"/);
  assert.match(await top('email'), /^textbox "Email"/);
  assert.match(await top('shadow save'), /^button "Shadow Save"/);
  assert.match(await top('refresh'), /Refresh dashboard/);
  assert.strictEqual((await findInPage(TAB, 'zzzz nothing')).lines.length, 0);

  // page text
  const pt = await getPageText(TAB, 50000);
  assert.strictEqual(pt.source, 'article');
  assert(pt.text.includes('stable refs and no focus changes') && !pt.text.includes('Log in'), pt.text);
  assert((await getPageText(TAB, 40)).truncated);

  // actions by ref: CDP path (visible headless tab), shadow DOM included; click reports `at`
  r = await doAction(TAB, { action: 'click', ref: `ref_${loginRef}`, wait: 0 }, native);
  assert(r.ok && r.at && typeof r.at.x === 'number', JSON.stringify(r));
  assert.strictEqual(await evaluate('window.clicks'), 1);
  const shadowRef = refFor(t, 'button "Shadow Save"');
  r = await doAction(TAB, { action: 'click', ref: Number(shadowRef), wait: 0 }, native);
  assert(r.ok, JSON.stringify(r)); assert.strictEqual(await evaluate('window.shadowClicks'), 1);
  r = await doAction(TAB, { action: 'type', ref: refFor(t, 'textbox "Email"'), text: 'a@b.co', wait: 0 }, native);
  assert(r.ok, JSON.stringify(r)); assert.strictEqual(await evaluate("document.getElementById('email').value"), 'a@b.co');
  assert.match((await doAction(TAB, { action: 'click', ref: 424242, wait: 0 }, native)).error, /ref 424242 not found/);
  // DOM fallback (hidden tabs / blocked debugger) resolves refs inside shadow roots too
  assert.strictEqual(await evaluate(`(${domAction})(${JSON.stringify({ action: 'click', selector: `[data-bm-ref="${shadowRef}"]` })})`), 'ok');
  assert.strictEqual(await evaluate('window.shadowClicks'), 2);
  r = await (async () => { block(true); try { return await doAction(TAB, { action: 'click', ref: loginRef, wait: 0 }, native); } finally { block(false); } })();
  assert(r.ok && /debugger blocked/.test(r.mode), JSON.stringify(r)); assert.strictEqual(await evaluate('window.clicks'), 2);

  // upload: debugger path with real paths, then the in-page fallback with base64 when the debugger is blocked
  const fileRef = refFor(t, 'fileinput');
  const f1 = join(dir, 'a.txt'), f2 = join(dir, 'b.csv');
  writeFileSync(f1, 'hello'); writeFileSync(f2, 'x,y\n1,2\n');
  r = await uploadFiles(TAB, { ref: fileRef, paths: [f1, f2] });
  assert(r.ok && r.mode === 'debugger', JSON.stringify(r));
  assert.deepStrictEqual(await evaluate('window.files'), ['a.txt:5', 'b.csv:8']);
  assert.strictEqual(await evaluate('window.changes'), 1); assert(await evaluate('window.inputs') >= 1);
  block(true);
  r = await uploadFiles(TAB, { selector: '#file', paths: [f1], files: [{ name: 'c.txt', type: 'text/plain', b64: Buffer.from('fallback!').toString('base64') }] });
  assert(r.ok && /in-page/.test(r.mode), JSON.stringify(r));
  assert.deepStrictEqual(await evaluate('window.files'), ['c.txt:9']); assert.strictEqual(await evaluate('window.changes'), 2);
  assert.match((await uploadFiles(TAB, { selector: '#file', paths: [f1] })).error, /too large for the in-page fallback/);
  block(false);
  assert.match((await uploadFiles(TAB, { selector: '#email', paths: [f1] })).error, /not a file input/);

  // wait_for (page adds #late at 1.2s, removes #spinner at 1.5s; timings are from page load)
  r = await waitFor(TAB, { selector: '#late', timeoutMs: 5000 }); assert(r.ok, JSON.stringify(r));
  r = await waitFor(TAB, { selector: '#spinner', gone: true, timeoutMs: 5000 }); assert(r.ok, JSON.stringify(r));
  r = await waitFor(TAB, { text: 'Loaded later', urlContains: 'page.html' }); assert(r.ok && r.matched.includes('url'), JSON.stringify(r));
  const t0 = Date.now();
  r = await waitFor(TAB, { selector: '#never', timeoutMs: 600 });
  assert(/timed out after 600ms/.test(r.error) && Date.now() - t0 < 2000, JSON.stringify(r));
  assert.match((await waitFor(TAB, {})).error, /needs selector/);

  // screenshots report dpr
  r = await screenshotTab(TAB, {});
  assert(r.data && typeof r.dpr === 'number', JSON.stringify({ ...r, data: r.data && r.data.length }));

  console.log('page.test OK (read_page, find, page text, ref actions incl. shadow DOM + fallback, upload x2, wait_for, dpr)');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  cleanup();
}
process.exit(process.exitCode ?? 0);
