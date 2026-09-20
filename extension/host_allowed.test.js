// Run: node extension/host_allowed.test.js
// Pulls the real hostAllowed out of background.js (a non-module service worker, so no exports).
const assert = require('assert');
const src = require('fs').readFileSync(__dirname + '/background.js', 'utf8');
const m = src.match(/function hostAllowed\(host, list\) \{[\s\S]*?\n\}/);
assert(m, 'hostAllowed not found in background.js');
const hostAllowed = eval(`(${m[0]})`);

const list = ['github.com', 'localhost'];
assert(hostAllowed('github.com', list));
assert(hostAllowed('gist.github.com', list));
assert(hostAllowed('localhost', list));
assert(!hostAllowed('evil-github.com', list), 'suffix without dot must not match');
assert(!hostAllowed('github.com.attacker.io', list), 'allowlisted name as a prefix must not match');
assert(!hostAllowed('notgithub.com', list));
assert(!hostAllowed('', list));
assert(!hostAllowed('github.com', []), 'empty allowlist blocks everything');
console.log('hostAllowed OK');
