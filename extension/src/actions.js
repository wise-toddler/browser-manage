// --- Browser actions via CDP Input events (real mouse/keyboard, works on React-style apps) ---
import { withDebugger, inPage, getDialog } from './cdp.js';
import { domAction, selectorCenter, focusForTyping } from './page.js';
import { sleep, isForeignFrameError, focusBlocked } from './util.js';
import { refSelector } from './read.js';

const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };
const INPUT_ACTIONS = ['click', 'type', 'key', 'scroll'];
const MODIFIER_BITS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const HIDDEN_KEY_TIMEOUT_MS = 3000;
// US-layout keystroke for a printable character: apps that react to keydown (Google Sheets opens a cell's editor
// on it) need key, code and keyCode like a real keyboard sends, not just text. Shifted chars carry Shift
const PUNCT = { '-': ['Minus', 189, '_'], '=': ['Equal', 187, '+'], '[': ['BracketLeft', 219, '{'], ']': ['BracketRight', 221, '}'],
  '\\': ['Backslash', 220, '|'], ';': ['Semicolon', 186, ':'], "'": ['Quote', 222, '"'], ',': ['Comma', 188, '<'], '.': ['Period', 190, '>'],
  '/': ['Slash', 191, '?'], '`': ['Backquote', 192, '~'] };
const DIGIT_SHIFTED = ')!@#$%^&*(';
export function charKey(ch) {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, vk: ch.charCodeAt(0), shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), shift: false };
  if (DIGIT_SHIFTED.includes(ch)) { const d = String(DIGIT_SHIFTED.indexOf(ch)); return { key: ch, code: `Digit${d}`, vk: d.charCodeAt(0), shift: true }; }
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32, shift: false };
  for (const [base, [code, vk, shifted]] of Object.entries(PUNCT)) {
    if (ch === base) return { key: ch, code, vk, shift: false };
    if (ch === shifted) return { key: ch, code, vk, shift: true };
  }
  return null;
}

// How long type waits for its target to exist, take focus and be editable (a slow app may still be booting)
const TYPE_READY_MS = 5000;
// Counts trusted input events reaching the page, so type can tell when its text went nowhere
const INPUT_COUNTER = `(() => { if (!window.__bmInputs) { window.__bmInputs = { n: 0 }; addEventListener('input', e => { if (e.isTrusted) window.__bmInputs.n++; }, true); } window.__bmInputs.n = 0; return 0; })()`;
// Whether the focused element takes text. An iframe counts: its document can't be inspected from here
const ACTIVE_EDITABLE = `(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return !!a && (a.tagName === 'IFRAME' || a.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(a.tagName) && !a.readOnly && !a.disabled)); })()`;
// Marks the editor that typing starts in; IN_EDITOR: focus is inside it, or on any other editable field
const MARK_EDITOR = `(() => { document.querySelectorAll('[data-bm-typing]').forEach(e => e.removeAttribute('data-bm-typing'));
  let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!a) return false; let root = a; for (let e = a; e; e = e.parentElement) if (e.isContentEditable) root = e;
  root.setAttribute('data-bm-typing', '1'); return true; })()`;
const IN_EDITOR = `(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  const root = document.querySelector('[data-bm-typing]');
  if (root && a && (root === a || root.contains(a))) return true;
  return !!a && (a.tagName === 'IFRAME' || a.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(a.tagName) && !a.readOnly && !a.disabled)); })()`;
const SHORTCUT_RISK = 'typing would press keys on the page itself, and many sites map single keys to shortcuts (Gmail: e archives, # deletes). Pass selector/ref for the field, or use key for a deliberate shortcut';
const NO_INPUT_WARNING = 'no input event reached the page while typing: the text probably went nowhere (focus lost, or the app still loading). Read the result back; retry after waiting for the page';

// Mac editing shortcuts only act when the key event names the editing command (the renderer doesn't map them)
const MAC_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };
const IS_MAC = /Mac/.test(navigator.userAgent);
// Tabs whose debugger session has focus emulation on (see cdpAction); the session ending resets it. Only saves
// re-sending it: a worker restart forgets this set, and turning emulation on again is harmless
const focusEmulated = new Set();
chrome.debugger.onDetach.addListener(({ tabId }) => focusEmulated.delete(tabId));

// A hidden tab renders no frames, so requestAnimationFrame never runs and apps that apply input on the next
// frame (Google Sheets) never do. An offscreen capture makes the renderer produce a few frames
async function pumpFrames(cmd, n = 2) {
  for (let i = 0; i < n; i++) {
    await cmd('Page.captureScreenshot', { format: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 }, captureBeyondViewport: true }, HIDDEN_KEY_TIMEOUT_MS).catch(() => {});
  }
}

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
    // The page's own answer can't be trusted alone: emulated focus makes it report visible, and that emulation can
    // outlive this worker's memory of turning it on. Only the active tab of the focused window is surely painting
    // (an active tab in a window behind other apps is occluded, i.e. hidden)
    const t = await chrome.tabs.get(tabId);
    const vis = (await cmd('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true })).result.value;
    hidden = vis !== 'visible' || !t.active || !(await chrome.windows.get(t.windowId)).focused;
    // Keys and text don't need a rendered frame: real CDP key events move focus and set :focus-visible on hidden
    // tabs too (Tab/Shift+Tab traversal), and Input.insertText reaches editors (Google Sheets) that ignore
    // synthetic events. Only mouse actions need hit-testing on a frame, so click/scroll take the DOM path there
    // real=true asks for real CDP mouse input on a hidden tab anyway (some controls ignore synthetic clicks); it's
    // guarded like hidden keys and gets frames pumped around it
    if (hidden && (p.action === 'scroll' || (p.action === 'click' && !p.real))) {
      const mode = 'dom-fallback (tab hidden)';
      const r = (await cmd('Runtime.evaluate', { expression: `(${domAction})(${JSON.stringify(p)})`, returnByValue: true, userGesture: true })).result.value;
      if (r !== 'ok' && !r?.ok) return { error: r === 'no element' && p.selector ? notFound(p) : `${p.action} (${mode}): ${r}` };
      return settled(tabId, p, { mode, ...(r?.hit ? { hit: r.hit } : {}), warning: SYNTHETIC_WARNING });
    }
  }
  // Editors check that their document has focus before taking input; a hidden tab's document doesn't. It stays
  // on for the session: switching it off between steps blurs the page and editors drop their state
  if (hidden && !focusEmulated.has(tabId)) {
    await cmd('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    focusEmulated.add(tabId);
  }
  const out = await cdpInput(tabId, p, cmd, hidden);
  if (hidden && !out.error) await pumpFrames(cmd);
  return out;
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
  // type/key go to the focused element, so a target given by selector/ref gets focus first. type waits (pumping
  // frames on a hidden tab, where an app boots slowly) until the target exists, holds focus and takes text,
  // and fails otherwise instead of typing into nothing
  if (p.action === 'key' && p.selector) {
    const f = (await cmd('Runtime.evaluate', { expression: `(${domAction})(${JSON.stringify({ action: 'focus', selector: p.selector })})`, returnByValue: true })).result.value;
    if (f !== 'ok') return { error: notFound(p) };
  }
  if (p.action === 'type' && p.selector) {
    const end = Date.now() + TYPE_READY_MS;
    let f;
    for (;;) {
      f = (await cmd('Runtime.evaluate', { expression: `(${focusForTyping})(${JSON.stringify(p.selector)})`, returnByValue: true })).result.value;
      if (f.found && f.focused && f.editable) break;
      if (Date.now() > end) {
        if (!f.found) return { error: notFound(p) };
        return { error: `type: ${p.selector} ${!f.editable ? "isn't an editable field" : `didn't take focus (focus is on ${f.active})`} after ${TYPE_READY_MS / 1000}s; the page may still be loading. Nothing was typed` };
      }
      if (hidden) await pumpFrames(cmd, 1);
      await sleep(200);
    }
  }
  let { x, y } = p;
  if (p.selector && p.action !== 'type' && p.action !== 'key') {
    const r = await cmd('Runtime.evaluate', { expression: `(${selectorCenter})(${JSON.stringify(p.selector)})`, returnByValue: true });
    if (!r.result.value) return { error: notFound(p) };
    // A real click goes to whatever is on top at that point: when that isn't the target (a modal not open yet, an
    // overlay, the target off-screen) it would land on something else, on X a feed post. Refuse instead
    if (p.action === 'click' && !r.result.value.onTop) {
      return { error: `click refused: ${p.ref != null ? `ref ${p.ref}` : p.selector} is not what's on top at its centre (${r.result.value.top} is); nothing was clicked. Read the page again for the right element` };
    }
    ({ x, y } = r.result.value);
  }
  switch (p.action) {
    case 'click': {
      if (x == null || y == null) return { error: 'click needs x,y, selector or ref' };
      const button = p.button || 'left', clickCount = p.double ? 2 : 1;
      if (hidden) {
        // What's under the point in this tab's own layout: x,y read off another view can land beside the target
        const hit = (await cmd('Runtime.evaluate', { expression: `(() => { const e = document.elementFromPoint(${x}, ${y}); if (!e) return null;
          const t = (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 40), tid = e.getAttribute('data-testid');
          return e.tagName.toLowerCase() + (tid ? '[data-testid="' + tid + '"]' : '') + (t ? ' "' + t + '"' : ''); })()`, returnByValue: true })).result.value;
        // real=true on a hidden tab: hit-testing needs a frame, so pump one first (guarded, no retry). Press and
        // release go back to back: a pump in between re-lays-out the page (the capture), and on X the release then
        // hit another element, so the click went to their common ancestor instead of the button
        await pumpFrames(cmd, 1);
        for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button, clickCount }], ['mouseReleased', { button, clickCount }]]) {
          await input('Input.dispatchMouseEvent', { type, x, y, ...extra }, `click ${type}`);
        }
        await pumpFrames(cmd, 1);
        return settled(tabId, p, { mode: 'cdp mouse (tab hidden, real)', at: { x: Math.round(x), y: Math.round(y) }, hit });
      }
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, { button, clickCount });
      await mouse('mouseReleased', x, y, { button, clickCount });
      // Viewport CSS px of the click, for recordings to mark where it landed
      return settled(tabId, p, { at: { x: Math.round(x), y: Math.round(y) } });
    }
    case 'type':
      if (typeof p.text !== 'string') return { error: 'type needs text' };
      const editable = async () => (await cmd('Runtime.evaluate', { expression: ACTIVE_EDITABLE, returnByValue: true })).result.value;
      if (!(await editable())) return { error: `type: no editable field has focus; ${SHORTCUT_RISK}. Nothing was typed` };
      // The editor typing starts in (outermost contenteditable around the focus, else the field): rich editors
      // (X's Draft.js) re-render on Enter, so focus inside it again counts as still in the field
      await cmd('Runtime.evaluate', { expression: MARK_EDITOR, returnByValue: true });
      const stillInField = async () => {
        for (let i = 0; i < 6; i++) {
          if ((await cmd('Runtime.evaluate', { expression: IN_EDITOR, returnByValue: true })).result.value) return true;
          if (hidden) await pumpFrames(cmd, 1);
          await sleep(100);
        }
        return false;
      };
      if (p.clear) {
        // Select what's in the field first so the text replaces it (Cmd/Ctrl+A, with the editing command spelled out)
        const sel = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: IS_MAC ? 4 : 2 };
        await input('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...sel, commands: ['selectAll'] }, 'type');
        await input('Input.dispatchKeyEvent', { type: 'keyUp', ...sel }, 'type');
      }
      await cmd('Runtime.evaluate', { expression: INPUT_COUNTER, returnByValue: true });
      // Let a hidden app run what it queued for the next frame before the first keystroke
      if (hidden) await pumpFrames(cmd, 1);
      // One keystroke per character, as a real keyboard sends: editors that act on keydown (Sheets) ignore bare
      // text insertion. Characters with no key (emoji, accents) are inserted as text
      const chars = [...p.text];
      for (const [i, ch] of chars.entries()) {
        const k = ch === '\n' ? { key: 'Enter', code: 'Enter', vk: 13, shift: false, text: '\r' } : charKey(ch);
        if (!k) { await input('Input.insertText', { text: ch }, 'type'); continue; }
        const ev = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.shift ? 8 : 0 };
        const text = k.text ?? ch;
        await input('Input.dispatchKeyEvent', { type: 'keyDown', ...ev, text, unmodifiedText: text }, 'type');
        await input('Input.dispatchKeyEvent', { type: 'keyUp', ...ev }, 'type');
        // Enter commits a line (a cell in Sheets); on a hidden tab give the app frames to finish before the next
        if (ch === '\n' && hidden) await pumpFrames(cmd, 1);
        // Enter can submit a form and drop focus; then the rest would land on the page as shortcuts, so stop
        if (ch === '\n' && i < chars.length - 1 && !(await stillInField())) {
          return { error: `type: focus left the field after typing ${JSON.stringify(chars.slice(0, i + 1).join(''))} (Enter may have submitted a form); stopped, since ${SHORTCUT_RISK}` };
        }
      }
      await cmd('Runtime.evaluate', { expression: "document.querySelectorAll('[data-bm-typing]').forEach(e => e.removeAttribute('data-bm-typing'))" });
      if (/[^\n]/.test(p.text)) {
        const n = (await cmd('Runtime.evaluate', { expression: 'window.__bmInputs ? window.__bmInputs.n : -1', returnByValue: true })).result.value;
        if (n === 0) return settled(tabId, p, { ...(hidden ? { mode: 'cdp (tab hidden)' } : {}), warning: NO_INPUT_WARNING });
      }
      if (hidden) return settled(tabId, p, { mode: 'cdp (tab hidden)' });
      break;
    case 'key': {
      if (!p.key) return { error: 'key needs key (e.g. Enter, Tab, Escape, ArrowDown, Shift+Tab, Meta+a)' };
      // "Shift+Tab" / "Control+a": everything before the last + is a modifier
      const parts = String(p.key).split('+');
      const key = parts.pop() || '+'; const ck = key.length === 1 ? charKey(key) : null; const vk = KEY_CODES[key] ?? ck?.vk;
      const modifiers = parts.reduce((m, x) => m | (MODIFIER_BITS[x.toLowerCase()] || 0), 0) | (ck?.shift ? 8 : 0);
      const base = { key, code: ck?.code ?? key, modifiers, ...(vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}) };
      // Enter types "\r" on a real keyboard (Sheets commits a cell on it); other named keys carry no text
      const text = key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : key.length === 1 && !(modifiers & (2 | 4)) ? { text: key } : {};
      const command = IS_MAC && (modifiers & 4) && MAC_COMMANDS[key.toLowerCase()];
      if (command) text.commands = [command === 'undo' && (modifiers & 8) ? 'redo' : command];
      await input('Input.dispatchKeyEvent', { type: text.text ? 'keyDown' : 'rawKeyDown', ...base, ...text }, `key ${p.key}`);
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

// Reload through CDP. A beforeunload "Reload site?" prompt is accepted, the one this reload raises and one left
// open by an earlier location.reload(): the caller asked for the reload. Other dialogs are left to action=dialog
async function reloadTab(tabId, p) {
  let accepted = false;
  const onEvent = ({ tabId: t }, method, params) => {
    if (t === tabId && method === 'Page.javascriptDialogOpening' && params.type === 'beforeunload') {
      accepted = true;
      chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    const r = await withDebugger(tabId, async cmd => {
      const open = getDialog(tabId);
      if (open && open.type !== 'beforeunload') return { error: `the page is showing a ${open.type} dialog; close it with action=dialog first` };
      if (open) { accepted = true; await cmd('Page.handleJavaScriptDialog', { accept: true }); return {}; }
      await cmd('Page.enable');
      await cmd('Page.reload', { ignoreCache: !!p.hard });
      return {};
    }, { allowDialog: true });
    if (r.error) return r;
    await sleep(300); await waitForLoad(tabId);
    return { ok: true, url: (await chrome.tabs.get(tabId)).url, ...(accepted ? { acceptedBeforeunload: true } : {}) };
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
  }
}

// Keep a hidden tab painting for ms (max 15s): its page thinks it's focused and gets frames all along, so a
// multi-step flow that runs across frames and timers (an image editor, an upload pipeline) can finish.
// method: 'screencast' (the browser streams frames; each is acknowledged) or 'pump' (a tiny capture every ~50ms)
async function paintFor(tabId, p) {
  const ms = Math.min(Math.max(Number(p.ms) || 3000, 100), 15000);
  return withDebugger(tabId, async cmd => {
    await cmd('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    focusEmulated.add(tabId);
    const end = Date.now() + ms;
    let frames = 0;
    if (p.method === 'pump') {
      while (Date.now() < end) { await pumpFrames(cmd, 1); frames++; await sleep(50); }
      return { ok: true, method: 'pump', ms, frames };
    }
    const onEvent = ({ tabId: t }, method, params) => {
      if (t !== tabId || method !== 'Page.screencastFrame') return;
      frames++;
      chrome.debugger.sendCommand({ tabId }, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    };
    chrome.debugger.onEvent.addListener(onEvent);
    try {
      await cmd('Page.enable');
      await cmd('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 32, maxHeight: 32, everyNthFrame: 1 });
      await sleep(Math.max(0, end - Date.now()));
    } finally {
      await cmd('Page.stopScreencast').catch(() => {});
      chrome.debugger.onEvent.removeListener(onEvent);
    }
    return { ok: true, method: 'screencast', ms, frames };
  });
}

// Close the JS dialog open in the tab (accept=false cancels; text answers a prompt)
async function handleDialog(tabId, p) {
  return withDebugger(tabId, async cmd => {
    const d = getDialog(tabId);
    if (!d) return { error: 'no dialog is open in this tab (or it opened before browser-manage attached to it)' };
    await cmd('Page.handleJavaScriptDialog', { accept: p.accept !== false, ...(p.text != null ? { promptText: String(p.text) } : {}) });
    return { ok: true, dialog: d, accepted: p.accept !== false };
  }, { allowDialog: true });
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
    if (p.action === 'reload') return await reloadTab(tabId, p);
    if (p.action === 'paint') return await paintFor(tabId, p);
    if (p.action === 'dialog') return await handleDialog(tabId, p);
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
    if (r !== 'ok' && !r?.ok) return { error: r === 'no element' && p.selector ? notFound(p) : `${p.action} (${mode}): ${r}` };
    return await settled(tabId, p, { mode, ...(r?.hit ? { hit: r.hit } : {}), warning: SYNTHETIC_WARNING });
  } catch (e) {
    return { error: e.message };
  }
}
