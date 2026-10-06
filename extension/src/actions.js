// --- Browser actions via CDP Input events (real mouse/keyboard, works on React-style apps) ---
import { withDebugger, inPage } from './cdp.js';
import { domAction, selectorCenter } from './page.js';
import { sleep, isForeignFrameError, focusBlocked } from './util.js';

const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };
const INPUT_ACTIONS = ['click', 'type', 'key', 'scroll'];

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
  const mouse = (type, x, y, extra = {}) => cmd('Input.dispatchMouseEvent', { type, x, y, ...extra });
  if (INPUT_ACTIONS.includes(p.action)) {
    const vis = (await cmd('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true })).result.value;
    if (vis !== 'visible') {
      const mode = 'dom-fallback (tab hidden)';
      const r = (await cmd('Runtime.evaluate', { expression: `(${domAction})(${JSON.stringify(p)})`, returnByValue: true, userGesture: true })).result.value;
      if (r !== 'ok') return { error: `${p.action} (${mode}): ${r}` };
      return settled(tabId, p, { mode });
    }
  }
  let { x, y } = p;
  if (p.selector) {
    const r = await cmd('Runtime.evaluate', { expression: `(${selectorCenter})(${JSON.stringify(p.selector)})`, returnByValue: true });
    if (!r.result.value) return { error: `selector not found: ${p.selector}` };
    ({ x, y } = r.result.value);
  }
  switch (p.action) {
    case 'click': {
      if (x == null || y == null) return { error: 'click needs x,y or selector' };
      const button = p.button || 'left', clickCount = p.double ? 2 : 1;
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, { button, clickCount });
      await mouse('mouseReleased', x, y, { button, clickCount });
      break;
    }
    case 'type':
      if (typeof p.text !== 'string') return { error: 'type needs text' };
      await cmd('Input.insertText', { text: p.text });
      break;
    case 'key': {
      const key = p.key; const vk = KEY_CODES[key];
      if (!key) return { error: 'key needs key (e.g. Enter, Tab, Escape, ArrowDown)' };
      const base = { key, code: key, ...(vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}) };
      await cmd('Input.dispatchKeyEvent', { type: vk ? 'rawKeyDown' : 'keyDown', ...base, ...(key.length === 1 ? { text: key } : {}) });
      await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
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

export async function doAction(tabId, p, ctx) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
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
    if (r !== 'ok') return { error: `${p.action} (${mode}): ${r}` };
    return await settled(tabId, p, { mode });
  } catch (e) {
    return { error: e.message };
  }
}
