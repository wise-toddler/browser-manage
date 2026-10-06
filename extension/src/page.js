// Functions that run INSIDE the page, serialized via `(${fn})(args)` into CDP Runtime.evaluate or passed
// to chrome.scripting.executeScript. They must be self-contained: no closures, no imports, no helpers.

// DOM-level input, used when real CDP input can't run: hidden tabs (Input.dispatch* waits for a frame
// background tabs never produce) and tabs where the debugger is refused
export function domAction(p) {
  const dx = p.deltaX || 0, dy = p.deltaY ?? 600;
  const el = p.selector ? document.querySelector(p.selector) : (p.x != null ? document.elementFromPoint(p.x, p.y) : document.activeElement);
  if (p.action === 'scroll') {
    if (p.selector && el) { el.scrollBy(dx, dy); return 'ok'; }
    const se = document.scrollingElement, before = se.scrollTop;
    se.scrollBy(dx, dy);
    if (se.scrollTop !== before || !dy) return 'ok';
    // App-shell pages (Grafana, GCP console) scroll an inner container, not the window: use the largest scrollable box
    const box = [...document.querySelectorAll('*')]
      .filter(e => e.scrollHeight > e.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    // Page fits the viewport: a no-op, same as a wheel event would be
    if (box) box.scrollBy(dx, dy);
    return 'ok';
  }
  if (!el) return 'no element';
  if (p.action === 'click') { el.scrollIntoView({block:'center'}); el.focus?.(); el.click(); if (p.double) el.dispatchEvent(new MouseEvent('dblclick', {bubbles:true})); return 'ok'; }
  if (p.action === 'type') { el.focus?.(); return document.execCommand('insertText', false, p.text) ? 'ok' : 'insertText failed'; }
  if (p.action === 'key') {
    const o = { key: p.key, code: p.key, bubbles: true, cancelable: true };
    const go = el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o));
    if (go && p.key === 'Enter' && el.form) el.form.requestSubmit();
    return 'ok';
  }
  return 'unsupported';
}

// Center of the element matching sel after scrolling it into view, or null if absent
export function selectorCenter(sel) {
  const e = document.querySelector(sel);
  if (!e) return null;
  e.scrollIntoView({block:'center'});
  const r = e.getBoundingClientRect();
  return {x: r.x + r.width / 2, y: r.y + r.height / 2};
}

// Remember every non-zero scroll position, and put them back
export function saveScroll() {
  const s = [];
  for (const e of document.querySelectorAll('*')) if (e.scrollTop || e.scrollLeft) s.push([e, e.scrollTop, e.scrollLeft]);
  window.__bmScroll = { s, x: scrollX, y: scrollY };
}
export function restoreScroll() {
  const b = window.__bmScroll;
  if (!b) return;
  for (const [e, t, l] of b.s) { e.scrollTop = t; e.scrollLeft = l; }
  scrollTo(b.x, b.y);
  delete window.__bmScroll;
}

// runScript fallback body: indirect eval in the page's main world (subject to the page's own CSP)
export async function pageEval(c) {
  try { const v = await (0, eval)(c); return { ok: true, s: JSON.stringify(v) ?? 'undefined', t: typeof v }; }
  catch (err) { return { ok: false, err: String(err) }; }
}
