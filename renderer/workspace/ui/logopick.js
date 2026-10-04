// "Change workspace logo" picker. The logo nearly always lives in the repo
// already (public/logo.png, a favicon, an app icon), so show the images found
// there (main/logoscan.cjs, best guess first) and keep Browse… for anything
// else. Resolves to an absolute file path, or null when cancelled.
import { el } from './common.js';

export function pickLogo() {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const back = el('div', 'info-modal');
    const box = el('div', 'info-box logo-box');
    box.appendChild(el('h3', '', 'Change workspace logo'));
    const hint = el('div', 'logo-hint', 'Searching this repo for images…');
    const grid = el('div', 'logo-grid');
    const actions = el('div', 'info-actions');
    const browse = el('button', 'btn small', 'Browse…');
    browse.title = 'Pick any image file (opens in this repo’s folder)';
    const cancel = el('button', 'btn small', 'Cancel');
    actions.append(browse, cancel);
    box.append(hint, grid, actions);
    back.appendChild(box);
    document.body.appendChild(back);

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      back.remove();
      // same focus rule as confirmBox: back to where it was, else the visible terminal
      const target = prevFocus && prevFocus !== document.body && prevFocus.isConnected
        ? prevFocus
        : [...document.querySelectorAll('.xterm-helper-textarea')].find((t) => t.offsetParent !== null);
      try { target && target.focus(); } catch {}
      resolve(v);
    };
    // capture + stop: Esc must not also reach xterm or the app's shortcuts
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    };
    window.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (e) => { if (e.target === back) finish(null); });
    cancel.onclick = () => finish(null);
    browse.onclick = async () => {
      browse.disabled = true; // a second click would open a second file dialog
      const file = await window.vs.pickLogo().catch(() => null);
      browse.disabled = false;
      if (file) finish(file); // cancelled dialog: the picker stays open
    };

    window.vs.logoCandidates().then((list) => {
      if (done) return;
      if (!list || !list.length) {
        hint.textContent = 'No images found in this repo. Use Browse… to pick a file, or drop an image on the logo.';
        return;
      }
      hint.textContent = `${list.length} image${list.length === 1 ? '' : 's'} from this repo, most logo-like first. Click one to use it.`;
      for (const c of list) {
        const b = el('button', 'logo-cand');
        const slash = c.rel.lastIndexOf('/');
        b.title = c.rel + (c.w && c.h ? `\n${c.w} × ${c.h}` : '');
        const img = el('img');
        img.src = c.thumb;
        img.alt = '';
        b.append(img, el('div', 'logo-name', c.rel.slice(slash + 1)), el('div', 'logo-dir', slash < 0 ? '(repo root)' : c.rel.slice(0, slash)));
        b.onclick = () => finish(c.path);
        grid.appendChild(b);
      }
    }).catch((e) => {
      if (!done) hint.textContent = 'Could not search the repo (' + (e.message || e) + '). Use Browse… to pick a file.';
    });
    browse.focus();
  });
}
