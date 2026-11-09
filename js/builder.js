// Turns the public iptv-org database (https://github.com/iptv-org/api) into the
// compact catalog the app uses. Runs in the browser (live update) and in Node
// (scripts/build-data.mjs).

export const API_BASE = 'https://iptv-org.github.io/api';
export const API_FILES = ['streams', 'channels', 'feeds', 'logos', 'countries', 'categories', 'languages', 'blocklist'];

// Stream status codes stored in the catalog.
//   ok  = checked: responds and allows browser playback
//   geo = checked: refused (403/451), usually region locked
//   nc  = checked: responds, but the server blocks web players (no CORS)
//   unk = not checked
export const STATUS = { OK: 'ok', GEO: 'geo', NOCORS: 'nc', UNKNOWN: 'unk', DEAD: 'dead' };

export function classifyProbe(p, url) {
  if (!p) return STATUS.UNKNOWN;
  if (p.code >= 200 && p.code < 300 && p.ok) return p.cors ? STATUS.OK : STATUS.NOCORS;
  if (p.code === 403 || p.code === 451) return STATUS.GEO;
  if (p.code === 0) {
    // The checker can only reach ports 80/443, so a failure on another port
    // tells us nothing.
    try {
      const port = new URL(url).port;
      if (port && port !== '80' && port !== '443') return STATUS.UNKNOWN;
    } catch { return STATUS.DEAD; }
  }
  return STATUS.DEAD;
}

/**
 * @param {object} api  { streams, channels, feeds, logos, countries, categories, languages, blocklist }
 * @param {object} [probe] map url -> { code, cors, ok } from scripts/probe.py
 */
export function buildCatalog(api, probe = null) {
  const blocked = new Set((api.blocklist || []).map(b => b.channel));
  const chById = new Map(api.channels.map(c => [c.id, c]));

  const feedKey = (ch, f) => ch + '@' + (f || '');
  const feedById = new Map();
  const mainFeed = new Map();
  for (const f of api.feeds || []) {
    feedById.set(feedKey(f.channel, f.id), f);
    if (f.is_main) mainFeed.set(f.channel, f);
  }

  // Best logo per channel: prefer channel-level, in use, larger.
  const logoBy = new Map();
  for (const l of api.logos || []) {
    const score = (l.feed ? 0 : 1000000) + (l.in_use ? 500000 : 0) + Math.min(l.width || 0, 400) * (l.height || 1) / 1000;
    const cur = logoBy.get(l.channel);
    if (!cur || score > cur.score) logoBy.set(l.channel, { score, url: l.url });
  }

  const byKey = new Map();
  const usedLangs = new Set();

  for (const s of api.streams) {
    if (s.user_agent || s.referrer) continue; // browsers can't send these headers
    const ch = s.channel ? chById.get(s.channel) : null;
    if (ch && (ch.is_nsfw || blocked.has(ch.id) || ch.closed)) continue;
    if (s.channel && !ch) continue;

    const status = classifyProbe(probe && probe[s.url], s.url);
    if (probe && status === STATUS.DEAD) continue;

    const key = ch ? ch.id : 'title:' + s.title.toLowerCase();
    let rec = byKey.get(key);
    if (!rec) {
      const feed = ch ? (feedById.get(feedKey(ch.id, s.feed)) || mainFeed.get(ch.id)) : null;
      const langs = feed?.languages || [];
      langs.forEach(l => usedLangs.add(l));
      rec = {
        id: ch ? ch.id : key.slice(6).replace(/[^a-z0-9]+/g, '-'),
        n: ch ? ch.name : s.title,
        c: ch ? ch.country : '',
        g: ch ? ch.categories : [],
        l: ch ? (logoBy.get(ch.id)?.url || '') : '',
        la: langs,
        w: ch?.website || '',
        s: [],
      };
      byKey.set(key, rec);
    }
    const label = (s.labels || []).join(', ');
    // [url, quality, status, label, feed name]
    rec.s.push([s.url, s.quality || '', status, label, s.feed && s.feed !== mainFeed.get(s.channel)?.id ? s.feed : '']);
  }

  const rank = { ok: 0, unk: 1, geo: 2, nc: 3, dead: 4 };
  const q = v => parseInt(v) || 0;
  const channels = [];
  for (const rec of byKey.values()) {
    rec.s.sort((a, b) =>
      rank[a[2]] - rank[b[2]] ||
      (a[0].startsWith('https') ? 0 : 1) - (b[0].startsWith('https') ? 0 : 1) ||
      q(b[1]) - q(a[1]));
    channels.push(rec);
  }
  channels.sort((a, b) => a.n.localeCompare(b.n));

  const countries = {};
  for (const c of api.countries) countries[c.code] = [c.name, c.flag];
  const categories = {};
  for (const c of api.categories) categories[c.id] = c.name;
  const languages = {};
  for (const l of api.languages) if (usedLangs.has(l.code)) languages[l.code] = l.name;

  return { updated: new Date().toISOString(), checked: !!probe, countries, categories, languages, channels };
}

export async function fetchApi(fetchFn = fetch, onProgress = () => {}) {
  const api = {};
  let done = 0;
  await Promise.all(API_FILES.map(async name => {
    const res = await fetchFn(`${API_BASE}/${name}.json`);
    if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
    api[name] = await res.json();
    onProgress(++done, API_FILES.length, name);
  }));
  return api;
}
