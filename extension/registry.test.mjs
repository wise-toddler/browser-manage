// Run: node extension/registry.test.mjs
// Imports the service worker modules against a minimal chrome stub; checks the action registry and the focus gate.
import assert from 'node:assert';

const calls = [];
const listener = () => ({ addListener() {} });
const storage = { triageWindowId: 7 };
globalThis.chrome = {
  runtime: {
    getURL: p => `chrome-extension://test/${p}`,
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
    move: async (id, props) => { calls.push(['tabs.move', id, props]); },
    get: async id => ({ id, windowId: 1, url: 'https://example.com/' }),
  },
  windows: {
    get: async id => ({ id }),
    getAll: async () => [{ id: 1, focused: true, type: 'normal' }, { id: 7, type: 'normal' }],
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
  'getTabActivity', 'getStaleTabs', 'listSuspended', 'suspendTabs', 'unsuspendTabs', 'suspendWhitelist', 'getDecisionLog',
  'getDomainStats', 'getTabTracking', 'triageTabs', 'restoreFromTriage', 'listTriageTabs', 'recordCleanupResult'];
const OLD_POPUP = ['getPendingChanges', 'updatePendingChanges', 'applyChanges', 'getTabs', 'getTabsWithMemory',
  'suspendStaleTabs', 'getDecisionLog', 'getDomainStats', 'unsuspendCurrent', 'getTabTracking', 'triageTabs',
  'restoreFromTriage', 'listTriageTabs'];
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

// restoreFromTriage: agents get the move without the focus, the popup gets both
calls.length = 0;
r = await dispatch('restoreFromTriage', { tabIds: [3] }, native);
assert.deepStrictEqual(r, { restored: 1, windowId: 1 });
assert.ok(calls.some(([w]) => w === 'tabs.move'));
assert.strictEqual(focusCalls().length, 0, 'agent restore must not focus');
calls.length = 0;
await dispatch('restoreFromTriage', { tabIds: [3] }, popup);
assert.strictEqual(focusCalls().length, 2);

// P1 page actions
for (const a of ['readPage', 'findInPage', 'getPageText', 'waitFor', 'uploadFiles']) assert(typeof ACTIONS[a] === 'function', `missing action ${a}`);

console.log(`registry OK (${Object.keys(ACTIONS).length} actions, focus gate enforced)`);
