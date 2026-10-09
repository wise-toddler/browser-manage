// Run: node extension/capture.test.mjs   (needs Google Chrome; CHROME=/path overrides)
// Drives the real capture/viewport/actions modules against a throwaway headless Chrome with two tabs: tab 1 is a
// normal (visible) target, tab 2 a background target, which Chrome reports as hidden and which reproduces the
// hidden-tab input hang. chrome.debugger is stubbed onto per-target CDP sessions. Never touches the user's browser.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log('SKIP capture.test: Chrome not found'); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'bm-capture-test-'));
const page = join(dir, 'page.html');
writeFileSync(page, `<!doctype html><html><head><title>Capture</title><style>
  body { margin: 0; height: 20000px; } div { box-sizing: border-box; }
  #hero { position: absolute; left: 10px; top: 10px; width: 300px; height: 80px; background: #08c; }
  #far { position: absolute; left: 20px; top: 12000px; width: 200px; height: 100px; background: red; }
  #shell { position: absolute; left: 0; top: 120px; width: 400px; height: 300px; overflow: auto; }
  #shell .pad { height: 2000px; } #item { width: 150px; height: 40px; background: green; }
  :focus-visible { outline: 3px solid orange; }
</style></head><body>
<div id="hero"></div><div id="far"></div>
<div id="shell"><div class="pad"></div><div id="item" data-bm-ref="7"></div><div class="pad"></div></div>
<input id="k1" style="position:absolute;top:500px"><button id="k2" style="position:absolute;top:540px">B</button>
</body></html>`);

const port = await new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const chromeProc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=800,600', 'about:blank'], { stdio: 'ignore' });
let ws, cleaned = false;
const cleanup = () => {
  if (cleaned) return; cleaned = true;
  try { ws?.close(); } catch {}
  chromeProc.kill('SIGKILL');
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
};
process.on('exit', cleanup);

const png = b64 => { const b = Buffer.from(b64, 'base64'); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

try {
  let ver;
  for (let i = 0; i < 50 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const waiting = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const sessions = {};
  for (const [tab, background] of [[1, false], [2, true]]) {
    const { targetId } = await send('Target.createTarget', { url: 'file://' + page, background });
    sessions[tab] = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await send('Runtime.enable', {}, sessions[tab]);
  }
  const evaluate = (tab, expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessions[tab]).then(r => r.result.value);
  for (const tab of [1, 2]) for (let i = 0; i < 50 && (await evaluate(tab, 'document.readyState')) !== 'complete'; i++) await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(await evaluate(1, 'document.visibilityState'), 'visible');
  assert.strictEqual(await evaluate(2, 'document.visibilityState'), 'hidden', 'background target must be hidden for this test to mean anything');

  const detachListeners = [];
  let detaches = 0, fakeUrl = null;
  globalThis.chrome = {
    scripting: { executeScript: async ({ target, func, args }) => [{ result: await evaluate(target.tabId, `(${func})(...${JSON.stringify(args || [])})`) }] },
    debugger: {
      attach: async () => {}, detach: async () => { detaches++; },
      sendCommand: ({ tabId }, method, params) => send(method, params || {}, sessions[tabId]),
      onEvent: { addListener() {} }, onDetach: { addListener: fn => detachListeners.push(fn) },
    },
    tabs: { get: async id => ({ id, windowId: 1, active: id === 1, status: 'complete', url: fakeUrl || await evaluate(id, 'location.href') }) },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    windows: { get: async id => ({ id, state: 'normal' }) },
  };
  const { screenshotTab } = await import('./src/capture.js');
  const { setViewport, getViewportOverride } = await import('./src/viewport.js');
  const { doAction } = await import('./src/actions.js');
  const { runScript } = await import('./src/script.js');
  const shot = async (tab, p) => { const r = await screenshotTab(tab, { format: 'png', ...p }); assert.ifError(r.error); return { ...r, ...png(r.data) }; };
  const scrolls = tab => evaluate(tab, '({ y: scrollY, shell: document.getElementById("shell").scrollTop })');

  // Crops: visible tab, element on screen → straight off the frame, nothing scrolls
  await evaluate(1, 'scrollTo(0, 0)');
  let r = await shot(1, { selector: '#hero' });
  assert.deepStrictEqual([r.w, r.h], [300, 80]);
  assert.deepStrictEqual(await scrolls(1), { y: 0, shell: 0 });

  // Element far below the window fold (visible tab) and inside a scroll container (hidden tab): offscreen, scroll restored
  r = await shot(1, { selector: '#far' });
  assert.deepStrictEqual([r.w, r.h], [200, 100]);
  assert.deepStrictEqual(await scrolls(1), { y: 0, shell: 0 });
  await evaluate(2, 'scrollTo(0, 50)');
  r = await shot(2, { ref: 'ref_7' });
  assert.deepStrictEqual([r.w, r.h], [150, 40]);
  assert.deepStrictEqual(await scrolls(2), { y: 50, shell: 0 }, 'container and window scroll restored');
  r = await shot(2, { clip: { x: 10, y: 20, width: 100, height: 50 } });
  assert.deepStrictEqual([r.w, r.h], [100, 50]);
  assert.match((await screenshotTab(2, { selector: '#nope' })).error, /selector not found/);
  assert.match((await screenshotTab(2, { clip: { x: 0, y: 0, width: 0, height: 10 } })).error, /empty/);

  // Full page: 20000px in 8000px tiles
  r = await shot(2, { fullPage: true });
  assert.deepStrictEqual([r.pageHeight, r.tileY, r.tileHeight, r.truncated, r.h], [20000, 0, 8000, true, 8000]);
  r = await shot(2, { fullPage: true, tileY: 16000 });
  assert.deepStrictEqual([r.tileY, r.tileHeight, r.truncated, r.h], [16000, 4000, false, 4000]);
  assert.match((await screenshotTab(2, { fullPage: true, tileY: 20000 })).error, /past the page height/);

  // Viewport emulation on the hidden tab: innerWidth and screenshot size follow it; reset restores
  const original = await evaluate(1, 'innerWidth');
  for (const [w, h, dpr] of [[390, 844, 1], [768, 1024, 2], [1440, 900, 1]]) {
    const v = await setViewport(2, { width: w, height: h, dpr });
    assert.ifError(v.error);
    assert.deepStrictEqual([v.measured.width, v.measured.height, v.measured.dpr], [w, h, dpr]);
    assert.strictEqual(await evaluate(2, 'innerWidth'), w);
    r = await shot(2, {});
    assert.deepStrictEqual([r.w, r.h], [w * dpr, h * dpr], `hidden viewport ${w}x${h}@${dpr}`);
    assert.deepStrictEqual(r.viewport, { width: w, height: h, dpr, mobile: false });
  }
  r = await shot(2, { selector: '#hero' });
  assert.deepStrictEqual([r.w, r.h], [300, 80], 'crop under emulation');
  const m = await setViewport(2, { width: 390, height: 844, mobile: true });
  assert.strictEqual(m.measured.touch, true);
  assert.deepStrictEqual((await setViewport(2, {})).viewport, { width: 390, height: 844, dpr: 1, mobile: true }, 'status');
  assert.match((await setViewport(2, { width: 50, height: 50 })).error, /100\.\.5000/);
  // Visible tab: the plain capture path follows the override too
  await setViewport(1, { width: 1440, height: 900 });
  r = await shot(1, {});
  assert.deepStrictEqual([r.w, r.h], [1440, 900], 'visible viewport 1440x900');
  for (const tab of [1, 2]) {
    const before = detaches;
    const reset = await setViewport(tab, { reset: true });
    assert.strictEqual(reset.viewport, null);
    assert.strictEqual(getViewportOverride(tab), null);
    assert(detaches > before, 'reset releases the pinned session');
  }
  // Checked on the visible tab: a hidden headless target keeps its last layout size until it is shown again
  // (in Edge the hidden tab's innerWidth is back right after reset)
  assert.strictEqual(await evaluate(1, 'innerWidth'), original);
  assert.strictEqual(await evaluate(2, 'navigator.maxTouchPoints'), 0);
  // The user cancelling the infobar (onDetach) drops the override bookkeeping
  await setViewport(2, { width: 390, height: 844 });
  detachListeners.forEach(fn => fn({ tabId: 2 }));
  assert.strictEqual(getViewportOverride(2), null);
  await send('Emulation.clearDeviceMetricsOverride', {}, sessions[2]);

  // Keys on the hidden tab go through real CDP input (focus traversal + :focus-visible), not the DOM fallback
  await evaluate(2, 'document.getElementById("k1").focus(), 1');
  const tab = await doAction(2, { action: 'key', key: 'Tab', wait: 0 }, { source: 'native' });
  assert.strictEqual(tab.mode, 'cdp (tab hidden)');
  assert.strictEqual(await evaluate(2, 'document.activeElement.id + ":" + document.activeElement.matches(":focus-visible")'), 'k2:true');
  await doAction(2, { action: 'key', key: 'Shift+Tab', wait: 0 }, { source: 'native' });
  assert.strictEqual(await evaluate(2, 'document.activeElement.id'), 'k1');
  // Mouse-type actions on the hidden tab still take the DOM path
  assert.strictEqual((await doAction(2, { action: 'scroll', deltaY: 100, wait: 0 }, { source: 'native' })).mode, 'dom-fallback (tab hidden)');

  // run_script: last expression, top-level await/return, a promise result is settled, timeouts fire
  fakeUrl = 'https://test.local/'; // runScript only runs on http(s) pages; the file:// page stands in for one
  const run = (code, ms) => runScript(1, code, ms);
  assert.deepStrictEqual(await run('1 + 1'), { result: 2, type: 'number' });
  assert.deepStrictEqual(await run('const t = document.title; return t.length'), { result: 7, type: 'number' });
  assert.deepStrictEqual(await run('await Promise.resolve(4)'), { result: 4, type: 'number' });
  assert.deepStrictEqual(await run('Promise.resolve({ a: 1 })'), { result: { a: 1 }, type: 'object' });
  assert.deepStrictEqual(await run('({ n: [1, 2] })'), { result: { n: [1, 2] }, type: 'object' });
  assert.match((await run('Promise.reject(new Error("nope"))')).error, /nope/);
  assert.match((await run('new Promise(() => {})', 1000)).error, /timed out after 1000ms/);
  fakeUrl = null;

  console.log('capture.test OK (run_script return/await/promise/timeout, crop selector/ref/clip on visible+hidden with scroll restore, full-page tiles, viewport 390/768/1440 + mobile + reset, hidden-tab CDP keys)');
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
