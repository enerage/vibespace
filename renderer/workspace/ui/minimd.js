// Tiny SAFE markdown → HTML for agent replies (ui/inbox.js). Every piece of
// source text is HTML-escaped before any tag of ours goes around it, and a
// link is shown as its text + url (no href), so a reply can never inject
// markup or a clickable target. Covers what claude writes: headings, bold,
// italic, `code`, fenced blocks, - / 1. lists (nested by indent), > quotes,
// tables, rules. Pure (no DOM): smoke imports it in node.

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// formatting of a piece WITHOUT code spans (escaped first, then our tags)
function fmt(s) {
  let h = escapeHtml(s);
  h = h.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, url) => `${text} <span class="md-url">(${url})</span>`);
  h = h.replace(/\*\*(?=\S)(.*?\S)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^\w])__(?=\S)(.*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  // `*x*` → italic; a lone `*` (e.g. "2 * 3") has no closing partner and stays
  h = h.replace(/(^|[^*\w])\*([^\s*]|[^\s*][^*]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
  h = h.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>'); // snake_case stays as is
  h = h.replace(/~~(?=\S)(.*?\S)~~/g, '<del>$1</del>');
  return h;
}

// one line of inline markdown: `code` spans first, their content never formatted
export function inline(src) {
  const s = String(src);
  let out = '';
  let last = 0;
  for (const m of s.matchAll(/(?<!`)(`+)([^`]|[^`].*?[^`])\1(?!`)/g)) {
    out += fmt(s.slice(last, m.index));
    out += `<code>${escapeHtml(m[2])}</code>`;
    last = m.index + m[0].length;
  }
  return out + fmt(s.slice(last));
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;

function listHtml(lines) {
  const items = [];
  for (const l of lines) {
    const m = LIST.exec(l);
    if (m) items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), num: parseInt(m[2], 10), text: [m[3]] });
    else if (items.length) items[items.length - 1].text.push(l.trim());
  }
  let pos = 0;
  // one list level; deeper items nest into the open <li>. Always consumes at
  // least its first item, so the loops below end.
  const build = () => {
    const base = items[pos].indent;
    const ordered = items[pos].ordered;
    const tag = ordered ? 'ol' : 'ul';
    const n = items[pos].num;
    let html = `<${tag}${ordered && n > 1 ? ` start="${n}"` : ''}>`;
    let liOpen = false;
    while (pos < items.length) {
      const it = items[pos];
      if (it.indent < base) break;
      if (it.indent > base && liOpen) { html += build(); continue; }
      if (it.ordered !== ordered && liOpen) break; // another list type at this level
      if (liOpen) html += '</li>';
      html += `<li>${it.text.map(inline).join('<br>')}`;
      liOpen = true;
      pos++;
    }
    if (liOpen) html += '</li>';
    return html + `</${tag}>`;
  };
  let out = '';
  while (pos < items.length) out += build();
  return out;
}

const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

function tableHtml(head, rows) {
  const tr = (cs, tag) => `<tr>${cs.map(c => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`;
  return `<table class="md-table"><thead>${tr(cells(head), 'th')}</thead><tbody>${rows.map(r => tr(cells(r), 'td')).join('')}</tbody></table>`;
}

function blocks(lines) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const close = new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      const body = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre class="md-code"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1].length} class="md-h">${inline(h[2])}</h${h[1].length}>`); continue; }
    if (HR.test(line)) { flush(); out.push('<hr>'); continue; }
    if (QUOTE.test(line)) {
      flush();
      const q = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) q.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
      i--;
      out.push(`<blockquote>${blocks(q)}</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      flush();
      const items = [];
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (LIST.test(l)) items.push(l);
        else if (l.trim() && /^\s/.test(l)) items.push(l); // an item's continuation line
        else if (!l.trim() && i + 1 < lines.length && LIST.test(lines[i + 1])) continue; // loose list
        else break;
      }
      i--;
      out.push(listHtml(items));
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) rows.push(lines[j]);
      out.push(tableHtml(line, rows));
      i = j - 1;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out.join('');
}

export function renderMarkdown(src) {
  return blocks(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'));
}
