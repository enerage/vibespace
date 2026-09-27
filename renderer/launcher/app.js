'use strict';
const $ = (sel) => document.querySelector(sel);

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

let logoPath = null;

async function refresh() {
  const list = await vs.listWorkspaces();
  const grid = $('#grid');
  grid.innerHTML = '';
  $('#empty').classList.toggle('hidden', list.length > 0);

  for (const ws of list) {
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const img = document.createElement('img');
    img.className = 'card-icon';
    img.src = 'app://local/icons/' + encodeURIComponent(ws.iconPath.split(/[\\/]/).pop());
    img.onerror = () => { img.style.visibility = 'hidden'; };
    const headTxt = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = ws.name;
    const pathEl = document.createElement('div');
    pathEl.className = 'card-path';
    pathEl.textContent = ws.repoPath;
    pathEl.title = ws.repoPath;
    headTxt.append(title, pathEl);
    head.append(img, headTxt);

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const open = document.createElement('button');
    open.className = 'btn primary small';
    open.textContent = 'Open';
    open.onclick = async () => {
      const r = await vs.openWorkspace(ws.id);
      if (!r.ok) toast(r.error || 'failed to open', 'err');
    };

    const pin = document.createElement('button');
    pin.className = 'btn small';
    pin.textContent = 'Pin to taskbar';
    pin.onclick = async () => {
      pin.disabled = true;
      pin.textContent = 'Pinning…';
      const r = await vs.createShortcut(ws.id);
      pin.disabled = false;
      pin.textContent = 'Pin to taskbar';
      if (r.ok && r.persisted) {
        toast(`"${ws.name}" pinned — check desktop & Start Menu, then right-click → Pin to taskbar`, 'ok');
      } else if (r.ok) {
        toast('Shortcut created, but icon identity could not be verified', 'err');
      } else {
        toast('Shortcut creation failed: ' + (r.details || []).join(' | '), 'err');
      }
    };

    const logo = document.createElement('button');
    logo.className = 'btn small ghost';
    logo.textContent = 'Logo…';
    logo.title = 'Change this workspace\'s logo (taskbar + window icon)';
    logo.onclick = async () => {
      const p = await vs.pickLogo();
      if (!p) return;
      await vs.updateLogo(ws.id, p);
      toast(`Logo updated for "${ws.name}" — re-pin the shortcut to refresh its icon`, 'ok');
      refresh();
    };

    const reveal = document.createElement('button');
    reveal.className = 'btn small ghost';
    reveal.textContent = 'Folder';
    reveal.onclick = () => vs.reveal(ws.repoPath);

    const del = document.createElement('button');
    del.className = 'btn small ghost danger';
    del.textContent = 'Remove';
    del.onclick = async () => {
      if (!confirm(`Remove workspace "${ws.name}"?\n(Your repo is untouched; shortcuts and saved terminal state are deleted.)`)) return;
      await vs.removeWorkspace(ws.id);
      refresh();
    };

    actions.append(open, pin, logo, reveal, del);
    card.append(head, actions);
    grid.appendChild(card);
  }
}

async function refreshExplorerButton() {
  const btn = $('#btn-explorer');
  const { installed } = await vs.contextMenu('status');
  btn.textContent = installed ? '🧩 Right-click: ON' : '🧩 Right-click menu';
  btn.classList.toggle('primary', !installed);
  btn.dataset.installed = installed ? '1' : '';
}

function wireExplorerButton() {
  $('#btn-explorer').onclick = async () => {
    const btn = $('#btn-explorer');
    const installed = btn.dataset.installed === '1';
    if (installed) {
      if (!confirm('Remove "Open with VibeSpace" from the folder right-click menu?')) return;
      await vs.contextMenu('uninstall');
      toast('Right-click menu removed');
    } else {
      const r = await vs.contextMenu('install');
      if (r.installed) {
        toast('Added! Right-click any folder → "Show more options" → Open with VibeSpace (Windows 11)', 'ok');
      } else {
        toast('Could not add the right-click menu — see logs', 'err');
      }
    }
    refreshExplorerButton();
  };
}

function wireForm() {
  const panel = $('#form-panel');
  $('#btn-new').onclick = () => {
    panel.classList.remove('hidden');
    $('#f-name').focus();
  };
  $('#f-cancel').onclick = () => panel.classList.add('hidden');

  $('#f-browse-path').onclick = async () => {
    const p = await vs.pickRepo();
    if (p) {
      $('#f-path').value = p;
      if (!$('#f-name').value) $('#f-name').value = p.split(/[\\/]/).pop();
    }
  };
  $('#f-browse-logo').onclick = async () => {
    const p = await vs.pickLogo();
    if (p) {
      logoPath = p;
      $('#f-logo').value = p.split(/[\\/]/).pop();
      const dataUrl = await vs.imageDataUrl(p);
      const prev = $('#f-logo-preview');
      if (dataUrl) { prev.src = dataUrl; prev.classList.remove('hidden'); }
    }
  };
  $('#f-logo').onclick = () => $('#f-browse-logo').click();

  $('#f-create').onclick = async () => {
    const name = $('#f-name').value.trim();
    const repoPath = $('#f-path').value.trim();
    if (!repoPath) return toast('Pick a repository folder first', 'err');
    const btn = $('#f-create');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const ws = await vs.createWorkspace({ name, repoPath, logoPath });
      toast(`Workspace "${ws.name}" created — now pin it to the taskbar`, 'ok');
      panel.classList.add('hidden');
      $('#f-name').value = $('#f-path').value = $('#f-logo').value = '';
      logoPath = null;
      $('#f-logo-preview').classList.add('hidden');
      refresh();
    } catch (e) {
      toast('Create failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create';
    }
  };
}

async function main() {
  wireForm();
  wireExplorerButton();
  refreshExplorerButton();
  $('#btn-logs').onclick = () => vs.openLogs();
  refresh();
  const ver = await vs.claudeVersion();
  $('#claude-version').textContent = ver ? ver.split('\n')[0] : 'claude not found';
}

main();
