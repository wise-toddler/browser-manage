// Run: node extension/tracking.test.mjs
// Decision log + domain stats under bulk tab closes: no lost writes, reads flush the queue first, log capped.
import assert from 'node:assert';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => sleep(Math.random() * 4);
const store = {};
const on = {};
const event = name => ({ addListener: fn => { on[name] = fn; } });
globalThis.chrome = {
  runtime: { getURL: p => `chrome-extension://test/${p}` },
  debugger: { onDetach: event('detach') },
  // In-memory async storage with random delays, so unserialized read-modify-writes would interleave and lose entries
  storage: { local: {
    get: async (keys, cb) => {
      await jitter();
      const r = {};
      for (const k of [].concat(keys)) if (k in store) r[k] = structuredClone(store[k]);
      cb?.(r);
      return r;
    },
    set: async items => { await jitter(); Object.assign(store, structuredClone(items)); },
  } },
  tabs: {
    onCreated: event('created'), onActivated: event('activated'), onRemoved: event('removed'), onUpdated: event('updated'),
    query: async (q, cb) => { await jitter(); cb?.([]); return []; },
  },
};

const { markExtensionClosing, getDecisionLog, getDomainStats, recordCleanupResult } = await import('./src/tracking.js');
await sleep(20); // initial tabTracking load + backfill

const domains = ['a.com', 'b.com', 'c.com'];
const open = (id, d = domains[id % 3]) => on.created({ id, url: `https://${d}/${id}` });

// 30 tabs closed at once, with a read (and its flush) in flight between two halves of the burst
for (let i = 0; i < 30; i++) open(i);
markExtensionClosing([0, 1, 2]);
for (let i = 0; i < 15; i++) on.removed(i);
const midRead = getDecisionLog();
await sleep(1);
for (let i = 15; i < 30; i++) on.removed(i);
const [mid, log, stats] = await Promise.all([midRead, getDecisionLog(), getDomainStats()]);
assert.ok(mid.length >= 15, 'a read sees everything queued before it');
assert.strictEqual(log.length, 30);
assert.strictEqual(log.filter(d => d.source === 'extension').length, 3);
for (const d of domains) {
  assert.strictEqual(log.filter(e => e.domain === d).length, 10);
  assert.deepStrictEqual([stats[d].totalClosed, stats[d].decisionCount], [10, 10]);
}
assert.deepStrictEqual(log.filter(e => e.domain === 'a.com').map(e => e.features.domainTabCount), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);

// Cleanup 'kept' results are written before recordCleanupResult returns
open(100, 'keep.com');
await recordCleanupResult([{ tabId: 100, domain: 'keep.com' }]);
assert.strictEqual(store.domainStats['keep.com'].totalKept, 1);

// 600 closes: flushed eagerly (well before the 250ms debounce), stats count all, log keeps the newest 500
for (let i = 1000; i < 1600; i++) open(i, 'big.com');
for (let i = 1000; i < 1600; i++) on.removed(i);
await sleep(100);
assert.strictEqual(store.decisionLog.length, 500, 'eager flush wrote without waiting for the debounce');
const capped = await getDecisionLog();
assert.deepStrictEqual([capped[0].features.domainTabCount, capped[499].features.domainTabCount], [500, 1]);
assert.strictEqual((await getDomainStats())['big.com'].totalClosed, 600);

console.log('tracking decision queue OK');
process.exit(0); // the 5s tabTracking persist debounce would otherwise keep node alive
