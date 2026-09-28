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
