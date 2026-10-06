// Functions that run INSIDE the page, serialized via `(${fn})(args)` into CDP Runtime.evaluate or passed
// to chrome.scripting.executeScript. They must be self-contained: no closures, no imports, no helpers.

// DOM-level input, used when real CDP input can't run: hidden tabs (Input.dispatch* waits for a frame
// background tabs never produce) and tabs where the debugger is refused
export function domAction(p) {
  // querySelector that also searches open shadow roots (refs from read_page can live inside them)
  const deepQuery = (sel, root = document) => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) { const h = deepQuery(sel, e.shadowRoot); if (h) return h; }
    return null;
  };
  const dx = p.deltaX || 0, dy = p.deltaY ?? 600;
  const el = p.selector ? deepQuery(p.selector) : (p.x != null ? document.elementFromPoint(p.x, p.y) : document.activeElement);
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
  if (p.action === 'focus') { el.focus?.(); return 'ok'; }
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

// Center of the element matching sel (open shadow roots included) after scrolling it into view, or null if absent
export function selectorCenter(sel) {
  const deepQuery = (s, root = document) => {
    const hit = root.querySelector(s);
    if (hit) return hit;
    for (const x of root.querySelectorAll('*')) if (x.shadowRoot) { const h = deepQuery(s, x.shadowRoot); if (h) return h; }
    return null;
  };
  const e = deepQuery(sel);
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

// read_page / find: compact role+name tree with stable refs (data-bm-ref), walking open shadow roots.
// opts: { mode: 'tree' | 'find', filter: 'interactive' | 'all', maxChars, ref, query }
export function snapshotPage(opts) {
  try {
    const { mode = 'tree', filter = 'interactive', maxChars = 30000, ref = null, query = '' } = opts || {};
    const ATTR = 'data-bm-ref', NEXT = 'data-bm-ref-next';
    const deepQuery = (sel, root = document) => {
      const hit = root.querySelector(sel);
      if (hit) return hit;
      for (const e of root.querySelectorAll('*')) if (e.shadowRoot) { const h = deepQuery(sel, e.shadowRoot); if (h) return h; }
      return null;
    };
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'SLOT', 'BR', 'WBR']);
    const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
      'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'fileinput', 'clickable']);
    const NAME_FROM_CONTENT = new Set(['link', 'button', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
      'treeitem', 'cell', 'columnheader', 'rowheader', 'clickable', 'switch', 'listitem', 'paragraph']);
    const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button',
      image: 'button', file: 'fileinput', search: 'searchbox', number: 'spinbutton' };
    const TAG_ROLES = { BUTTON: 'button', TEXTAREA: 'textbox', OPTION: 'option', NAV: 'navigation', MAIN: 'main', HEADER: 'banner',
      FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog', TABLE: 'table', TR: 'row', TH: 'columnheader',
      TD: 'cell', UL: 'list', OL: 'list', LI: 'listitem', SUMMARY: 'button', DETAILS: 'group', IFRAME: 'iframe', VIDEO: 'video',
      P: 'paragraph', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading' };

    const hidden = el => {
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
      if (el.checkVisibility) return !el.checkVisibility({ visibilityProperty: true });
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden';
    };
    const roleOf = el => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit.split(/\s+/)[0];
      const tag = el.tagName;
      if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
      if (tag === 'INPUT') return INPUT_ROLES[(el.type || '').toLowerCase()] || 'textbox';
      if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      if (tag === 'IMG') return el.getAttribute('alt') === '' ? null : 'img';
      if (tag === 'svg' || tag === 'SVG') return el.getAttribute('aria-label') || el.querySelector('title') ? 'img' : null;
      if (TAG_ROLES[tag]) return TAG_ROLES[tag];
      if (el.isContentEditable && el.hasAttribute('contenteditable')) return 'textbox';
      // div/span "buttons" in app UIs (Grafana, GCP): pointer cursor not inherited from a pointer parent
      if (el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0)) return 'clickable';
      const parent = el.parentElement;
      if (getComputedStyle(el).cursor === 'pointer' && (!parent || getComputedStyle(parent).cursor !== 'pointer')) return 'clickable';
      return null;
    };
    const nameOf = (el, role) => {
      const al = el.getAttribute('aria-label');
      if (al && clean(al)) return clean(al);
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const root = el.getRootNode();
        const t = lb.split(/\s+/).map(id => (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id))
          .filter(Boolean).map(e => e.textContent).join(' ');
        if (clean(t)) return clean(t);
      }
      if (el.labels && el.labels.length) {
        const t = clean([...el.labels].map(l => l.innerText || l.textContent).join(' '));
        if (t) return t;
      }
      if (el.tagName === 'IMG' && el.alt) return clean(el.alt);
      if (role === 'img' && el.querySelector && el.querySelector('title')) return clean(el.querySelector('title').textContent);
      if (role === 'button' && el.tagName === 'INPUT' && el.value) return clean(el.value);
      if (NAME_FROM_CONTENT.has(role) || role === 'clickable') {
        const t = clean(el.innerText || el.textContent);
        if (t) return t;
      }
      return clean(el.getAttribute('title') || '');
    };
    const directText = el => clean([...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' '));
    const childrenOf = el => [...(el.shadowRoot ? el.shadowRoot.children : []), ...el.children];

    // Collect candidate nodes in document order: {el, depth, role, name, interactive, text}
    const nodes = [];
    // named: inside a node whose name comes from its content, so plain text below it is already shown
    const walk = (el, depth, named) => {
      if (!el || SKIP.has(el.tagName) || hidden(el)) return;
      const role = roleOf(el);
      const interactive = INTERACTIVE.has(role);
      let include = false, text = '';
      if (interactive) include = true;
      else if (mode === 'find' || filter === 'all') {
        if (role && !['list', 'row', 'group'].includes(role)) include = !named;
        else if (!named) { text = directText(el); include = text.length > 0; }
      }
      if (include) nodes.push({ el, depth, role, interactive, text });
      if (role === 'iframe' || role === 'img') return;
      const nowNamed = named || (include && NAME_FROM_CONTENT.has(role));
      for (const c of childrenOf(el)) walk(c, include ? depth + 1 : depth, nowNamed);
    };
    const start = ref != null ? deepQuery(`[${ATTR}="${String(ref).replace(/\D/g, '')}"]`) : document.body;
    if (ref != null && !start) return { error: `ref ${ref} not found (page changed? read the page again)` };
    walk(start, 0, false);

    const root = document.documentElement;
    let next = parseInt(root.getAttribute(NEXT) || '1', 10) || 1;
    const refOf = el => {
      let r = el.getAttribute(ATTR);
      if (!r) { r = String(next++); el.setAttribute(ATTR, r); }
      return r;
    };
    const lineOf = (n, indent) => {
      const el = n.el;
      if (!n.role) return `${indent}text "${cut(n.text, 120)}"`;
      const name = cut(nameOf(el, n.role), 100);
      const bits = [`${indent}${n.role}${name ? ` "${name.replace(/"/g, "'")}"` : ''} [ref=${refOf(el)}]`];
      if (n.role === 'heading') bits.push(`level=${el.getAttribute('aria-level') || el.tagName.slice(1)}`);
      if ('value' in el && ['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox'].includes(n.role) && el.value) bits.push(`value="${cut(String(el.value), 60)}"`);
      if (el.placeholder && !name) bits.push(`placeholder="${cut(el.placeholder, 60)}"`);
      else if (el.placeholder) bits.push(`placeholder="${cut(el.placeholder, 40)}"`);
      if (el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true') bits.push('checked');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
      if (el.getAttribute('aria-expanded')) bits.push(`expanded=${el.getAttribute('aria-expanded')}`);
      if (n.role === 'link') {
        const href = el.getAttribute('href') || '';
        let h = href;
        try { const u = new URL(href, location.href); h = u.origin === location.origin ? u.pathname + u.search : u.href; } catch {}
        bits.push(`href="${cut(h, 80)}"`);
      }
      if (n.role === 'iframe' && el.src) bits.push(`src="${cut(el.src, 80)}"`);
      return bits.join(' ');
    };

    const meta = {
      url: location.href, title: document.title,
      scroll: { y: Math.round(scrollY), height: document.scrollingElement ? document.scrollingElement.scrollHeight : 0, viewport: innerHeight },
    };
    if (mode === 'find') {
      const q = clean(query).toLowerCase();
      const tokens = q.split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1);
      if (!tokens.length) return { ...meta, error: 'query is empty' };
      const scored = [];
      nodes.forEach((n, i) => {
        const name = n.role ? nameOf(n.el, n.role) : n.text;
        const extra = [n.el.getAttribute && n.el.getAttribute('placeholder'), n.el.getAttribute && n.el.getAttribute('title'),
          'value' in n.el && typeof n.el.value === 'string' ? n.el.value : '', n.el.id].filter(Boolean).join(' ');
        const hay = `${n.role || 'text'} ${name} ${extra}`.toLowerCase();
        const squash = hay.replace(/\s+/g, '');
        let hit = 0;
        for (const t of tokens) if (hay.includes(t) || squash.includes(t)) hit++;
        if (!hit) return;
        let score = hit / tokens.length;
        if (hay.includes(q) || squash.includes(q.replace(/\s+/g, ''))) score += 0.5;
        if (n.interactive) score += 0.2;
        scored.push({ n, score, i });
      });
      scored.sort((a, b) => b.score - a.score || a.i - b.i);
      const top = scored.slice(0, 20);
      const out = top.map(s => lineOf(s.n, ''));
      root.setAttribute(NEXT, String(next));
      return { ...meta, matches: scored.length, lines: out };
    }

    const lines = nodes.map(n => lineOf(n, '  '.repeat(n.depth)));
    root.setAttribute(NEXT, String(next));
    let total = 0, kept = [];
    for (const l of lines) total += l.length + 1;
    let used = 0;
    for (const l of lines) { if (used + l.length + 1 > maxChars) break; kept.push(l); used += l.length + 1; }
    return { ...meta, nodes: lines.length, chars: total, truncated: kept.length < lines.length, tree: kept.join('\n') };
  } catch (e) {
    return { error: `read_page failed in page: ${e && e.message}` };
  }
}

// get_page_text: readable text of the main content (article/main when substantial, else body)
export function pageText(maxChars) {
  const clean = t => (t || '').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const candidates = [document.querySelector('article'), document.querySelector('main'), document.querySelector('[role=main]')].filter(Boolean);
  const body = clean(document.body ? document.body.innerText : '');
  let root = 'body', text = body;
  for (const c of candidates) {
    const t = clean(c.innerText);
    if (t.length > 200 || t.length > body.length * 0.25) { root = c.tagName.toLowerCase(); text = t; break; }
  }
  return { url: location.href, title: document.title, source: root, chars: text.length, truncated: text.length > maxChars, text: text.slice(0, maxChars) };
}

// wait_for probe: is the selector present (open shadow roots included) / is the text on the page?
export function waitProbe(p) {
  const deepQuery = (sel, root = document) => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) { const h = deepQuery(sel, e.shadowRoot); if (h) return h; }
    return null;
  };
  const out = {};
  try {
    if (p.selector) out.selector = !!deepQuery(p.selector);
  } catch (e) {
    return { error: `bad selector: ${e.message}` };
  }
  if (p.text) out.text = !!document.body && document.body.innerText.includes(p.text);
  return out;
}

// upload, debugger path: the file input itself (Runtime.evaluate keeps it as a remote object), or an error string
export function uploadTarget(sel) {
  const deepQuery = (s, root = document) => {
    const hit = root.querySelector(s);
    if (hit) return hit;
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) { const h = deepQuery(s, e.shadowRoot); if (h) return h; }
    return null;
  };
  const el = deepQuery(sel);
  if (!el) return `no element matches ${sel}`;
  if (el.tagName !== 'INPUT' || el.type !== 'file') return `element is <${el.tagName.toLowerCase()}${el.type ? ` type=${el.type}` : ''}>, not a file input`;
  return el;
}

// upload, no-debugger fallback: build Files from base64 and assign them like a user pick (input + change fire)
export function setInputFiles(sel, files) {
  const deepQuery = (s, root = document) => {
    const hit = root.querySelector(s);
    if (hit) return hit;
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) { const h = deepQuery(s, e.shadowRoot); if (h) return h; }
    return null;
  };
  const el = deepQuery(sel);
  if (!el) return `no element matches ${sel}`;
  if (el.tagName !== 'INPUT' || el.type !== 'file') return 'not a file input';
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type || 'application/octet-stream' }));
  }
  el.files = dt.files;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
}
