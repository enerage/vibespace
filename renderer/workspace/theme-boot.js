// Pre-paint theme replay — loaded in <head> BEFORE style.css so a saved
// per-workspace theme applies on the first frame (no flash of the default).
// Inline scripts are blocked by the CSP, hence this tiny external file.
// themes.js caches { vars, mode } here on every applyTheme(); a classic
// script, not a module, so it runs synchronously before first paint.
(function () {
  try {
    var id = new URLSearchParams(location.search).get('id');
    var blob = id && JSON.parse(localStorage.getItem('vs.theme.' + id) || 'null');
    if (!blob || !blob.vars) return;
    var root = document.documentElement;
    for (var k in blob.vars) root.style.setProperty(k, blob.vars[k]);
    root.style.colorScheme = blob.mode || 'dark';
    root.dataset.mode = blob.mode || 'dark';
  } catch (e) { /* first run / cleared storage — default dark, no flash anyway */ }
})();
