// Fast, forgiving channel search.
//  - ignores case, accents and spacing ("aljazeera" finds "Al Jazeera")
//  - ranks exact and word-start matches first ("zee" -> "Zee TV" before "Al Jazeera")
//  - tolerates small typos ("euronwes", "nickelodean")
//  - also matches country, category and language names

export function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
const compact = s => s.replace(/ /g, '');

// Levenshtein distance with an early exit once it exceeds `max`.
function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

export function indexChannel(ch, meta) {
  const name = norm(ch.n);
  ch._s = {
    name,
    flat: compact(name),
    words: name.split(' ').filter(Boolean),
    meta: ' ' + norm(meta) + ' ',
  };
}

function termScore(t, s) {
  if (s.words.some(w => w === t)) return 120;
  if (s.words.some(w => w.startsWith(t))) return 90;
  if (t.length >= 3 && s.flat.includes(t)) return 50;
  if (s.meta.includes(' ' + t)) return 35;
  if (t.length >= 4) {
    const max = t.length >= 7 ? 2 : 1;
    if (s.words.some(w => within(t, w.slice(0, t.length + max), max))) return 20;
  }
  return 0;
}

/** Returns a score > 0 if the channel matches the query. */
export function score(ch, q) {
  const s = ch._s;
  if (!s || !q.norm) return 0;
  let base = 0;
  if (s.name === q.norm) base = 1000;
  else if (s.name.startsWith(q.norm)) base = 800;
  else if (q.flat.length >= 3 && s.flat.startsWith(q.flat)) base = 700;
  else if ((' ' + s.name).includes(' ' + q.norm)) base = 600;
  else if (q.flat.length >= 4 && s.flat.includes(q.flat)) base = 400;

  let terms = 0;
  for (const t of q.terms) {
    const ts = termScore(t, s);
    if (!ts) { terms = -1; break; }
    terms += ts;
  }
  if (!base && terms < 0) return 0;
  // Shorter names are usually the "main" channel (e.g. "CNN" before "CNN Brasil").
  return base + Math.max(terms, 0) - Math.min(s.name.length, 40) / 4;
}

export function makeQuery(text) {
  const n = norm(text);
  return { text, norm: n, flat: compact(n), terms: n.split(' ').filter(Boolean) };
}

/** Facets: countries, categories and languages whose names match the query. */
export function matchNames(entries, q, limit = 4) {
  if (!q.norm) return [];
  const out = [];
  for (const [key, label] of entries) {
    const n = norm(label);
    let sc = 0;
    if (n === q.norm || key.toLowerCase() === q.norm) sc = 3;
    else if (n.startsWith(q.norm)) sc = 2;
    else if (q.norm.length >= 3 && (' ' + n).includes(' ' + q.norm)) sc = 1;
    if (sc) out.push([sc, key, label]);
  }
  return out.sort((a, b) => b[0] - a[0] || a[2].localeCompare(b[2])).slice(0, limit).map(([, k, l]) => [k, l]);
}

/** Wraps the matched part of a name in <mark>, after escaping it. */
export function highlight(name, q, esc) {
  if (!q?.norm) return esc(name);
  const plain = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (plain.length !== name.length) return esc(name);
  const ranges = [];
  for (const t of q.terms) {
    const re = new RegExp('(^|[^\\p{L}\\p{N}])(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'u');
    const m = plain.match(re) || plain.match(new RegExp('()(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'));
    if (m) { const start = m.index + m[1].length; ranges.push([start, start + t.length]); }
  }
  if (!ranges.length) return esc(name);
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '', pos = 0;
  for (const [a, b] of ranges) {
    if (a < pos) continue;
    out += esc(name.slice(pos, a)) + '<mark>' + esc(name.slice(a, b)) + '</mark>';
    pos = b;
  }
  return out + esc(name.slice(pos));
}
