// Run: node extension/registry.test.mjs
// Imports the service worker modules against a minimal chrome stub; checks the action registry and the focus gate.
import assert from 'node:assert';

const calls = [];
const listener = () => ({ addListener() {} });
const storage = {};
globalThis.chrome = {
  runtime: {
    connectNative: () => ({ postMessage() {}, onMessage: listener(), onDisconnect: listener() }),
    onMessage: listener(),
    reload() {},
  },
  storage: { local: {
    get: (k, cb) => { const r = typeof k === 'string' && k in storage ? { [k]: storage[k] } : {}; cb?.(r); return Promise.resolve(r); },
    set: async () => {},
  } },
  tabs: {
    onCreated: listener(), onActivated: listener(), onRemoved: listener(), onUpdated: listener(),
    query: (q, cb) => { cb?.([]); return Promise.resolve([]); },
    update: async (id, props) => { calls.push(['tabs.update', id, props]); return { id, windowId: 1 }; },
    create: async (props) => { calls.push(['tabs.create', props]); return { id: 99 }; },
    get: async id => ({ id, windowId: 1, url: id === 6 ? 'edge://settings/system/managePerformance' : 'https://example.com/' }),
  },
  windows: {
    get: async id => ({ id }),
    getAll: async () => [{ id: 2, type: 'normal' }, { id: 1, focused: true, type: 'normal' }],
    update: async (id, props) => { calls.push(['windows.update', id, props]); },
  },
  alarms: { create() {}, onAlarm: listener() },
  debugger: { onDetach: listener(), onEvent: listener() },
  tabGroups: { query: async () => [] },
};

const { ACTIONS, dispatch } = await import('./src/main.js');

// Every action the old background.js handled (native switch + popup listener)
const OLD_NATIVE = ['ping', 'getTabs', 'getTabsWithMemory', 'getTabMetrics', 'closeTabs', 'action', 'reloadExtension',
  'screenshot', 'runScript', 'getScriptInfo', 'openTabs', 'createGroup', 'addToGroup', 'previewChanges', 'applyChanges',
  'getTabActivity', 'getStaleTabs', 'getDecisionLog', 'getDomainStats', 'getTabTracking', 'recordCleanupResult'];
const OLD_POPUP = ['getPendingChanges', 'updatePendingChanges', 'applyChanges', 'getTabs', 'getTabsWithMemory',
  'getDecisionLog', 'getDomainStats', 'getTabTracking'];
for (const a of new Set([...OLD_NATIVE, ...OLD_POPUP])) assert(typeof ACTIONS[a] === 'function', `missing action ${a}`);
assert.deepStrictEqual(await dispatch('ping'), 'pong');
assert.match((await dispatch('nope')).error, /Unknown action: nope/);

const native = { source: 'native' }, popup = { source: 'popup' };
const focusCalls = () => calls.filter(([what, , props]) => (what === 'tabs.update' && props?.active) || (what === 'windows.update' && props?.focused));

// activate: refused for agents unless allowFocus, allowed for agents that opt in and for the popup
calls.length = 0;
let r = await dispatch('action', { tabId: 5, action: 'activate' }, native);
assert.match(r.error, /allow_focus=true/);
assert.strictEqual(focusCalls().length, 0, 'refused activate must not touch focus');
r = await dispatch('action', { tabId: 5, action: 'activate', allowFocus: true }, native);
assert.deepStrictEqual(r, { ok: true });
calls.length = 0;
r = await dispatch('action', { tabId: 5, action: 'activate' }, popup);
assert.deepStrictEqual(r, { ok: true });
assert.strictEqual(focusCalls().length, 2);

// openTabs active=true: refused for agents, background open still fine
calls.length = 0;
r = await dispatch('openTabs', { urls: ['https://example.com/'], active: true }, native);
assert.match(r.error, /allow_focus=true/);
assert.strictEqual(calls.length, 0);
r = await dispatch('openTabs', { urls: ['https://example.com/'] }, native);
assert.deepStrictEqual({ opened: r.opened, tabIds: r.tabIds }, { opened: 1, tabIds: [99] });
assert.strictEqual(r.tabs[0].tabId, 99);
assert.strictEqual(focusCalls().length, 0);
// Opens in the focused normal window, not just the first one listed
assert.strictEqual(calls.find(([w]) => w === 'tabs.create')[1].windowId, 1);

// Browser pages: openTabs passes any scheme through; in-page actions get a clear refusal, tab-level ones still run
r = await dispatch('openTabs', { urls: ['edge://settings/system/managePerformance'] }, native);
assert.strictEqual(r.opened, 1);
for (const [a, p] of [['screenshot', {}], ['readPage', {}], ['runScript', { code: '1' }], ['action', { action: 'click', ref: 1 }]]) {
  r = await dispatch(a, { tabId: 6, ...p }, native);
  assert.ok(r.browserPage && /browser page/.test(r.error), `${a} on edge:// should be refused clearly`);
}
calls.length = 0;
r = await dispatch('action', { tabId: 6, action: 'navigate', url: 'https://example.com/' }, native);
assert.ok(!r.browserPage, 'navigating away from a browser page is allowed');
const { isBrowserPage } = await import('./src/util.js');
assert.deepStrictEqual(['edge://newtab/', 'chrome://settings', 'about:blank', 'https://chromewebstore.google.com/detail/x', 'https://github.com/'].map(isBrowserPage),
  [true, true, false, true, false]);

// P1 page actions
for (const a of ['readPage', 'findInPage', 'getPageText', 'waitFor', 'uploadFiles']) assert(typeof ACTIONS[a] === 'function', `missing action ${a}`);

console.log(`registry OK (${Object.keys(ACTIONS).length} actions, focus gate enforced)`);
