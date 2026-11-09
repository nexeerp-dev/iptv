// Minimal M3U / M3U8 playlist parsing and export.

function attr(line, name) {
  const m = line.match(new RegExp(name + '="([^"]*)"', 'i'));
  return m ? m[1].trim() : '';
}

/** Parse an M3U playlist into catalog-style channel records. */
export function parseM3U(text, sourceName = 'playlist') {
  const lines = text.split(/\r?\n/);
  const out = [];
  let info = null;
  let opts = {};
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.lastIndexOf(',');
      // Commas can appear inside attributes, so take the text after the last quote.
      const lastQuote = line.lastIndexOf('"');
      const nameStart = line.indexOf(',', Math.max(lastQuote, 0));
      const name = (nameStart >= 0 ? line.slice(nameStart + 1) : line.slice(comma + 1)).trim();
      info = {
        n: name || attr(line, 'tvg-name') || 'Untitled',
        l: attr(line, 'tvg-logo'),
        c: (attr(line, 'tvg-country').split(/[;,]/)[0] || '').toUpperCase(),
        group: attr(line, 'group-title'),
        la: attr(line, 'tvg-language') ? [attr(line, 'tvg-language')] : [],
        id: attr(line, 'tvg-id'),
      };
    } else if (line.startsWith('#EXTVLCOPT')) {
      const [k] = line.slice(11).split('=');
      opts[k.toLowerCase()] = true;
    } else if (!line.startsWith('#')) {
      if (!/^https?:\/\//i.test(line)) { info = null; continue; }
      const i = info || { n: line.split('/').pop() || 'Stream', l: '', c: '', group: '', la: [], id: '' };
      // Streams that need a custom user-agent / referrer cannot play in a browser.
      const status = opts['http-user-agent'] || opts['http-referrer'] ? 'nc' : 'unk';
      out.push({
        id: 'pl:' + sourceName + ':' + out.length,
        n: i.n,
        c: /^[A-Z]{2}$/.test(i.c) ? i.c : '',
        g: i.group ? [i.group.split(';')[0].toLowerCase()] : [],
        l: i.l,
        la: i.la,
        w: '',
        s: [[line, (i.n.match(/\b(\d{3,4}p)\b/) || [])[1] || '', status, '', '']],
        custom: sourceName,
      });
      info = null;
      opts = {};
    }
  }
  return out;
}

/** Build an M3U playlist from catalog channels (first playable stream of each). */
export function toM3U(channels, catalog, pickStream) {
  const esc = s => String(s || '').replace(/"/g, "'");
  const lines = ['#EXTM3U'];
  for (const ch of channels) {
    const s = pickStream(ch);
    if (!s) continue;
    const group = ch.g?.length ? (catalog.categories[ch.g[0]] || ch.g[0]) : 'Other';
    lines.push(`#EXTINF:-1 tvg-id="${esc(ch.id)}" tvg-logo="${esc(ch.l)}" tvg-country="${esc(ch.c)}" group-title="${esc(group)}",${ch.n}`);
    lines.push(s[0]);
  }
  return lines.join('\n') + '\n';
}
