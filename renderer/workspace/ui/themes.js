// Per-workspace color themes. Each theme is a compact palette spec; build()
// derives the full CSS-var set and the xterm ANSI palette from it (spec keys
// can override any derived value, and the default "vibespace" theme pins
// today's exact colors so nothing changes until a theme is picked).
//
// applyTheme() clears the previous theme's custom properties FIRST (a
// superset write would leave stale vars), sets color-scheme for native
// scrollbars/inputs, updates live xterm terms, and flips the Monaco base.
// theme-boot.js (loaded pre-stylesheet in index.html) replays the cached
// vars from localStorage so a saved theme never flashes the default.

// ---- tiny color helpers (hex only in specs) ----
const chan = (c) => {
  const h = c.replace('#', '');
  const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
};
const toHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => {
  const A = chan(a), B = chan(b);
  return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
};
const rgba = (c, a) => { const [r, g, b] = chan(c); return `rgba(${r},${g},${b},${a})`; };

function build(id, spec) {
  const { name, mode, bg, panel, panel2, border, text, dim, accent, accent2, ok, danger, yellow, o = {} } = spec;
  const dark = mode === 'dark';
  const lift = dark ? '#ffffff' : '#000000'; // brighten dark themes, deepen light ones
  const vars = {
    '--bg': bg, '--panel': panel, '--panel-2': panel2, '--border': border,
    '--text': text, '--dim': dim, '--accent': accent, '--accent-2': accent2,
    '--ok': ok, '--danger': danger, '--yellow': yellow,
    '--hover': o.hover || mix(bg, panel2, 0.6),
    '--hover-2': o.hover2 || mix(panel2, lift, dark ? 0.06 : 0.04),
    '--border-hover': o.borderHover || mix(border, lift, dark ? 0.18 : 0.12),
    '--hover-strong': o.hoverStrong || mix(panel2, lift, dark ? 0.14 : 0.09),
    '--tab-active': o.tabActive || mix(panel2, accent, 0.14),
    '--term-bg': o.termBg || mix(bg, '#000000', dark ? 0.15 : 0),
    '--accent-text': o.accentText || mix(accent, text, 0.45),
    '--status-idle': o.statusIdle || mix(bg, text, 0.18),
    '--text-strong': o.textStrong || mix(text, lift, dark ? 0.35 : 0.45),
    '--backdrop': o.backdrop || rgba(dark ? '#04080e' : '#7d879a', 0.66),
    '--toast-bg': o.toastBg || mix(panel2, bg, 0.25),
    '--border-soft': o.borderSoft || mix(border, bg, 0.4),
    '--ok-bright': o.okBright || mix(ok, lift, 0.25),
  };
  const term = {
    background: vars['--term-bg'],
    foreground: text,
    cursor: accent,
    selectionBackground: mix(bg, accent, 0.35),
    black: mix(bg, '#000000', dark ? 0.25 : 0.06),
    red: danger, green: ok, yellow,
    blue: mix(accent, bg, 0.1), magenta: accent2,
    cyan: o.cyan || mix(accent, '#22d3ee', 0.45),
    white: dark ? mix(text, '#ffffff', 0.2) : mix(text, '#000000', 0.15),
    brightBlack: dark ? mix(bg, '#ffffff', 0.3) : mix(bg, '#000000', 0.3),
    brightRed: mix(danger, lift, 0.15), brightGreen: mix(ok, lift, 0.15),
    brightYellow: mix(yellow, lift, 0.15), brightBlue: mix(accent, lift, 0.15),
    brightMagenta: mix(accent2, lift, 0.15), brightCyan: mix(accent, '#22d3ee', 0.6),
    brightWhite: dark ? '#f0f6fc' : mix(text, '#000000', 0.25),
    ...(o.term || {}),
  };
  return { id, name, mode, vars, term, monaco: dark ? 'vs-dark' : 'vs', swatch: [bg, panel2, accent, ok, danger] };
}

export const THEMES = [
  // default — every value pinned to pre-theme VibeSpace, byte-exact
  build('vibespace', { name: 'VibeSpace Dark', mode: 'dark',
    bg: '#0d1117', panel: '#161b22', panel2: '#1c2129', border: '#2d333b',
    text: '#e6edf3', dim: '#8b949e', accent: '#6e9cff', accent2: '#9d6cff',
    ok: '#3fb950', danger: '#f85149', yellow: '#d29222',
    o: {
      hover: '#1c2129', hover2: '#232933', borderHover: '#48505a', hoverStrong: '#3a4048',
      tabActive: '#20293a', termBg: '#0c0f14', accentText: '#b9cfff', statusIdle: '#3d444d',
      textStrong: '#ffffff', backdrop: 'rgba(4,8,14,0.66)', toastBg: '#202833',
      borderSoft: '#21262d', okBright: '#7ee787',
      term: { background: '#0c0f14', foreground: '#d7dee8', cursor: '#6e9cff', selectionBackground: '#31456e',
        black: '#1a1f28', red: '#f85149', green: '#3fb950', yellow: '#d29922',
        blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#d7dee8',
        brightBlack: '#6b7683', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#e3b341',
        brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc' },
    } }),
  build('nord', { name: 'Nord', mode: 'dark',
    bg: '#2e3440', panel: '#333b4a', panel2: '#3b4252', border: '#434c5e',
    text: '#eceff4', dim: '#9aa5b8', accent: '#88c0d0', accent2: '#b48ead',
    ok: '#a3be8c', danger: '#bf616a', yellow: '#ebcb8b' }),
  build('dracula', { name: 'Dracula', mode: 'dark',
    bg: '#282a36', panel: '#2f313f', panel2: '#343746', border: '#44475a',
    text: '#f8f8f2', dim: '#9aa0b3', accent: '#bd93f9', accent2: '#ff79c6',
    ok: '#50fa7b', danger: '#ff5555', yellow: '#f1fa8c' }),
  build('tokyo-night', { name: 'Tokyo Night', mode: 'dark',
    bg: '#1a1b26', panel: '#1f2233', panel2: '#24283b', border: '#343a55',
    text: '#c0caf5', dim: '#7982a9', accent: '#7aa2f7', accent2: '#bb9af7',
    ok: '#9ece6a', danger: '#f7768e', yellow: '#e0af68' }),
  build('one-dark', { name: 'One Dark', mode: 'dark',
    bg: '#282c34', panel: '#2e333d', panel2: '#333842', border: '#454b57',
    text: '#dcdfe4', dim: '#9aa2b1', accent: '#61afef', accent2: '#c678dd',
    ok: '#98c379', danger: '#e06c75', yellow: '#e5c07b' }),
  build('monokai', { name: 'Monokai', mode: 'dark',
    bg: '#272822', panel: '#2d2e27', panel2: '#33342c', border: '#45463c',
    text: '#f8f8f2', dim: '#a1a695', accent: '#66d9ef', accent2: '#f92672',
    ok: '#a6e22e', danger: '#f92672', yellow: '#e6db74', o: { cyan: '#66d9ef' } }),
  build('gruvbox-dark', { name: 'Gruvbox Dark', mode: 'dark',
    bg: '#282828', panel: '#2f2b26', panel2: '#3c3836', border: '#504945',
    text: '#ebdbb2', dim: '#a89984', accent: '#fabd2f', accent2: '#d3869b',
    ok: '#b8bb26', danger: '#fb4934', yellow: '#fabd2f' }),
  build('solarized-dark', { name: 'Solarized Dark', mode: 'dark',
    bg: '#002b36', panel: '#04313d', panel2: '#073642', border: '#12414c',
    text: '#d2d8db', dim: '#93a1a1', accent: '#268bd2', accent2: '#6c71c4',
    ok: '#859900', danger: '#dc322f', yellow: '#b58900' }),
  build('mocha', { name: 'Catppuccin Mocha', mode: 'dark',
    bg: '#1e1e2e', panel: '#24243a', panel2: '#2a2a3d', border: '#3b3b52',
    text: '#cdd6f4', dim: '#9399b2', accent: '#cba6f7', accent2: '#f5c2e7',
    ok: '#a6e3a1', danger: '#f38ba8', yellow: '#f9e2af' }),
  build('rose-pine', { name: 'Rosé Pine', mode: 'dark',
    bg: '#191724', panel: '#1f1d2e', panel2: '#26233a', border: '#403d52',
    text: '#e0def4', dim: '#908caa', accent: '#ebbcba', accent2: '#c4a7e7',
    ok: '#95e6cb', danger: '#eb6f92', yellow: '#f6c177' }),
  build('kanagawa', { name: 'Kanagawa', mode: 'dark',
    bg: '#1f1f28', panel: '#25252e', panel2: '#2a2a37', border: '#3d3d4e',
    text: '#dcd7ba', dim: '#938aa0', accent: '#7e9cd8', accent2: '#957fb8',
    ok: '#98bb6c', danger: '#e46876', yellow: '#ffa066' }),
  build('everforest', { name: 'Everforest', mode: 'dark',
    bg: '#2d353b', panel: '#343f45', panel2: '#3a464c', border: '#4f585e',
    text: '#d3c6aa', dim: '#9da9a0', accent: '#a7c080', accent2: '#d699b6',
    ok: '#83c092', danger: '#e67e80', yellow: '#dbbc7f' }),
  build('night-owl', { name: 'Night Owl', mode: 'dark',
    bg: '#011627', panel: '#0b2039', panel2: '#12263e', border: '#1d3b53',
    text: '#d6deeb', dim: '#8badc1', accent: '#82aaff', accent2: '#c792ea',
    ok: '#addb67', danger: '#ef5350', yellow: '#ffcb8b' }),
  build('synthwave', { name: "Synthwave '84", mode: 'dark',
    bg: '#241b2f', panel: '#2a1f3d', panel2: '#34294f', border: '#460073',
    text: '#f8f8f2', dim: '#a3a0b8', accent: '#ff7edb', accent2: '#fe4450',
    ok: '#72f1b8', danger: '#fe4450', yellow: '#fede5d', o: { tabActive: '#3b2d5e' } }),
  build('horizon', { name: 'Horizon', mode: 'dark',
    bg: '#1c1e26', panel: '#232535', panel2: '#2e303e', border: '#434557',
    text: '#cfd2de', dim: '#8b91ad', accent: '#b877db', accent2: '#e95678',
    ok: '#26f799', danger: '#e95678', yellow: '#fbb3ab' }),

  // ---- light ----
  build('github-light', { name: 'GitHub Light', mode: 'light',
    bg: '#ffffff', panel: '#f6f8fa', panel2: '#eef1f4', border: '#d0d7de',
    text: '#1f2328', dim: '#656d76', accent: '#0969da', accent2: '#8250df',
    ok: '#1a7f37', danger: '#cf222e', yellow: '#9a6700',
    o: { textStrong: '#0b0f14', statusIdle: '#c6cbd1', hover: '#e8eaee', toastBg: '#f6f8fa' } }),
  build('one-light', { name: 'One Light', mode: 'light',
    bg: '#fafafa', panel: '#f0f0f1', panel2: '#e7e7e9', border: '#d5d5d8',
    text: '#23272e', dim: '#6b717d', accent: '#4078f2', accent2: '#a626a4',
    ok: '#50a14f', danger: '#e45649', yellow: '#c18401',
    o: { textStrong: '#0b0f14', statusIdle: '#c8cbd0', hover: '#e6e6e9', toastBg: '#f0f0f1' } }),
  build('solarized-light', { name: 'Solarized Light', mode: 'light',
    bg: '#fdf6e3', panel: '#f5eed9', panel2: '#eee8d5', border: '#ddd6c1',
    text: '#3b4a4f', dim: '#83968f', accent: '#268bd2', accent2: '#6c71c4',
    ok: '#859900', danger: '#dc322f', yellow: '#b58900',
    o: { textStrong: '#073642', statusIdle: '#cfd4c3', hover: '#ece5cf', toastBg: '#f5eed9' } }),
  build('latte', { name: 'Catppuccin Latte', mode: 'light',
    bg: '#eff1f5', panel: '#e6e9ef', panel2: '#dce0e8', border: '#ccd0da',
    text: '#4c4f69', dim: '#7c7f93', accent: '#7287fd', accent2: '#ea76cb',
    ok: '#40a02b', danger: '#d20f39', yellow: '#df8e1d',
    o: { textStrong: '#1e2030', statusIdle: '#c5c9de', hover: '#e2e6ee', toastBg: '#e6e9ef' } }),
  build('rose-pine-dawn', { name: 'Rosé Pine Dawn', mode: 'light',
    bg: '#faf4ed', panel: '#f2e9e1', panel2: '#eadfd3', border: '#dfdad6',
    text: '#575279', dim: '#8b8598', accent: '#907aa9', accent2: '#d7827e',
    ok: '#646e57', danger: '#b4637a', yellow: '#b8ce5a',
    o: { textStrong: '#2a273f', statusIdle: '#d0c8c0', hover: '#efe6dc', toastBg: '#f2e9e1' } }),
];

let current = THEMES[0];
const listeners = [];

export function onThemeChange(fn) { listeners.push(fn); }
export function currentTheme() { return current; }
export function termTheme() { return current.term; }
export function monacoTheme() { return current.monaco; }

export function applyTheme(id, wsId) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  const root = document.documentElement;
  for (const k of Object.keys(current.vars)) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.style.colorScheme = t.mode; // native scrollbars, inputs, checkboxes
  root.dataset.mode = t.mode; // hooks like the light-mode .ficon filter
  current = t;
  if (wsId) {
    try {
      localStorage.setItem('vs.theme.' + wsId, JSON.stringify({ vars: t.vars, mode: t.mode, monaco: t.monaco }));
    } catch {}
  }
  for (const fn of listeners) { try { fn(t); } catch {} }
}
