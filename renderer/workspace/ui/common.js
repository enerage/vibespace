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

// ---------- hover card (menu rows, board chips) ----------
// One floating card beside an anchor rect (peek-card look). It never takes
// focus; the pointer may travel into it (short grace) to scroll it.
let card = null;
let cardOpenTimer = null;
let cardHideTimer = null;
let menuLeave = null; // the open menu's leave handler (hover-opened menus)
let menuEnter = null;

// place: 'side' (beside the anchor: menu rows) or 'above' (board chips in a row)
export function showCard(content, anchorRect, { place = 'side' } = {}) {
  clearTimeout(cardOpenTimer);
  clearTimeout(cardHideTimer);
  if (!card) {
    card = el('div', 'fu-pop fu-peek hover-card hidden');
    card.addEventListener('mousedown', (e) => e.preventDefault());
    card.addEventListener('mouseenter', () => { clearTimeout(cardHideTimer); if (menuEnter) menuEnter(); });
    card.addEventListener('mouseleave', () => { hideCardSoon(); if (menuLeave) menuLeave(); });
    document.body.appendChild(card);
  }
  card.innerHTML = '';
  card.append(content);
  card.classList.remove('hidden');
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  if (place === 'above') { // over the anchor (below when there's no room), neighbours stay reachable
    const above = anchorRect.top - h - 6;
    card.style.left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - w - 8)) + 'px';
    card.style.top = (above >= 8 ? above : Math.min(anchorRect.bottom + 6, window.innerHeight - h - 8)) + 'px';
    return;
  }
  let left = anchorRect.right + 6; // beside the anchor; flip left when there's no room
  if (left + w > window.innerWidth - 8) left = Math.max(8, anchorRect.left - w - 6);
  card.style.left = left + 'px';
  card.style.top = Math.max(8, Math.min(anchorRect.top, window.innerHeight - h - 8)) + 'px';
}

export function hideCard() {
  clearTimeout(cardOpenTimer);
  clearTimeout(cardHideTimer);
  if (card) card.classList.add('hidden');
}

export function hideCardSoon(ms = 200) {
  clearTimeout(cardHideTimer);
  cardHideTimer = setTimeout(hideCard, ms);
}

// hover ~250 ms → card(); content is built only when it opens
export function cardOnHover(target, build, { place = 'side' } = {}) {
  target.addEventListener('mouseenter', () => {
    clearTimeout(cardOpenTimer);
    clearTimeout(cardHideTimer);
    cardOpenTimer = setTimeout(() => { if (target.isConnected) showCard(build(), target.getBoundingClientRect(), { place }); }, 250);
  });
  target.addEventListener('mouseleave', () => { clearTimeout(cardOpenTimer); hideCardSoon(); });
}

// ---------- context menu (tree rows, terminal tabs) ----------
// items: [{ label, run, danger?, disabled?, hint?, meta?, card?, action? }
//         | { sep: true } | { section: 'TITLE' }]
//   section: small dim non-clickable label
//   meta: right-aligned dim text · card(): element for a hover card beside the row
//   action: { label, hint?, run } — a small secondary button on the row (✕ forget)
// opts.leaveClose: [elements] — a hover-opened menu closes once the pointer has
// left it, those elements and its card for a moment.
// Lives on document.body so tree rebuilds / tab-bar redraws can't take it down;
// closes on any outside click, Esc, window blur, resize or scroll.
let ctxMenu = null;
let leaveTimer = null;
let leaveZones = [];

export function menuOpen() { return Boolean(ctxMenu); }

export function showMenu(x, y, items, opts = {}) {
  closeMenu();
  const menu = el('div', 'ctx-menu');
  for (const it of items) {
    if (it.sep) { menu.appendChild(el('div', 'ctx-sep')); continue; }
    if (it.section) { menu.appendChild(el('div', 'ctx-section', it.section)); continue; }
    const rich = Boolean(it.meta || it.action);
    const item = el('div', 'ctx-item' + (rich ? ' rich' : '') + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''), rich ? undefined : it.label);
    if (rich) {
      item.append(el('span', 'ctx-label', it.label));
      if (it.meta) item.append(el('span', 'ctx-meta', it.meta));
      if (it.action) {
        const act = el('span', 'ctx-act', it.action.label);
        if (it.action.hint) act.title = it.action.hint;
        act.onclick = (ev) => { ev.stopPropagation(); closeMenu(); it.action.run(); };
        item.append(act);
      }
    }
    if (it.hint) item.title = it.hint;
    if (it.card) cardOnHover(item, it.card);
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
  if (Array.isArray(opts.leaveClose)) {
    menuEnter = () => clearTimeout(leaveTimer);
    menuLeave = () => { clearTimeout(leaveTimer); leaveTimer = setTimeout(() => { if (ctxMenu === menu) closeMenu(); }, 400); };
    leaveZones = [menu, ...opts.leaveClose];
    for (const z of leaveZones) { z.addEventListener('mouseenter', menuEnter); z.addEventListener('mouseleave', menuLeave); }
  }
  window.addEventListener('mousedown', menuCloser, true);
  window.addEventListener('keydown', menuCloser, true);
  window.addEventListener('blur', menuCloser);
  window.addEventListener('resize', menuCloser);
  window.addEventListener('scroll', menuCloser, true);
}

function menuCloser(ev) {
  if (!ctxMenu) return;
  if (ev.type === 'keydown' && ev.key !== 'Escape') return;
  // let item clicks run; scrolling the hover card or the menu keeps it open
  if ((ev.type === 'mousedown' || ev.type === 'scroll') && ev.target instanceof Node
    && (ctxMenu.contains(ev.target) || (card && card.contains(ev.target)))) return;
  closeMenu();
}

export function closeMenu() {
  if (!ctxMenu) return;
  const m = ctxMenu;
  ctxMenu = null;
  hideCard();
  clearTimeout(leaveTimer);
  for (const z of leaveZones) { z.removeEventListener('mouseenter', menuEnter); z.removeEventListener('mouseleave', menuLeave); }
  leaveZones = [];
  menuEnter = null;
  menuLeave = null;
  m.remove();
  window.removeEventListener('mousedown', menuCloser, true);
  window.removeEventListener('keydown', menuCloser, true);
  window.removeEventListener('blur', menuCloser);
  window.removeEventListener('resize', menuCloser);
  window.removeEventListener('scroll', menuCloser, true);
}

// ---------- in-page confirm (never window.confirm) ----------
// Native confirm()/alert() on Windows Electron leave the window without a real
// focus event after they close: keydown still arrives but keypress/beforeinput
// never fire until the window is re-focused (Alt / alt-tab). xterm sends a plain
// Space from keypress, so Space died in every agent tab while letters kept
// working (keydiag logs, 2026-09-29). Resolves true (OK/Enter) or false
// (Cancel/Esc/backdrop) and hands focus back to whatever had it (the terminal).
export function confirmBox(message, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const back = el('div', 'info-modal');
    const box = el('div', 'info-box confirm-box');
    box.appendChild(el('div', 'confirm-msg', message));
    const actions = el('div', 'info-actions');
    const no = el('button', 'btn small', cancel);
    const yes = el('button', 'btn small ' + (danger ? 'danger' : 'primary'), ok);
    actions.append(no, yes);
    box.appendChild(actions);
    back.appendChild(box);
    document.body.appendChild(back);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      back.remove();
      // back to what had focus; if that was nothing useful (body, or an element
      // the action removed), the visible terminal — typing must just work again
      const target = prevFocus && prevFocus !== document.body && prevFocus.isConnected
        ? prevFocus
        : [...document.querySelectorAll('.xterm-helper-textarea')].find((t) => t.offsetParent !== null);
      try { target && target.focus(); } catch {}
      resolve(v);
    };
    // capture + stop: Enter/Esc must not also reach xterm or the app's shortcuts
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    };
    window.addEventListener('keydown', onKey, true);
    no.onclick = () => finish(false);
    yes.onclick = () => finish(true);
    back.addEventListener('mousedown', (e) => { if (e.target === back) finish(false); });
    yes.focus();
  });
}
