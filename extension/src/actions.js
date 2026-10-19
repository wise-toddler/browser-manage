// --- Browser actions via CDP Input events (real mouse/keyboard, works on React-style apps) ---
import { withDebugger, inPage } from './cdp.js';
import { domAction, selectorCenter } from './page.js';
import { sleep, isForeignFrameError, focusBlocked } from './util.js';
import { refSelector } from './read.js';

const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };
const INPUT_ACTIONS = ['click', 'type', 'key', 'scroll'];
const MODIFIER_BITS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const HIDDEN_KEY_TIMEOUT_MS = 3000;
// DOM-fallback results say so: untrusted events fill plain forms but editors ignore them, so ok alone isn't proof
const SYNTHETIC_WARNING = 'synthetic DOM events, not real input: plain forms take them, but editors like Google Sheets/Docs and canvas apps ignore them. Read the result back; for editors focus with type/key + selector (real input, works on hidden tabs too)';

async function waitForLoad(tabId, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await chrome.tabs.get(tabId)).status === 'complete') return;
    await sleep(150);
  }
}

async function settled(tabId, p, extra = {}) {
  await sleep(p.wait ?? 400);
  return { ok: true, ...extra, url: (await chrome.tabs.get(tabId)).url };
}

// With a debugger session: real CDP input on visible tabs, DOM fallback on hidden ones
async function cdpAction(tabId, p, cmd) {
  let hidden = false;
  if (INPUT_ACTIONS.includes(p.action)) {
    const vis = (await cmd('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true })).result.value;
    hidden = vis !== 'visible';
    // Keys and text don't need a rendered frame: real CDP key events move focus and set :focus-visible on hidden
    // tabs too (Tab/Shift+Tab traversal), and Input.insertText reaches editors (Google Sheets) that ignore
    // synthetic events. Only mouse actions need hit-testing on a frame, so click/scroll take the DOM path there
    if (hidden && (p.action === 'click' || p.action === 'scroll')) {
      const mode = 'dom-fallback (tab hidden)';
      const r = (await cmd('Runtime.evaluate', { expression: `(${domAction})(${JSON.stringify(p)})`, returnByValue: true, userGesture: true })).result.value;
      if (r !== 'ok') return { error: r === 'no element' && p.selector ? notFound(p) : `${p.action} (${mode}): ${r}` };
      return settled(tabId, p, { mode, warning: SYNTHETIC_WARNING });
    }
  }
  // Editors check that their document has focus before taking input; a hidden tab's document doesn't.
  // Only for this action: emulated focus also makes the page report visible, which the check above relies on
  if (hidden) {
    await cmd('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    try {
      return await cdpInput(tabId, p, cmd, hidden);
    } finally {
      await cmd('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    }
  }
  return cdpInput(tabId, p, cmd, hidden);
}

// The real-input half of cdpAction: focus the target, then CDP mouse/keyboard/text events
async function cdpInput(tabId, p, cmd, hidden) {
  const mouse = (type, x, y, extra = {}) => cmd('Input.dispatchMouseEvent', { type, x, y, ...extra });
  // A hidden tab normally answers in ms; guard anyway, and never retry: a stuck input event stays
  // queued and fires when the tab wakes, so a retry would type it twice
  const input = async (method, params, what) => {
    try {
      await cmd(method, params, hidden ? HIDDEN_KEY_TIMEOUT_MS : undefined);
    } catch (e) {
      if (hidden && /timed out/.test(e.message)) throw new Error(`${what} timed out on a hidden tab; not retried (it may still arrive when the tab wakes)`);
      throw e;
    }
  };
  // type/key go to the focused element, so a target given by selector/ref gets focus first
  if ((p.action === 'type' || p.action === 'key') && p.selector) {
    const f = (await cmd('Runtime.evaluate', { expression: `(${domAction})(${JSON.stringify({ action: 'focus', selector: p.selector })})`, returnByValue: true })).result.value;
    if (f !== 'ok') return { error: notFound(p) };
  }
  let { x, y } = p;
  if (p.selector && p.action !== 'type' && p.action !== 'key') {
    const r = await cmd('Runtime.evaluate', { expression: `(${selectorCenter})(${JSON.stringify(p.selector)})`, returnByValue: true });
    if (!r.result.value) return { error: notFound(p) };
    ({ x, y } = r.result.value);
  }
  switch (p.action) {
    case 'click': {
      if (x == null || y == null) return { error: 'click needs x,y, selector or ref' };
      const button = p.button || 'left', clickCount = p.double ? 2 : 1;
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, { button, clickCount });
      await mouse('mouseReleased', x, y, { button, clickCount });
      // Viewport CSS px of the click, for recordings to mark where it landed
      return settled(tabId, p, { at: { x: Math.round(x), y: Math.round(y) } });
    }
    case 'type':
      if (typeof p.text !== 'string') return { error: 'type needs text' };
      await input('Input.insertText', { text: p.text }, 'type');
      if (hidden) return settled(tabId, p, { mode: 'cdp (tab hidden)' });
      break;
    case 'key': {
      if (!p.key) return { error: 'key needs key (e.g. Enter, Tab, Escape, ArrowDown, Shift+Tab, Meta+a)' };
      // "Shift+Tab" / "Control+a": everything before the last + is a modifier
      const parts = String(p.key).split('+');
      const key = parts.pop() || '+'; const vk = KEY_CODES[key];
      const modifiers = parts.reduce((m, x) => m | (MODIFIER_BITS[x.toLowerCase()] || 0), 0);
      const base = { key, code: key, modifiers, ...(vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}) };
      const text = key.length === 1 && !(modifiers & (2 | 4)) ? { text: key } : {};
      await input('Input.dispatchKeyEvent', { type: vk ? 'rawKeyDown' : 'keyDown', ...base, ...text }, `key ${p.key}`);
      await input('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, `key ${p.key}`);
      if (hidden) return settled(tabId, p, { mode: 'cdp (tab hidden)' });
      break;
    }
    case 'scroll':
      await mouse('mouseWheel', x ?? 400, y ?? 300, { deltaX: p.deltaX || 0, deltaY: p.deltaY ?? 600 });
      break;
    default:
      return { error: `unknown action: ${p.action}` };
  }
  return settled(tabId, p);
}

const notFound = p => (p.ref != null ? `ref ${p.ref} not found (page changed? read the page again)` : `selector not found: ${p.selector}`);

export async function doAction(tabId, p, ctx) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
  if (p.ref != null) {
    const selector = refSelector(p.ref);
    if (!selector) return { error: `bad ref: ${p.ref}` };
    p = { ...p, selector };
  }
  try {
    if (p.action === 'activate') {
      const blocked = focusBlocked(p, ctx, 'activate');
      if (blocked) return blocked;
      const t = await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return { ok: true };
    }
    if (p.action === 'navigate') {
      if (!/^https?:\/\//.test(p.url || '')) return { error: 'navigate needs an http(s) url' };
      await chrome.tabs.update(tabId, { url: p.url });
      await sleep(300); await waitForLoad(tabId);
      return { ok: true, url: (await chrome.tabs.get(tabId)).url };
    }
    if (p.action === 'back' || p.action === 'forward') {
      await (p.action === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
      await sleep(300); await waitForLoad(tabId);
      return { ok: true, url: (await chrome.tabs.get(tabId)).url };
    }
  } catch (e) {
    return { error: e.message };
  }
  try {
    return await withDebugger(tabId, cmd => cdpAction(tabId, p, cmd));
  } catch (e) {
    if (!isForeignFrameError(e)) return { error: e.message };
  }
  // Debugger refused by another extension's frame: DOM fallback through chrome.scripting
  if (!INPUT_ACTIONS.includes(p.action)) return { error: `${p.action} needs the debugger, which is blocked by another extension's frame in this tab` };
  const mode = "dom-fallback (debugger blocked by another extension's frame)";
  try {
    const r = await inPage(tabId, domAction, [p]);
    if (r !== 'ok') return { error: r === 'no element' && p.selector ? notFound(p) : `${p.action} (${mode}): ${r}` };
    return await settled(tabId, p, { mode, warning: SYNTHETIC_WARNING });
  } catch (e) {
    return { error: e.message };
  }
}
