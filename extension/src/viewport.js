// --- Viewport / device emulation for a tab (works on background tabs, no focus change) ---
// Emulation lives in the debugger session: the override disappears the moment it detaches, so a tab
// with an override keeps its session pinned until reset (the debugging infobar stays up meanwhile)
import { withDebugger, pin, unpin } from './cdp.js';
import { isForeignFrameError } from './util.js';

const overrides = new Map(); // tabId -> { width, height, dpr, mobile }

export const getViewportOverride = tabId => overrides.get(tabId) || null;

// Detach (tab closed, user cancelled the infobar) took the override with it
chrome.debugger.onDetach.addListener(({ tabId }) => overrides.delete(tabId));

const MEASURE = '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints > 0 })';

async function measure(cmd) {
  return (await cmd('Runtime.evaluate', { expression: MEASURE, returnByValue: true })).result.value;
}

// p: { width, height, dpr=1, mobile=false } sets; { reset: true } clears; neither reports the current state
export async function setViewport(tabId, p = {}) {
  if (typeof tabId !== 'number') return { error: 'tabId (number) required' };
  const current = overrides.get(tabId) || null;
  try {
    if (p.reset) {
      if (!current) return { ok: true, viewport: null, note: 'no override was set' };
      const measured = await withDebugger(tabId, async cmd => {
        await cmd('Emulation.clearDeviceMetricsOverride');
        await cmd('Emulation.setTouchEmulationEnabled', { enabled: false });
        return measure(cmd);
      });
      overrides.delete(tabId);
      unpin(tabId);
      return { ok: true, viewport: null, measured };
    }
    if (p.width == null && p.height == null) {
      return { viewport: current, measured: await withDebugger(tabId, measure) };
    }
    const width = Math.round(+p.width), height = Math.round(+p.height), dpr = p.dpr == null ? 1 : +p.dpr;
    if (!(width >= 100 && width <= 5000 && height >= 100 && height <= 5000)) return { error: 'width and height must be 100..5000 CSS px' };
    if (!(dpr >= 0.5 && dpr <= 4)) return { error: 'dpr must be 0.5..4' };
    const v = { width, height, dpr, mobile: !!p.mobile };
    if (!current) await pin(tabId);
    try {
      const measured = await withDebugger(tabId, async cmd => {
        await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: v.mobile, screenWidth: width, screenHeight: height });
        await cmd('Emulation.setTouchEmulationEnabled', v.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        return measure(cmd);
      });
      overrides.set(tabId, v);
      return { ok: true, viewport: v, measured, note: 'Override stays (debugging infobar visible) until browser_set_viewport reset=true' };
    } catch (e) {
      if (!current) unpin(tabId);
      throw e;
    }
  } catch (e) {
    if (isForeignFrameError(e)) return { error: "Viewport emulation needs the debugger, which is blocked by another extension's frame in this tab" };
    return { error: e.message };
  }
}
