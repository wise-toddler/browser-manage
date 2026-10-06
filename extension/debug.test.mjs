// Run: node extension/debug.test.mjs
// Folds fake CDP events through the console/network reducer; no browser needed.
import assert from 'node:assert';

const listener = () => ({ addListener() {} });
globalThis.chrome = { debugger: { onDetach: listener(), onEvent: listener() }, tabs: {}, scripting: {} };

const { newCapture, reduceEvent, DEBUG_BUFFER_CAP } = await import('./src/debug.js');

const cap = newCapture(0);
const str = v => ({ type: 'string', value: v });

// Console: mixed args, object preview, warning/assert levels, stack location
reduceEvent(cap, 'Runtime.consoleAPICalled', { type: 'log', timestamp: 1, args: [str('hello'), { type: 'number', value: 42 },
  { type: 'object', description: 'Object', preview: { properties: [{ name: 'a', type: 'number', value: '1' }, { name: 'b', type: 'string', value: 'x' }] } }],
  stackTrace: { callFrames: [{ url: 'https://t/app.js', lineNumber: 9 }] } });
reduceEvent(cap, 'Runtime.consoleAPICalled', { type: 'warning', args: [str('careful')] });
reduceEvent(cap, 'Runtime.consoleAPICalled', { type: 'assert', args: [str('nope')] });
reduceEvent(cap, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'object', subtype: 'array', description: 'Array(2)', preview: { properties: [{ name: '0', type: 'number', value: '1' }, { name: '1', type: 'number', value: '2' }] } }] });
reduceEvent(cap, 'Runtime.exceptionThrown', { timestamp: 5, exceptionDetails: { text: 'Uncaught', url: 'https://t/x.js', lineNumber: 2, exception: { description: 'TypeError: boom\n    at x.js:3' } } });
reduceEvent(cap, 'Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource: 404', url: 'https://t/missing.png' } });
assert.deepStrictEqual(cap.console.map(e => e.level), ['log', 'warning', 'error', 'log', 'error', 'error']);
assert.strictEqual(cap.console[0].text, 'hello 42 {a: 1, b: "x"}');
assert.strictEqual(cap.console[0].line, 10);
assert.strictEqual(cap.console[3].text, '[1, 2]');
assert.match(cap.console[4].text, /TypeError: boom/);
assert.strictEqual(cap.console[4].source, 'exception');
assert.strictEqual(cap.console[5].source, 'network');

// Network: full lifecycle, redirect reuse of the requestId, failure, response for an unseen id
reduceEvent(cap, 'Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'https://t/api' }, type: 'Fetch', timestamp: 10, wallTime: 1000 });
reduceEvent(cap, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, statusText: 'OK', mimeType: 'application/json' } });
reduceEvent(cap, 'Network.loadingFinished', { requestId: 'r1', timestamp: 10.25, encodedDataLength: 512 });
let r1 = cap.network.get('r1');
assert.deepStrictEqual([r1.method, r1.status, r1.mime, r1.size, r1.durationMs, r1.ts], ['GET', 200, 'application/json', 512, 250, 1000000]);

reduceEvent(cap, 'Network.requestWillBeSent', { requestId: 'r2', request: { method: 'GET', url: 'http://t/old' }, type: 'Document', timestamp: 20 });
reduceEvent(cap, 'Network.requestWillBeSent', { requestId: 'r2', request: { method: 'GET', url: 'https://t/new' }, type: 'Document', timestamp: 20.1, redirectResponse: { status: 301 } });
reduceEvent(cap, 'Network.loadingFailed', { requestId: 'r2', timestamp: 20.5, errorText: 'net::ERR_CONNECTION_RESET' });
const r2 = cap.network.get('r2');
assert.deepStrictEqual([r2.url, r2.redirects, r2.error, r2.durationMs], ['https://t/new', 1, 'net::ERR_CONNECTION_RESET', 400]);

reduceEvent(cap, 'Network.loadingFailed', { requestId: 'r3', timestamp: 1, errorText: 'x', blockedReason: 'csp', canceled: true });
assert.deepStrictEqual([cap.network.get('r3').error, cap.network.get('r3').canceled], ['blocked: csp', true]);
reduceEvent(cap, 'Network.responseReceived', { requestId: 'late', response: { status: 500, url: 'https://t/late' }, type: 'XHR' });
assert.deepStrictEqual([cap.network.get('late').url, cap.network.get('late').status], ['https://t/late', 500]);

// Untracked events are ignored
assert.strictEqual(reduceEvent(cap, 'Network.dataReceived', { requestId: 'r1' }), false);

// Ring caps: oldest dropped, counted
const big = newCapture(0);
for (let i = 0; i < DEBUG_BUFFER_CAP + 7; i++) {
  reduceEvent(big, 'Runtime.consoleAPICalled', { type: 'log', args: [str(`m${i}`)] });
  reduceEvent(big, 'Network.requestWillBeSent', { requestId: `q${i}`, request: { method: 'GET', url: `https://t/${i}` }, timestamp: i });
}
assert.strictEqual(big.console.length, DEBUG_BUFFER_CAP);
assert.strictEqual(big.console[0].text, 'm7');
assert.strictEqual(big.network.size, DEBUG_BUFFER_CAP);
assert.ok(!big.network.has('q0') && big.network.has(`q${DEBUG_BUFFER_CAP + 6}`));
assert.deepStrictEqual(big.dropped, { console: 7, network: 7 });

console.log('debug reducer OK');
