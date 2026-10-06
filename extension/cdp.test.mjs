// Run: node extension/cdp.test.mjs
// Debugger session manager: shared attach, no detach under a concurrent caller, keep=false, timeout drop, error passthrough.
import assert from 'node:assert';

const log = [];
let onDetach;
let attachError = null;
globalThis.chrome = {
  debugger: {
    attach: async ({ tabId }) => { log.push(['attach', tabId]); if (attachError) throw attachError; },
    detach: async ({ tabId }) => { log.push(['detach', tabId]); },
    sendCommand: (t, method) => method === 'Hang' ? new Promise(() => {}) : Promise.resolve({ method }),
    onDetach: { addListener: fn => { onDetach = fn; } },
  },
};
const { withDebugger } = await import('./src/cdp.js');
const count = (what, tab) => log.filter(([w, t]) => w === what && t === tab).length;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Two concurrent callers on one tab share a single attach and neither detaches the other
let release1;
const slow = withDebugger(1, cmd => new Promise(r => { release1 = r; }).then(() => cmd('A')));
const fast = withDebugger(1, cmd => cmd('B'));
assert.deepStrictEqual(await fast, { method: 'B' });
await sleep(5);
assert.strictEqual(count('attach', 1), 1);
assert.strictEqual(count('detach', 1), 0, 'fast caller must not detach under the slow one');
release1();
assert.deepStrictEqual(await slow, { method: 'A' });
assert.strictEqual(count('detach', 1), 0, 'kept for reuse until idle');
await withDebugger(1, cmd => cmd('C'));
assert.strictEqual(count('attach', 1), 1, 'reused, not re-attached');

// keep=false detaches right away
await withDebugger(2, cmd => cmd('X'), { keep: false });
assert.strictEqual(count('detach', 2), 1);

// A timed-out command drops the session
await assert.rejects(withDebugger(3, cmd => cmd('Hang', {}, 20)), /Hang timed out after 20ms/);
assert.strictEqual(count('detach', 3), 1);

// Attach errors (e.g. another extension's frame) propagate; a later call retries the attach
attachError = new Error('Cannot access a chrome-extension:// URL of different extension');
await assert.rejects(withDebugger(4, cmd => cmd('Y')), /different extension/);
attachError = null;
await withDebugger(4, cmd => cmd('Y'));
assert.strictEqual(count('attach', 4), 2);

// "Already attached" (worker restarted while Chrome kept our attachment) is adopted
attachError = new Error('Another debugger is already attached to the tab with id: 5.');
assert.deepStrictEqual(await withDebugger(5, cmd => cmd('Z')), { method: 'Z' });
attachError = null;

// External detach (user cancelled the infobar) forgets the session; next call attaches fresh
onDetach({ tabId: 1 });
await withDebugger(1, cmd => cmd('D'));
assert.strictEqual(count('attach', 1), 2);

console.log('cdp session manager OK');
process.exit(0); // idle-detach timers would otherwise keep node alive for 30s
