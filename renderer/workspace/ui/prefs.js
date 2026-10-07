import { $, el, toast, confirmBox } from './common.js';
import { THEMES, applyTheme, currentTheme } from './themes.js';
import { openSetupTokenTab } from './terms.js';

// Preferences modal (⚙ in the top bar). Absorbs the header controls that
// cluttered it — terminal layout, logs folder, auto-resume — and owns the
// theme picker. New settings = one row here + one key in the state snapshot.

export function init(opts) {
  // opts: { wsId, onThemePicked(id), layoutLabel: () => string }
  const modal = $('#prefs-modal');

  const close = () => modal.classList.add('hidden');
  modal.tabIndex = -1; // so Esc works right after opening via the header button
  // notification switches: machine-wide (main/notifyprefs.cjs), so they are
  // re-read every time the modal opens — another workspace may have changed them
  const NOTIFY = ['waiting', 'failed', 'done'];
  const loadNotify = async () => {
    const p = await vs.notifyGet().catch(() => null);
    if (!p) return;
    for (const k of NOTIFY) $('#notify-' + k).checked = Boolean(p[k]);
  };
  for (const k of NOTIFY) {
    $('#notify-' + k).addEventListener('change', (e) => {
      vs.notifySet({ [k]: e.target.checked }).catch(() => toast('Could not save the notification setting', 'err'));
    });
  }

  $('#btn-prefs').onclick = () => {
    modal.classList.remove('hidden');
    modal.focus();
    markActiveTheme();
    loadNotify();
    loadAccounts();
    $('#btn-layout').title = opts.layoutLabel(); // title lives on the modal's copy now
  };
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // accounts: machine-wide (main/accounts.cjs) — loaded on open, live while open
  const loadAccounts = () => vs.accountsList().then(renderAccounts).catch(() => {});
  vs.onAccountsChanged((st) => { if (!modal.classList.contains('hidden')) renderAccounts(st); });
  const acctErr = (msg) => {
    const e = $('#acct-error');
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
  };
  const addAccount = async () => {
    const label = $('#acct-label').value.trim();
    const token = $('#acct-token').value.trim();
    if (!label) { acctErr('Give the account a label'); return; }
    if (!token) { acctErr('Paste the token from claude setup-token'); return; }
    acctErr('');
    $('#acct-add-btn').disabled = true;
    try {
      const r = await vs.accountsAdd(label, token);
      if (r && r.ok) {
        $('#acct-label').value = '';
        $('#acct-token').value = '';
        renderAccounts(r.state);
      } else acctErr((r && r.error) || 'Could not add the account');
    } catch (e) {
      acctErr(e.message || String(e));
    } finally {
      $('#acct-token').value = ''; // never leave a token sitting in the field
      $('#acct-add-btn').disabled = false;
    }
  };
  $('#acct-add-btn').onclick = addAccount;
  for (const id of ['#acct-label', '#acct-token']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAccount(); } });
  }
  $('#btn-setup-token').onclick = () => { close(); openSetupTokenTab(); };

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

  function renderAccounts(st) {
    if (!st || !Array.isArray(st.accounts)) return;
    const list = $('#acct-list');
    if (list.querySelector('.acct-rename')) return; // mid-rename: a change push would kill the input
    list.innerHTML = '';
    const act = (p) => p.then((s) => renderAccounts(s)).catch((e) => toast('Accounts: ' + (e.message || e), 'err'));
    st.accounts.forEach((a, i) => {
      const row = el('div', 'prefs-row acct-row');
      const info = el('div');
      info.style.minWidth = '0';
      const nameLine = el('div', 'acct-name');
      const name = el('div', 'prefs-label', a.label);
      name.title = 'Double-click to rename';
      const edit = el('button', 'btn small ghost', '✎');
      edit.title = 'Rename';
      const rename = () => {
        const input = el('input', 'acct-rename');
        input.value = a.label;
        input.maxLength = 40;
        name.replaceWith(input);
        edit.remove();
        input.focus();
        input.select();
        let done = false;
        const finish = (save) => {
          if (done) return;
          done = true;
          const v = input.value.trim();
          input.remove(); // let renderAccounts rebuild
          if (save && v && v !== a.label) act(vs.accountsRename(a.id, v));
          else loadAccounts();
        };
        input.onblur = () => finish(true);
        input.onkeydown = (e) => {
          e.stopPropagation(); // Esc must cancel the rename, not close the modal
          if (e.key === 'Enter') finish(true);
          if (e.key === 'Escape') finish(false);
        };
      };
      name.ondblclick = rename;
      edit.onclick = rename;
      nameLine.append(name, edit);
      const out = a.exhaustedUntil && a.exhaustedUntil > Date.now();
      const hint = el('div', 'prefs-hint');
      hint.append(el('span', '', a.kind === 'login' ? 'logged in · phone control · connectors' : 'token · no phone control · no claude.ai connectors'), document.createTextNode(' · '));
      const status = el('span', out ? 'acct-out' : '', out ? `out until ${untilText(a.exhaustedUntil)}` : 'available');
      if (out && a.reason) status.title = a.reason;
      hint.append(status);
      info.append(nameLine, hint);

      const actions = el('div', 'acct-actions');
      if (out) {
        const reset = el('button', 'btn small ghost', 'reset');
        reset.title = 'Forget the limit — agents may use this account again';
        reset.onclick = () => act(vs.accountsClear(a.id));
        actions.append(reset);
      }
      if (st.accounts.length >= 2) {
        const all = el('button', 'btn small ghost', 'Move all here');
        all.title = out
          ? 'This account is out of usage right now'
          : 'Make this the first choice and move every open agent to it, in all workspaces.\nIdle agents move now, one at a time. Busy ones move when their turn ends. Nothing is interrupted.';
        all.disabled = Boolean(out);
        all.onclick = () => act(vs.accountsSwitchAll(a.id));
        actions.append(all);
      }
      const up = el('button', 'btn small ghost', '↑');
      up.title = 'Prefer this account';
      up.disabled = i === 0;
      up.onclick = () => act(vs.accountsMove(a.id, -1));
      const down = el('button', 'btn small ghost', '↓');
      down.title = 'Prefer it less';
      down.disabled = i === st.accounts.length - 1;
      down.onclick = () => act(vs.accountsMove(a.id, +1));
      actions.append(up, down);
      if (a.kind === 'token') {
        const rm = el('button', 'btn small ghost', '✕');
        rm.title = 'Remove this account';
        rm.onclick = async () => {
          if (!(await confirmBox(`Remove the account "${a.label}"?\nIts stored token is deleted from this PC.`, { ok: 'Remove', danger: true }))) return;
          act(vs.accountsRemove(a.id));
        };
        actions.append(rm);
      }
      row.append(info, actions);
      list.appendChild(row);
    });
  }

  function markActiveTheme() {
    const cur = currentTheme().id;
    for (const card of grid.children) card.classList.toggle('active', card.dataset.theme === cur);
  }
}

// "Mon 15:00" for an exhaustion deadline (local time)
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function untilText(ms) {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
