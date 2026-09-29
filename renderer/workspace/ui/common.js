export const $ = (sel) => document.querySelector(sel);

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function toast(msg, kind = '') {
  const t = el('div', `toast ${kind}`, msg);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

// Small centered text prompt — Electron has no window.prompt. Resolves with
// the input value (OK/Enter) or null (Cancel/Esc/click outside the box).
export function askText(title, value = '') {
  return new Promise((resolve) => {
    const modal = $('#ask-modal');
    const input = $('#ask-input');
    if (!modal || !input) return resolve(null);
    $('#ask-title').textContent = title;
    input.value = value;
    modal.classList.remove('hidden');
    input.focus();
    // preselect the name without its extension — the usual rename gesture
    const dot = value.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      modal.classList.add('hidden');
      input.removeEventListener('keydown', onKey);
      modal.removeEventListener('mousedown', onBackdrop);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
    const onBackdrop = (e) => { if (e.target === modal) done(null); };
    input.addEventListener('keydown', onKey);
    modal.addEventListener('mousedown', onBackdrop);
    $('#ask-ok').onclick = () => done(input.value);
    $('#ask-cancel').onclick = () => done(null);
  });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function fileIcon(name) {
  const m = name.match(/\.([a-z0-9]+)$/i);
  const ext = m ? m[1].toLowerCase() : '';
  const label = ext ? ext.slice(0, 3) : '·';
  return `<span class="ficon ext-${ext}">${label}</span>`;
}

// ---------- context menu (tree rows, terminal tabs) ----------
// items: [{ label, run, danger?, disabled?, hint? } | { sep: true }]. Lives on
// document.body so tree rebuilds / tab-bar redraws can't take it down; closes
// on any outside click, Esc, window blur, resize or scroll.
let ctxMenu = null;

export function menuOpen() { return Boolean(ctxMenu); }

export function showMenu(x, y, items) {
  closeMenu();
  const menu = el('div', 'ctx-menu');
  for (const it of items) {
    if (it.sep) { menu.appendChild(el('div', 'ctx-sep')); continue; }
    const item = el('div', 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''), it.label);
    if (it.hint) item.title = it.hint;
    item.onclick = (ev) => {
      ev.stopPropagation();
      if (it.disabled) return;
      closeMenu();
      it.run();
    };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  ctxMenu = menu;
  const r = menu.getBoundingClientRect(); // keep it on screen
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  window.addEventListener('mousedown', menuCloser, true);
  window.addEventListener('keydown', menuCloser, true);
  window.addEventListener('blur', menuCloser);
  window.addEventListener('resize', menuCloser);
  window.addEventListener('scroll', menuCloser, true);
}

function menuCloser(ev) {
  if (!ctxMenu) return;
  if (ev.type === 'keydown' && ev.key !== 'Escape') return;
  if (ev.type === 'mousedown' && ctxMenu.contains(ev.target)) return; // let item clicks run
  closeMenu();
}

export function closeMenu() {
  if (!ctxMenu) return;
  const m = ctxMenu;
  ctxMenu = null;
  m.remove();
  window.removeEventListener('mousedown', menuCloser, true);
  window.removeEventListener('keydown', menuCloser, true);
  window.removeEventListener('blur', menuCloser);
  window.removeEventListener('resize', menuCloser);
  window.removeEventListener('scroll', menuCloser, true);
}
