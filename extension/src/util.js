// Small shared helpers used across modules

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const CDP_TIMEOUT_MS = 8000;

// A stuck call must reject so the caller can recover (and the debugger session gets dropped);
// otherwise every later command on the tab queues behind it
export function withTimeout(p, ms, label) {
  p.catch(() => {});
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))]);
}

// debugger.attach refuses any tab holding another extension's frame (e.g. an injected overlay iframe),
// which kills every CDP tool on that tab; callers fall back to debugger-free APIs
export const isForeignFrameError = e => /URL of different extension/.test(e?.message || '');

export function getDomainFromUrl(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return ''; }
}

// Agents (native callers) must opt in to anything that pulls the user's window or tab into focus;
// returns an error result to send back, or null when allowed. Popup calls are a human, always allowed
export function focusBlocked(payload, ctx, what) {
  if (ctx?.source !== 'native' || payload?.allowFocus === true) return null;
  return { error: `${what} would take focus of the user's browser window; pass allow_focus=true to do it anyway` };
}
