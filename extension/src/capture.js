// --- Screenshots via the debugger, so background tabs work without activating them ---
import { withDebugger, inPage } from './cdp.js';
import { saveScroll, restoreScroll } from './page.js';
import { isForeignFrameError, sleep } from './util.js';
import { refSelector } from './read.js';
import { getViewportOverride } from './viewport.js';

const OFFSCREEN_SHOT_TIMEOUT_MS = 20000;
// Past ~8k CSS px (16k device px at 2x) the GPU texture limit makes capture fail, and the image is 10MB+ anyway;
// taller pages are captured in tiles via tileY
export const FULL_PAGE_MAX_HEIGHT = 8000;

// Self-contained (serialized into the page): the crop box in viewport CSS px plus the scroll offsets to turn it
// into page coordinates. With scroll=true an element hidden by a scrolling ancestor (app-shell containers) is
// scrolled into view first; window-level offscreen positions don't need it, captureBeyondViewport reaches them
export function cropBox(sel, clip, scroll) {
  let r;
  if (sel) {
    const deepQuery = (s, root = document) => {
      const hit = root.querySelector(s);
      if (hit) return hit;
      for (const x of root.querySelectorAll('*')) if (x.shadowRoot) { const h = deepQuery(s, x.shadowRoot); if (h) return h; }
      return null;
    };
    const e = deepQuery(sel);
    if (!e) return { error: 'not found' };
    const clipped = () => {
      const b = e.getBoundingClientRect();
      for (let p = e.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (!/(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY)) continue;
        const pb = p.getBoundingClientRect();
        if (b.top < pb.top || b.bottom > pb.bottom || b.left < pb.left || b.right > pb.right) return true;
      }
      return false;
    };
    if (scroll && clipped()) e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const b = e.getBoundingClientRect();
    r = { x: b.x, y: b.y, width: b.width, height: b.height };
  } else {
    r = { x: +clip.x || 0, y: +clip.y || 0, width: +clip.width, height: +clip.height };
  }
  if (!(r.width > 0 && r.height > 0)) return { error: 'empty box' };
  const inView = r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight;
  return { ...r, sx: scrollX, sy: scrollY, inView };
}

export async function screenshotTab(tabId, p = {}) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
  const { fullPage = false, format = 'jpeg', quality = 85 } = p;
  const selector = p.ref != null ? refSelector(p.ref) : p.selector;
  if (p.ref != null && !selector) return { error: `bad ref: ${p.ref}` };
  const clipArg = p.clip && typeof p.clip === 'object' ? p.clip : null;
  const crop = !fullPage && (selector || clipArg);
  const viewport = getViewportOverride(tabId);
  const notFound = p.ref != null ? `ref ${p.ref} not found (page changed? read the page again)` : `selector not found: ${selector}`;
  try {
    return await withDebugger(tabId, async (cmd) => {
      const q = format === 'jpeg' ? { quality } : {};
      const box = async scroll => (await cmd('Runtime.evaluate', { expression: `(${cropBox})(${JSON.stringify(selector || null)}, ${JSON.stringify(clipArg)}, ${scroll})`, returnByValue: true })).result.value;
      const boxError = b => (b.error === 'not found' ? notFound : b.error === 'empty box' ? 'crop area is empty (zero-size element or clip)' : b.error);
      // dpr: image px per CSS px, so callers (recordings) can map viewport coordinates onto the image
      const { vis, dpr } = (await cmd('Runtime.evaluate', { expression: '({ vis: document.visibilityState, dpr: devicePixelRatio })', returnByValue: true })).result.value;
      const base = { format, dpr, ...(viewport ? { viewport } : {}) };
      if (vis === 'visible' && !fullPage) {
        if (!crop) {
          // Visible tab: grab the composited frame as-is. No clip/captureBeyondViewport means no viewport
          // emulation, so it's fast on long pages and never touches scroll positions
          const { data } = await cmd('Page.captureScreenshot', { format, ...q });
          return { data, fullPage: false, ...base };
        }
        // A crop already on screen also comes straight off the composited frame, no scrolling
        const b = await box(false);
        if (b.error) return { error: boxError(b) };
        if (b.inView) {
          const clip = { x: b.x + b.sx, y: b.y + b.sy, width: b.width, height: b.height, scale: 1 };
          const { data } = await cmd('Page.captureScreenshot', { format, clip, ...q });
          return { data, fullPage: false, crop: rounded(b), ...base };
        }
      }
      // Hidden tab (it never produces a frame, so a plain capture hangs), full page, or an off-screen crop:
      // render offscreen. That temporarily resizes the viewport, which clamps 100vh app-shell scrollers
      // (Grafana, GCP) to the top, so every scroll position is saved first and put back afterwards
      await cmd('Runtime.evaluate', { expression: `(${saveScroll})()` });
      try {
        let clip, extra = {};
        if (crop) {
          const b = await box(true);
          if (b.error) return { error: boxError(b) };
          clip = { x: b.x + b.sx, y: b.y + b.sy, width: b.width, height: b.height, scale: 1 };
          extra = { crop: rounded(b) };
        } else {
          const { cssContentSize: c, cssVisualViewport: v } = await cmd('Page.getLayoutMetrics');
          if (fullPage) {
            const pageHeight = Math.round(c.height);
            const tileY = Math.max(0, Math.round(+p.tileY || 0));
            if (tileY >= pageHeight) return { error: `tileY ${tileY} is past the page height ${pageHeight}` };
            const h = Math.min(pageHeight - tileY, FULL_PAGE_MAX_HEIGHT);
            clip = { x: 0, y: tileY, width: c.width, height: h, scale: 1 };
            extra = { pageHeight, tileY, tileHeight: h, ...(pageHeight > FULL_PAGE_MAX_HEIGHT ? { truncated: tileY + h < pageHeight } : {}) };
          } else {
            clip = { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 1 };
          }
        }
        // Offscreen capture renders the whole page even with a viewport clip, so long pages need more time
        const { data } = await cmd('Page.captureScreenshot', { format, clip, captureBeyondViewport: true, ...q }, OFFSCREEN_SHOT_TIMEOUT_MS);
        return { data, fullPage, ...extra, ...base };
      } finally {
        // Let the viewport return to its real size first, or the restore lands on the enlarged layout
        await sleep(150);
        try { await cmd('Runtime.evaluate', { expression: `(${restoreScroll})()` }); } catch {}
      }
    });
  } catch (e) {
    if (!isForeignFrameError(e)) return { error: e.message };
    // Debugger refused: capture what the window shows. Only works for the visible active tab, viewport only
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    if (!tab.active || win.state === 'minimized') {
      return { error: "Debugger blocked by another extension's frame in this tab, so the only capture path is the visible window. The tab must be visible; bringing it to front takes focus of the user's window and needs browser_action action=activate with allow_focus=true." };
    }
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format, ...(format === 'jpeg' ? { quality } : {}) });
    const dpr = await inPage(tabId, () => devicePixelRatio).catch(() => undefined);
    const unsupported = fullPage ? ' (full_page unsupported here, viewport only)' : crop ? ' (crop unsupported here, whole viewport)' : '';
    return { data: url.split(',')[1], format, fullPage: false, dpr, mode: `captureVisibleTab${unsupported}` };
  }
}

const rounded = b => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
