import { $, el } from './common.js';
import { THEMES, applyTheme, currentTheme } from './themes.js';

// Preferences modal (⚙ in the top bar). Absorbs the header controls that
// cluttered it — terminal layout, logs folder, auto-resume — and owns the
// theme picker. New settings = one row here + one key in the state snapshot.

export function init(opts) {
  // opts: { wsId, onThemePicked(id), layoutLabel: () => string }
  const modal = $('#prefs-modal');

  const close = () => modal.classList.add('hidden');
  modal.tabIndex = -1; // so Esc works right after opening via the header button
  $('#btn-prefs').onclick = () => {
    modal.classList.remove('hidden');
    modal.focus();
    markActiveTheme();
    $('#btn-layout').title = opts.layoutLabel(); // title lives on the modal's copy now
  };
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // rows that moved out of the header
  $('#btn-logs').onclick = () => vs.openLogs();
  $('#auto-resume').addEventListener('change', opts.persist);
  $('#phone-remote').addEventListener('change', opts.persist);

  // theme swatch grid — click = instant live preview, persisted by the caller
  const grid = $('#theme-grid');
  for (const t of THEMES) {
    const card = el('button', 'theme-card');
    card.type = 'button';
    card.dataset.theme = t.id;
    card.title = t.name + (t.mode === 'light' ? ' (light)' : '');
    const bar = el('span', 'theme-bar');
    for (const c of t.swatch) {
      const dot = el('span', 'theme-dot');
      dot.style.background = c;
      bar.appendChild(dot);
    }
    const name = el('span', 'theme-name', t.name);
    card.append(bar, name);
    card.onclick = () => {
      applyTheme(t.id, opts.wsId);
      opts.onThemePicked(t.id);
      markActiveTheme();
    };
    grid.appendChild(card);
  }

  function markActiveTheme() {
    const cur = currentTheme().id;
    for (const card of grid.children) card.classList.toggle('active', card.dataset.theme === cur);
  }
}
