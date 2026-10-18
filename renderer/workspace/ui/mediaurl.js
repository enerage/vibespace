// vsfile:// URLs for the media preview (pure; main/mediaserve.cjs parses them).
// One encodeURIComponent'd segment per path part, so both Windows paths
// (D:\a\b.png → /D%3A/a/b.png, backslashes or slashes) and macOS paths
// (/Users/x/b.png) round-trip. `ver` (the file's mtime) busts the element's
// own reuse of the URL after the file changes on disk; the server never caches.
export function mediaUrl(wsId, absPath, ver) {
  const segs = String(absPath).split(/[\\/]+/).filter(Boolean).map(encodeURIComponent);
  const q = ver ? `?v=${encodeURIComponent(String(ver))}` : '';
  return `vsfile://ws/${encodeURIComponent(String(wsId))}/${segs.join('/')}${q}`;
}

// 1536 → "1.5 KB"
export function fmtBytes(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// 75.4 → "1:15", 3725 → "1:02:05"
export function fmtDuration(s) {
  if (!Number.isFinite(s) || s < 0) return '';
  const t = Math.round(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
