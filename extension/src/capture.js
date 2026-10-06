// --- Screenshots via the debugger, so background tabs work without activating them ---
import { withDebugger } from './cdp.js';
import { saveScroll, restoreScroll } from './page.js';
import { isForeignFrameError, sleep } from './util.js';

const OFFSCREEN_SHOT_TIMEOUT_MS = 20000;
const FULL_PAGE_MAX_HEIGHT = 8000;

export async function screenshotTab(tabId, { fullPage = false, format = 'jpeg', quality = 85 } = {}) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
  try {
    return await withDebugger(tabId, async (cmd) => {
      const q = format === 'jpeg' ? { quality } : {};
      const vis = (await cmd('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true })).result.value;
      if (vis === 'visible' && !fullPage) {
        // Visible tab: grab the composited frame as-is. No clip/captureBeyondViewport means no viewport
        // emulation, so it's fast on long pages and never touches scroll positions
        const { data } = await cmd('Page.captureScreenshot', { format, ...q });
        return { data, format, fullPage: false };
      }
      // Hidden tab (it never produces a frame, so a plain capture hangs) or full page: render offscreen.
      // That temporarily resizes the viewport, which clamps 100vh app-shell scrollers (Grafana, GCP) to the
      // top, so every scroll position is saved first and put back afterwards
      await cmd('Runtime.evaluate', { expression: `(${saveScroll})()` });
      try {
        const { cssContentSize: c, cssVisualViewport: v } = await cmd('Page.getLayoutMetrics');
        // Past ~8k CSS px (16k device px at 2x) the GPU texture limit makes capture fail, and the image is 10MB+ anyway
        const truncated = fullPage && c.height > FULL_PAGE_MAX_HEIGHT;
        const clip = fullPage
          ? { x: 0, y: 0, width: c.width, height: Math.min(c.height, FULL_PAGE_MAX_HEIGHT), scale: 1 }
          : { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 1 };
        // Offscreen capture renders the whole page even with a viewport clip, so long pages need more time
        const { data } = await cmd('Page.captureScreenshot', { format, clip, captureBeyondViewport: true, ...q }, OFFSCREEN_SHOT_TIMEOUT_MS);
        return { data, format, fullPage, ...(truncated ? { truncated: true, pageHeight: Math.round(c.height) } : {}) };
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
    return { data: url.split(',')[1], format, fullPage: false, mode: `captureVisibleTab${fullPage ? ' (full_page unsupported here, viewport only)' : ''}` };
  }
}
