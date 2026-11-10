import { buildCatalog, fetchApi } from './builder.js';
import { parseM3U, toM3U } from './m3u.js';
import { indexChannel, makeQuery, score, matchNames, highlight } from './search.js';
import { move, focusFirst, focusEl } from './tvnav.js';

// ---------- helpers ----------
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('wtv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wtv.' + k, JSON.stringify(v)); return true; } catch { return false; } },
};
const icon = (name, cls = '') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const PAGE = 48;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TOUCH = matchMedia('(pointer: coarse)').matches;
// Inside the Android app streams are fetched natively, so servers that block
// web players and plain-http streams work too.
const NATIVE = (() => { try { return window.WorldTVAndroid?.isApp() === true; } catch { return false; } })();
const SITE_URL = NATIVE ? window.WorldTVAndroid.siteUrl() : location.href.split('#')[0];
const IS_HTTPS = !NATIVE && location.protocol === 'https:';
// TV mode: Android TV / Google TV / Fire TV app, TV browsers, or ?tv=1 for testing.
const TV = (() => {
  try { if (NATIVE && window.WorldTVAndroid.isTV?.()) return true; } catch {}
  if (/[?&]tv=1\b/.test(location.search)) return true;
  return /SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|HbbTV|GoogleTV|Android TV|AFT[A-Z]{1,3}\b|CrKey/i.test(navigator.userAgent);
})();
const APK_URL = 'https://nexeerp-dev.github.io/iptv/download/Zapply.apk';
const isVerified = s => s[2] === 'ok' || (NATIVE && s[2] === 'nc');
const CAT_ICONS = {
  animation: '🎨', auto: '🚗', business: '💼', classic: '🎞️', comedy: '😂', cooking: '🍳', culture: '🎭',
  documentary: '🌍', education: '🎓', entertainment: '🎬', family: '👨‍👩‍👧', general: '📺', interactive: '🕹️',
  kids: '🧸', legislative: '🏛️', lifestyle: '🌿', movies: '🍿', music: '🎵', news: '📰', outdoor: '🏕️',
  public: '🏢', relax: '🧘', religious: '🙏', science: '🔬', series: '📼', shop: '🛍️', sports: '⚽',
  travel: '✈️', weather: '⛅', xxx: '🔞',
};
const CAT_HUES = { news: 210, sports: 140, movies: 340, music: 290, kids: 45, documentary: 170, entertainment: 260, science: 195, series: 10, comedy: 30, education: 230, business: 220, lifestyle: 100, cooking: 20, travel: 185, religious: 50, general: 250, animation: 310, classic: 35, culture: 280, family: 15, outdoor: 120, relax: 160, weather: 200, shop: 330, auto: 0, legislative: 240, public: 225 };
const HOME_ROWS = ['news', 'sports', 'movies', 'music', 'kids', 'documentary', 'entertainment', 'science'];
const FEATURED = ['Al Jazeera', 'France 24', 'DW', 'Euronews', 'Red Bull TV', 'Nasa TV', 'Bloomberg', 'Sky News', 'TRT World', 'NHK World Japan', 'CBS News', 'ABC News', 'NBC News NOW', 'Fashion TV', 'Rakuten Viaplay', 'Love Nature'];
const POPULAR_SEARCHES = ['News', 'Sports', 'Movies', 'Kids', 'Music', 'Al Jazeera', 'BBC', 'CNN', 'Euronews', 'Cartoon', 'Documentary', 'Comedy'];
const STATUS_TEXT = { ok: 'Verified working', unk: 'Unchecked', geo: 'May be region locked', nc: 'May not play in browsers' };

// ---------- state ----------
const state = {
  catalog: null,
  all: [],
  byId: new Map(),
  view: { type: 'home', value: '' },
  query: '',
  q: null,
  searchOpen: false,
  lang: '',
  status: store.get('status', null),
  sort: store.get('sort', 'name'),
  layout: store.get('layout', 'grid'),
  favs: new Set(store.get('favs', [])),
  recent: store.get('recent', []),
  searches: store.get('searches', []),
  playlists: store.get('playlists', []),
  settings: Object.assign({ autoSkip: true, resume: true }, store.get('settings', {})),
  failed: new Set(),
  list: [],
  rendered: 0,
  current: null,
  counts: null,
};

// ---------- channel helpers ----------
function playable(s) {
  if (state.failed.has(s[0])) return false;
  if (IS_HTTPS && s[0].startsWith('http:')) return false;
  return true;
}
function streamsFor(ch, level = state.status) {
  return ch.s.filter(s => playable(s) && (
    level === 'all' ? true :
    level === 'ok' ? isVerified(s) :
    s[2] !== 'nc'));
}
const bestQuality = ch => Math.max(0, ...ch.s.map(s => parseInt(s[1]) || 0));
const countryName = code => state.catalog.countries[code]?.[0] || 'International';
const flag = code => state.catalog.countries[code]?.[1] || '🌐';
const catName = id => state.catalog.categories[id] || id;
const langName = code => state.catalog.languages[code] || code;
const initials = name => name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'TV';
const hue = str => { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

// Deterministic daily shuffle so home rows feel fresh but stay stable for a day.
function dailyShuffle(arr, salt) {
  const day = Math.floor(Date.now() / 864e5);
  let seed = hue(salt) + day * 7919;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return arr.map(x => [rnd(), x]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
}

function indexChannels() {
  state.all = [...state.catalog.channels, ...state.playlists.flatMap(p => p.channels)];
  state.byId = new Map(state.all.map(ch => [ch.id, ch]));
  for (const ch of state.all) {
    indexChannel(ch, [countryName(ch.c), ch.c, ...ch.g.map(catName), ...ch.la.map(langName)].join(' '));
  }
  computeCounts();
}

function computeCounts() {
  const counts = { total: 0, country: {}, category: {}, lang: {} };
  for (const ch of state.catalog.channels) {
    if (!streamsFor(ch).length) continue;
    counts.total++;
    counts.country[ch.c] = (counts.country[ch.c] || 0) + 1;
    for (const g of ch.g) counts.category[g] = (counts.category[g] || 0) + 1;
    for (const l of ch.la) counts.lang[l] = (counts.lang[l] || 0) + 1;
  }
  state.counts = counts;
}

// ---------- lists ----------
function baseList(view) {
  switch (view.type) {
    case 'fav': return state.all.filter(ch => state.favs.has(ch.id));
    case 'recent': return state.recent.map(id => state.byId.get(id)).filter(Boolean);
    case 'country': return state.catalog.channels.filter(ch => ch.c === view.value);
    case 'category': return state.catalog.channels.filter(ch => ch.g.includes(view.value));
    case 'language': return state.catalog.channels.filter(ch => ch.la.includes(view.value));
    case 'playlist': return state.all.filter(ch => ch.custom === view.value);
    default: return state.catalog.channels;
  }
}

function computeList() {
  const v = state.view;
  let list = baseList(v);
  const personal = ['fav', 'recent', 'playlist'].includes(v.type);
  list = list.filter(ch => streamsFor(ch, personal ? 'all' : state.status).length);
  if (state.lang && !personal) list = list.filter(ch => ch.la.includes(state.lang));
  if (v.type !== 'recent') {
    if (state.sort === 'country') list = [...list].sort((a, b) => countryName(a.c).localeCompare(countryName(b.c)) || a.n.localeCompare(b.n));
    else if (state.sort === 'quality') list = [...list].sort((a, b) => bestQuality(b) - bestQuality(a) || a.n.localeCompare(b.n));
  }
  return list;
}

function searchList() {
  const q = state.q;
  // Search looks at every channel that can play, whatever filter is set,
  // and ranks verified streams higher.
  const out = [];
  for (const ch of state.all) {
    let sc = score(ch, q);
    if (sc <= 0) continue;
    const streams = streamsFor(ch, 'playable');
    if (!streams.length) continue;
    if (streams.some(isVerified)) sc += 150;
    if (state.favs.has(ch.id)) sc += 40;
    out.push([sc, ch]);
  }
  return out.sort((a, b) => b[0] - a[0] || a[1].n.localeCompare(b[1].n)).map(x => x[1]);
}

// A good-looking pick of channels for a row: verified, with a logo, best quality first.
function pickRow(list, salt, n = 18) {
  const good = list.filter(ch => ch.l && streamsFor(ch).some(isVerified));
  const pool = good.length >= 6 ? good : list.filter(ch => streamsFor(ch).length);
  const hd = pool.filter(ch => bestQuality(ch) >= 720);
  const rest = pool.filter(ch => bestQuality(ch) < 720);
  return [...dailyShuffle(hd, salt), ...dailyShuffle(rest, salt)].slice(0, n);
}

function featured() {
  const byName = new Map();
  for (const ch of state.catalog.channels) {
    const k = ch.n.toLowerCase();
    if (!byName.has(k) && ch.l && streamsFor(ch).some(isVerified)) byName.set(k, ch);
  }
  const picks = FEATURED.map(n => byName.get(n.toLowerCase())).filter(Boolean);
  const extra = pickRow(state.catalog.channels.filter(ch => !picks.includes(ch)), 'featured', 8);
  return dailyShuffle(picks, 'hero').slice(0, 6).concat(extra).slice(0, 7);
}

function localCountry() {
  const tags = navigator.languages || [navigator.language || ''];
  for (const t of tags) {
    const m = String(t).match(/-([A-Z]{2})$/i);
    if (m && state.counts.country[m[1].toUpperCase()] >= 4) return m[1].toUpperCase();
  }
  return null;
}

// ---------- rendering: shared bits ----------
function thumbHTML(ch, big = false) {
  const q = bestQuality(ch);
  return `<div class="thumb${big ? ' big' : ''}" style="--h:${hue(ch.n)}">
      <span class="initials">${esc(initials(ch.n))}</span>
      ${ch.l ? `<div class="plate"><img src="${esc(ch.l)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></div>` : ''}
      ${q >= 720 ? `<span class="badge q">${q >= 2160 ? '4K' : q >= 1080 ? 'FHD' : 'HD'}</span>` : ''}
      <span class="play-ico">${icon('play')}</span>
    </div>`;
}

function cardHTML(ch, i = 0, opts = {}) {
  const playing = state.current?.ch.id === ch.id;
  const fav = state.favs.has(ch.id);
  const cat = ch.g[0] ? catName(ch.g[0]) : '';
  const verified = ch.s.some(isVerified);
  const name = opts.q ? highlight(ch.n, opts.q, esc) : esc(ch.n);
  return `<article class="card${playing ? ' playing' : ''}" data-id="${esc(ch.id)}" tabindex="0" role="button" aria-label="Play ${esc(ch.n)}" style="--i:${Math.min(i, 24)}">
    ${thumbHTML(ch)}
    <div class="meta">
      <div class="name" title="${esc(ch.n)}">${name}${verified ? '<span class="vdot" title="Checked and working"></span>' : ''}</div>
      <div class="sub"><span class="flag">${flag(ch.c)}</span><span>${esc(ch.c ? countryName(ch.c) : 'International')}</span>${cat ? `<span class="dot">•</span><span>${esc(cat)}</span>` : ''}</div>
    </div>
    ${playing ? '<span class="live-tag"><i></i>LIVE</span>' : ''}
    <button class="fav${fav ? ' on' : ''}" data-fav="${esc(ch.id)}" aria-label="${fav ? 'Remove from' : 'Add to'} favorites" title="Favorite">${icon('star')}</button>
  </article>`;
}

function railHTML(title, list, more, opts = {}) {
  if (!list.length) return '';
  return `<section class="shelf">
    <div class="shelf-head">
      <h2>${title}</h2>
      ${more ? `<a class="see-all" href="${more}">See all ${icon('arrow')}</a>` : ''}
    </div>
    <div class="rail-wrap">
      <button class="rail-btn prev" data-rail="-1" aria-label="Scroll left">${icon('prev')}</button>
      <div class="rail${opts.tiles ? ' tiles' : ''}">${opts.tiles ? list.join('') : list.map((ch, i) => cardHTML(ch, i)).join('')}</div>
      <button class="rail-btn next" data-rail="1" aria-label="Scroll right">${icon('next')}</button>
    </div>
  </section>`;
}

function catTile(id, count, i = 0) {
  return `<a class="tile cat-tile" href="${viewHash({ type: 'category', value: id })}" style="--h:${CAT_HUES[id] ?? hue(id)};--i:${Math.min(i, 24)}">
    <span class="tile-emoji">${CAT_ICONS[id] || '📺'}</span>
    <span class="tile-name">${esc(catName(id))}</span>
    <span class="tile-count">${count.toLocaleString()} channels</span>
  </a>`;
}
function countryTile(code, count, i = 0) {
  return `<a class="tile country-tile" href="${viewHash({ type: 'country', value: code })}" style="--h:${hue(code + 'x')};--i:${Math.min(i, 24)}">
    <span class="tile-flag">${flag(code)}</span>
    <span class="tile-name">${esc(code ? countryName(code) : 'International')}</span>
    <span class="tile-count">${count.toLocaleString()}</span>
  </a>`;
}

// ---------- pages ----------
function viewLabel(v) {
  switch (v.type) {
    case 'fav': return 'Favorites';
    case 'recent': return 'Recently watched';
    case 'country': return countryName(v.value);
    case 'category': return catName(v.value);
    case 'language': return langName(v.value);
    case 'playlist': return v.value;
    case 'browse': return 'Browse';
    case 'home': return 'Home';
    default: return 'All channels';
  }
}
function viewIcon(v) {
  switch (v.type) {
    case 'fav': return '⭐';
    case 'recent': return '🕘';
    case 'country': return flag(v.value);
    case 'category': return CAT_ICONS[v.value] || '📺';
    case 'language': return '🗣️';
    case 'playlist': return '📃';
    default: return '📺';
  }
}

let heroTimer = null;
function renderHome() {
  const c = state.counts;
  const feat = featured();
  const local = localCountry();
  const recent = state.recent.map(id => state.byId.get(id)).filter(Boolean).slice(0, 18);
  const favs = state.all.filter(ch => state.favs.has(ch.id)).slice(0, 18);
  const topCountries = Object.entries(c.country).filter(([k]) => k).sort((a, b) => b[1] - a[1]).slice(0, 18);
  const cats = Object.entries(c.category).sort((a, b) => b[1] - a[1]);
  const countries = Object.keys(c.country).length;

  let html = `<section class="hero" id="hero" style="--h:${hue(feat[0]?.n || 'x')}">
    <div class="hero-slides">${feat.map((ch, i) => `
      <div class="slide${i === 0 ? ' active' : ''}" data-slide="${i}" style="--h:${hue(ch.n)}">
        <div class="slide-bg"></div>
        <div class="slide-text">
          <span class="eyebrow"><i class="pulse"></i> Live now · ${flag(ch.c)} ${esc(ch.c ? countryName(ch.c) : 'International')}</span>
          <h1>${esc(ch.n)}</h1>
          <p>${esc(ch.g.map(catName).join(' · ') || 'Live TV')}${ch.la.length ? ' · ' + esc(ch.la.slice(0, 2).map(langName).join(', ')) : ''}</p>
          <div class="hero-actions">
            <button class="btn primary lg" data-play="${esc(ch.id)}">${icon('play')} Watch live</button>
            <button class="btn glass lg" data-action="random">${icon('dice')} Surprise me</button>
          </div>
        </div>
        <div class="slide-logo">${thumbHTML(ch, true)}</div>
      </div>`).join('')}
    </div>
    <div class="hero-dots">${feat.map((_, i) => `<button class="dot-btn${i === 0 ? ' active' : ''}" data-dot="${i}" aria-label="Slide ${i + 1}"><i></i></button>`).join('')}</div>
  </section>
  <div class="stats">
    <div class="stat"><b data-count="${c.total}">${c.total.toLocaleString()}</b><span>working channels</span></div>
    <div class="stat"><b data-count="${countries}">${countries}</b><span>countries</span></div>
    <div class="stat"><b data-count="${Object.keys(c.lang).length}">${Object.keys(c.lang).length}</b><span>languages</span></div>
    ${!NATIVE && /Android/i.test(navigator.userAgent) ? `<a class="stat app-promo" href="${APK_URL}" download><b><i>📱</i>Get the app</b><span>more channels on Android</span></a>` : ''}
  </div>`;

  html += railHTML('Continue watching', recent, viewHash({ type: 'recent' }));
  html += railHTML('Your favorites', favs, viewHash({ type: 'fav' }));
  if (local) html += railHTML(`${flag(local)} Popular in ${esc(countryName(local))}`, pickRow(baseList({ type: 'country', value: local }), 'local'), viewHash({ type: 'country', value: local }));
  html += railHTML('Browse by category', cats.slice(0, 16).map(([id, n], i) => catTile(id, n, i)), viewHash({ type: 'browse' }), { tiles: true });
  for (const id of HOME_ROWS.slice(0, 3)) if (c.category[id]) html += railHTML(`${CAT_ICONS[id]} ${esc(catName(id))}`, pickRow(baseList({ type: 'category', value: id }), id), viewHash({ type: 'category', value: id }));
  html += railHTML('Explore the world', topCountries.map(([code, n], i) => countryTile(code, n, i)), viewHash({ type: 'browse' }), { tiles: true });
  for (const id of HOME_ROWS.slice(3)) if (c.category[id]) html += railHTML(`${CAT_ICONS[id]} ${esc(catName(id))}`, pickRow(baseList({ type: 'category', value: id }), id), viewHash({ type: 'category', value: id }));
  html += `<div class="cta-all"><a class="btn glass lg" href="${viewHash({ type: 'all' })}">${icon('tv')} See all ${c.total.toLocaleString()} channels</a></div>`;

  $('#page').innerHTML = html;
  state.list = feat;
  startHero(feat.length);
  countUp();
}

function startHero(n) {
  clearInterval(heroTimer);
  if (n < 2) return;
  let i = 0;
  const go = k => {
    i = (k + n) % n;
    $$('#hero .slide').forEach((s, j) => s.classList.toggle('active', j === i));
    $$('#hero .dot-btn').forEach((d, j) => d.classList.toggle('active', j === i));
    const slide = $(`#hero .slide[data-slide="${i}"]`);
    if (slide) $('#hero').style.setProperty('--h', slide.style.getPropertyValue('--h'));
  };
  const tick = () => { if (!document.hidden && !$('#hero')?.matches(':hover, :focus-within')) go(i + 1); };
  heroTimer = setInterval(tick, 6500);
  const hero = $('#hero');
  hero._go = k => { go(k); clearInterval(heroTimer); heroTimer = setInterval(tick, 6500); };
  hero._index = () => i;
  // Swipe between slides on touch screens.
  let x0 = null;
  hero.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  hero.addEventListener('touchend', e => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) hero._go(i + (dx < 0 ? 1 : -1));
    x0 = null;
  });
}

function countUp() {
  if (REDUCED_MOTION) return;
  $$('[data-count]').forEach(el => {
    const target = +el.dataset.count;
    const t0 = performance.now();
    const step = t => {
      const p = Math.min(1, (t - t0) / 1100);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function renderBrowse() {
  const c = state.counts;
  const cats = Object.entries(c.category).sort((a, b) => b[1] - a[1]);
  const langs = Object.entries(c.lang).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).slice(0, 24);
  $('#page').innerHTML = `
    <header class="page-head"><div><h1>Browse</h1><p>${c.total.toLocaleString()} channels by category, country and language</p></div></header>
    <h2 class="section-title">Categories</h2>
    <div class="tile-grid cats">${cats.map(([id, n], i) => catTile(id, n, i)).join('')}</div>
    <div class="section-title row-flex"><h2>Countries</h2>
      <label class="mini-search">${icon('search')}<input id="countryFilter" type="search" placeholder="Find a country" autocomplete="off"></label>
    </div>
    <div class="tile-grid countries" id="countryGrid"></div>
    <h2 class="section-title">Languages</h2>
    <div class="chip-cloud">${langs.map(([code, n]) => `<a class="chip" href="${viewHash({ type: 'language', value: code })}">${esc(langName(code))} <small>${n}</small></a>`).join('')}</div>`;
  renderCountryGrid('');
  state.list = [];
}

function renderCountryGrid(filter) {
  const f = filter.trim().toLowerCase();
  const entries = Object.entries(state.counts.country)
    .filter(([code]) => !f || countryName(code).toLowerCase().includes(f) || code.toLowerCase() === f)
    .sort((a, b) => (a[0] ? countryName(a[0]) : 'zzz').localeCompare(b[0] ? countryName(b[0]) : 'zzz'));
  $('#countryGrid').innerHTML = entries.length
    ? entries.map(([code, n], i) => countryTile(code, n, i)).join('')
    : '<p class="hint">No country matches.</p>';
}

function toolbarHTML(personal) {
  const langs = Object.entries(state.counts.lang).filter(([, n]) => n >= 3)
    .map(([code]) => [code, langName(code)]).sort((a, b) => a[1].localeCompare(b[1]));
  return `<div class="toolbar">
    ${personal ? '' : `<label class="pill-select">🗣️<select id="langFilter" aria-label="Language"><option value="">All languages</option>${langs.map(([c, n]) => `<option value="${esc(c)}"${c === state.lang ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    <label class="pill-select">↕<select id="sortSel" aria-label="Sort">
      <option value="name"${state.sort === 'name' ? ' selected' : ''}>A → Z</option>
      <option value="quality"${state.sort === 'quality' ? ' selected' : ''}>Best quality</option>
      <option value="country"${state.sort === 'country' ? ' selected' : ''}>By country</option>
    </select></label>
    <button class="pill-btn${state.status === 'ok' ? ' on' : ''}" data-action="toggle-verified" title="Show only channels checked as working">✓ Verified only</button>`}
    <span class="grow"></span>
    <button class="icon-btn small" data-action="layout" title="Grid / list" aria-label="Grid or list view">${icon(state.layout === 'grid' ? 'list' : 'grid')}</button>
    <button class="icon-btn small" data-action="random-here" title="Random channel from this list" aria-label="Random from this list">${icon('shuffle')}</button>
  </div>`;
}

function renderList() {
  const v = state.view;
  const personal = ['fav', 'recent', 'playlist'].includes(v.type);
  state.list = computeList();
  const bannerHue = v.type === 'category' ? (CAT_HUES[v.value] ?? hue(v.value)) : hue(v.type + v.value);
  $('#page').innerHTML = `
    <header class="page-head banner" style="--h:${bannerHue}">
      <span class="banner-icon">${viewIcon(v)}</span>
      <div><h1>${esc(viewLabel(v))}</h1><p>${state.list.length.toLocaleString()} channel${state.list.length === 1 ? '' : 's'}${state.lang && !personal ? ` in ${esc(langName(state.lang))}` : ''}</p></div>
    </header>
    ${toolbarHTML(personal)}
    <div class="grid ${state.layout}" id="grid"></div>
    <div class="empty" id="empty" hidden></div>`;
  state.rendered = 0;
  if (!state.list.length) {
    const empty = $('#empty');
    empty.hidden = false;
    empty.innerHTML = v.type === 'fav'
      ? `<div class="big">⭐</div><h3>No favorites yet</h3><p>Tap the star on any channel and it shows up here.</p><a class="btn primary" href="#">Find channels</a>`
      : v.type === 'recent'
        ? `<div class="big">🕘</div><h3>Nothing watched yet</h3><a class="btn primary" href="#">Start watching</a>`
        : `<div class="big">📡</div><h3>No channels here</h3>${state.status === 'ok' || state.lang ? '<button class="btn primary" data-action="widen">Show all channels</button>' : ''}`;
  }
  appendGrid();
}

function appendGrid() {
  const grid = $('#grid');
  if (!grid) return;
  const next = state.list.slice(state.rendered, state.rendered + PAGE);
  grid.insertAdjacentHTML('beforeend', next.map((ch, i) => cardHTML(ch, i, { q: state.q })).join(''));
  state.rendered += next.length;
}

function renderSearch() {
  const q = state.q;
  if (!q?.norm) {
    $('#page').innerHTML = `
      <header class="page-head"><div><h1>Search</h1><p>Find any of ${state.counts.total.toLocaleString()} channels by name, country, category or language.</p></div></header>
      ${state.searches.length ? `<h2 class="section-title row-flex"><span>Recent searches</span><button class="link" data-action="clear-searches">Clear</button></h2>
        <div class="chip-cloud">${state.searches.map(s => `<button class="chip" data-search="${esc(s)}">🕘 ${esc(s)}</button>`).join('')}</div>` : ''}
      <h2 class="section-title">Popular searches</h2>
      <div class="chip-cloud">${POPULAR_SEARCHES.map(s => `<button class="chip" data-search="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
    state.list = [];
    return;
  }
  state.list = searchList();
  const cats = Object.entries(state.catalog.categories).filter(([id]) => state.counts.category[id]);
  const countries = Object.keys(state.counts.country).filter(Boolean).map(k => [k, countryName(k)]);
  const langs = Object.keys(state.counts.lang).map(k => [k, langName(k)]);
  const facets = [
    ...matchNames(countries, q, 3).map(([k, l]) => `<a class="facet" href="${viewHash({ type: 'country', value: k })}">${flag(k)} ${esc(l)} <small>${state.counts.country[k]}</small></a>`),
    ...matchNames(cats, q, 2).map(([k, l]) => `<a class="facet" href="${viewHash({ type: 'category', value: k })}">${CAT_ICONS[k] || '📺'} ${esc(l)} <small>${state.counts.category[k]}</small></a>`),
    ...matchNames(langs, q, 2).map(([k, l]) => `<a class="facet" href="${viewHash({ type: 'language', value: k })}">🗣️ ${esc(l)} <small>${state.counts.lang[k]}</small></a>`),
  ];
  $('#page').innerHTML = `
    <header class="page-head"><div><h1>“${esc(q.text)}”</h1><p>${state.list.length.toLocaleString()} channel${state.list.length === 1 ? '' : 's'} found</p></div></header>
    ${facets.length ? `<div class="facets">${facets.join('')}</div>` : ''}
    <div class="grid ${state.layout}" id="grid"></div>
    <div class="empty" id="empty" ${state.list.length ? 'hidden' : ''}>
      <div class="big">🔎</div><h3>No channel called “${esc(q.text)}”</h3>
      <p>It may not be broadcast for free online. Try a shorter word, a country or a category.</p>
      <div class="chip-cloud center">${POPULAR_SEARCHES.slice(0, 6).map(s => `<button class="chip" data-search="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    </div>`;
  state.rendered = 0;
  appendGrid();
}

function renderPage({ animate = true, scroll = true } = {}) {
  const draw = () => {
    clearInterval(heroTimer);
    const searching = state.searchOpen || state.query;
    document.body.dataset.view = searching ? 'search' : state.view.type;
    if (searching) renderSearch();
    else if (state.view.type === 'home') renderHome();
    else if (state.view.type === 'browse') renderBrowse();
    else renderList();
    updateNav();
    markPlaying();
    if (TV && !tvFull() && !$('#settings').open && !document.activeElement?.closest('.topbar')) {
      requestAnimationFrame(() => focusFirst($('#page')));
    }
  };
  if (animate && !REDUCED_MOTION && document.startViewTransition) document.startViewTransition(draw);
  else draw();
  if (scroll) {
    const top = state.current && innerWidth >= 900 ? $('#page').offsetTop - 80 : 0;
    if (scrollY > top) scrollTo({ top, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
  }
}

function updateNav() {
  const active = state.searchOpen || state.query ? 'search' : (['home', 'browse', 'all', 'fav'].includes(state.view.type) ? state.view.type : '');
  for (const nav of ['#topnav', '#tabbar']) {
    let activeEl = null;
    $$(nav + ' [data-nav]').forEach(a => {
      const on = a.dataset.nav === active;
      a.classList.toggle('active', on);
      if (on) activeEl = a;
    });
    const ink = $(nav === '#topnav' ? '#navInk' : '#tabInk');
    if (activeEl) {
      ink.style.opacity = 1;
      ink.style.transform = `translateX(${activeEl.offsetLeft}px)`;
      ink.style.width = activeEl.offsetWidth + 'px';
    } else ink.style.opacity = 0;
  }
}

// ---------- routing ----------
function viewHash(v, ch = null) {
  const p = new URLSearchParams();
  if (v.type && v.type !== 'home') p.set('v', v.value ? `${v.type}:${v.value}` : v.type);
  if (ch) p.set('ch', ch);
  return '#' + p.toString();
}
function parseView(href) {
  const p = new URLSearchParams(String(href).replace(/^.*#/, ''));
  const v = p.get('v') || '';
  const i = v.indexOf(':');
  return { view: v ? { type: i < 0 ? v : v.slice(0, i), value: i < 0 ? '' : v.slice(i + 1) } : { type: 'home', value: '' }, ch: p.get('ch') };
}
function setView(view, push = true) {
  state.view = view;
  if (view.type !== 'search') clearSearch(false);
  if (push) history.pushState(null, '', viewHash(view, state.current?.ch.id));
  renderPage();
}

// ---------- search UI ----------
let searchTimer;
function runSearch(text, { record = false } = {}) {
  state.query = text.trim();
  state.q = makeQuery(state.query);
  $('#searchClear').hidden = !state.query;
  if (record && state.query.length > 1) {
    state.searches = [state.query, ...state.searches.filter(s => s.toLowerCase() !== state.query.toLowerCase())].slice(0, 8);
    store.set('searches', state.searches);
  }
  renderPage({ animate: false, scroll: true });
}
function openSearch() {
  state.searchOpen = true;
  document.body.classList.add('searching');
  const input = $('#search');
  input.focus();
  if (!state.query) renderPage({ animate: true });
}
function clearSearch(render = true) {
  const had = state.query || state.searchOpen;
  state.query = ''; state.q = null; state.searchOpen = false;
  $('#search').value = '';
  $('#searchClear').hidden = true;
  document.body.classList.remove('searching');
  if (render && had) renderPage();
}

// ---------- player ----------
const video = $('#video');
let hls = null, dash = null, loadTimer = null, skipTimer = null, osdTimer = null, idleTimer = null;

function destroyEngines() {
  clearTimeout(loadTimer); clearInterval(skipTimer);
  if (hls) { hls.destroy(); hls = null; }
  if (dash) { dash.reset(); dash = null; }
  video.removeAttribute('src');
  video.load();
}

function showOverlay(msg, actions = [], spinning = false) {
  $('#overlay').hidden = false;
  $('#spinner').hidden = !spinning;
  $('#overlayMsg').innerHTML = msg;
  $('#overlayActions').innerHTML = actions.map(a => `<button class="btn${a.ghost ? ' glass' : ' primary'}" data-action="${a.action}">${a.label}</button>`).join('');
}
function hideOverlay() { $('#overlay').hidden = true; }

function osd(text) {
  const el = $('#osd');
  el.textContent = text;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

async function loadDash() {
  if (window.dashjs) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Could not load the DASH player'));
    document.head.appendChild(s);
  });
}

function play(ch, srcIdx = 0) {
  if (!ch) return;
  const sources = streamsFor(ch, 'all');
  const first = !state.current;
  state.current = { ch, idx: srcIdx, sources };
  const wrap = $('#playerWrap');
  wrap.hidden = false;
  wrap.style.setProperty('--h', hue(ch.n));
  document.body.classList.add('has-player');
  document.title = `${ch.n} — Zapply`;
  history.replaceState(null, '', viewHash(state.view, ch.id));
  addRecent(ch.id);
  renderNow();
  markPlaying();

  destroyEngines();
  if (!sources.length) return fail('No playable source for this channel.');
  showOverlay(`<div class="tuning">${thumbHTML(ch)}</div>Tuning to <b>${esc(ch.n)}</b>${sources.length > 1 ? `<small>source ${srcIdx + 1} of ${sources.length}</small>` : ''}`, [], true);
  loadTimer = setTimeout(() => sourceFailed('The stream took too long to start.'), 20000);
  attach(sources[srcIdx][0]).catch(e => sourceFailed(e.message));
  if (TV) { enterTvFull(); showTvInfo(); }
  else if (first || innerWidth < 900) {
    $('#player').classList.remove('floating');
    scrollTo({ top: 0, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
  }
  if (first && TOUCH && !TV && !store.get('swipeHint', false)) {
    const h = $('#swipeHint');
    h.hidden = false;
    setTimeout(() => { h.hidden = true; }, 4500);
    store.set('swipeHint', true);
  }
}

async function attach(url) {
  if (/\.mpd(\?|$)/i.test(url)) {
    await loadDash();
    dash = window.dashjs.MediaPlayer().create();
    dash.on('error', () => sourceFailed('The stream could not be played.'));
    dash.initialize(video, url, true);
    return;
  }
  if (window.Hls?.isSupported()) {
    hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2 });
    let recovered = false;
    hls.on(window.Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
      sourceFailed(d.type === window.Hls.ErrorTypes.NETWORK_ERROR ? 'The channel is offline or not available in your region.' : 'The stream could not be played.');
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else {
    video.src = url; // Safari / iOS play HLS natively
  }
  tryPlay();
}

function tryPlay() {
  const p = video.play();
  if (p) p.catch(err => {
    if (err.name === 'NotAllowedError') {
      video.muted = true;
      video.play().then(() => osd('🔇 Tap the video for sound')).catch(() => {});
    }
  });
}

function sourceFailed(reason) {
  const cur = state.current;
  if (!cur) return;
  clearTimeout(loadTimer);
  const src = cur.sources[cur.idx];
  if (src) state.failed.add(src[0]);
  if (cur.idx + 1 < cur.sources.length) {
    osd(`Trying another source (${cur.idx + 2}/${cur.sources.length})…`);
    play(cur.ch, cur.idx + 1);
    return;
  }
  fail(reason);
}

function fail(reason) {
  destroyEngines();
  if (TV) $('#tvInfo').classList.remove('show');
  $$(`.card[data-id="${CSS.escape(state.current.ch.id)}"]`).forEach(c => c.classList.add('broken'));
  const actions = [{ action: 'next', label: 'Next channel ›' }, { action: 'retry', label: 'Try again', ghost: true }];
  const name = esc(state.current.ch.n);
  if (state.settings.autoSkip) {
    let n = 5;
    const msg = () => `<div class="fail-ico">📡</div><b>${name}</b> isn't available right now<small>${esc(reason)}</small><div class="countdown"><i style="animation-duration:5s"></i></div><small>Next channel in ${n}s</small>`;
    showOverlay(msg(), actions.concat({ action: 'stay', label: 'Stay', ghost: true }));
    skipTimer = setInterval(() => {
      n--;
      if (n <= 0) { clearInterval(skipTimer); step(1); }
      else { const s = $('#overlayMsg small:last-child'); if (s) s.textContent = `Next channel in ${n}s`; }
    }, 1000);
  } else {
    showOverlay(`<div class="fail-ico">📡</div><b>${name}</b> isn't available right now<small>${esc(reason)}</small>`, actions);
  }
}

function navList() {
  if (state.list.some(c => c.id === state.current?.ch.id)) return state.list;
  return state.catalog.channels.filter(c => streamsFor(c).length);
}
function step(dir) {
  const list = navList();
  if (!list.length) return;
  const i = state.current ? list.findIndex(c => c.id === state.current.ch.id) : -1;
  const next = list[(i + dir + list.length) % list.length];
  play(next);
  if (!TV) osd(`${dir > 0 ? '›' : '‹'}  ${next.n}`);
}
function randomChannel(pool) {
  pool = pool?.length ? pool : state.catalog.channels.filter(c => streamsFor(c).some(isVerified));
  play(pool[Math.floor(Math.random() * pool.length)]);
}

function closePlayer() {
  destroyEngines();
  state.current = null;
  $('#playerWrap').hidden = true;
  $('#player').classList.remove('floating');
  document.body.classList.remove('has-player', 'tv-full');
  closeDrawer();
  document.title = 'Zapply — Free Live TV';
  history.replaceState(null, '', viewHash(state.view));
  markPlaying();
}

function goFullscreen() {
  if (TV) { if (state.current) enterTvFull(); return; }
  if (!document.fullscreenElement && state.current) $('#player').requestFullscreen?.().catch(() => {});
}
function toggleFullscreen() {
  if (TV) { document.body.classList.contains('tv-full') ? exitTvFull() : goFullscreen(); return; }
  if (document.fullscreenElement) document.exitFullscreen();
  else goFullscreen();
}

// ---------- TV mode ----------
let tvInfoTimer = null, numBuf = '', numTimer = null, kbOpen = false;
const tvFull = () => document.body.classList.contains('tv-full');
const drawerOpen = () => !$('#tvDrawer').hidden;

function enterTvFull() {
  document.body.classList.add('tv-full');
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}
function exitTvFull() {
  closeDrawer();
  document.body.classList.remove('tv-full');
  $('#tvInfo').classList.remove('show');
  scrollTo({ top: 0 });
  focusFirst(document, $('.card.playing') || $('.now .ctl.primary'));
}

function showTvInfo() {
  if (!state.current) return;
  const { ch, idx, sources } = state.current;
  const list = navList();
  const n = list.findIndex(c => c.id === ch.id) + 1;
  const q = bestQuality(ch);
  $('#tvInfo').innerHTML = `
    <div class="ti-main">
      ${n ? `<div class="ti-num">${n}</div>` : ''}
      <div class="ti-logo">${thumbHTML(ch)}</div>
      <div class="ti-text">
        <span class="eyebrow"><i class="pulse"></i> Live${q >= 720 ? ` · ${q >= 2160 ? '4K' : q >= 1080 ? 'Full HD' : 'HD'}` : ''}${sources.length > 1 ? ` · source ${idx + 1}/${sources.length}` : ''}</span>
        <b>${esc(ch.n)}</b>
        <small>${flag(ch.c)} ${esc(ch.c ? countryName(ch.c) : 'International')}${ch.g.length ? ' · ' + esc(ch.g.map(catName).join(', ')) : ''}${ch.la.length ? ' · ' + esc(ch.la.slice(0, 2).map(langName).join(', ')) : ''}</small>
      </div>
      ${state.favs.has(ch.id) ? '<span class="ti-fav">★</span>' : ''}
    </div>
    <div class="ti-keys"><span><kbd>▲</kbd><kbd>▼</kbd> Change channel</span><span><kbd>◀</kbd><kbd>▶</kbd> Channel list</span><span><kbd>OK</kbd> Info</span><span><kbd>0-9</kbd> Go to number</span><span><kbd>BACK</kbd> Browse</span></div>`;
  $('#tvInfo').classList.add('show');
  clearTimeout(tvInfoTimer);
  tvInfoTimer = setTimeout(() => $('#tvInfo').classList.remove('show'), 4500);
}

function openDrawer() {
  const list = navList();
  if (!list.length) return;
  const cur = state.current ? list.findIndex(c => c.id === state.current.ch.id) : 0;
  const start = Math.max(0, cur - 150), end = Math.min(list.length, cur + 150);
  $('#drHead').innerHTML = `<b>${state.query ? `“${esc(state.query)}”` : esc(viewLabel(state.view))}</b><small>${list.length.toLocaleString()} channels</small>`;
  $('#drList').innerHTML = list.slice(start, end).map((c, k) => `
    <button class="dr-item${c.id === state.current?.ch.id ? ' on' : ''}" data-play="${esc(c.id)}">
      <span class="dr-num">${start + k + 1}</span>
      <span class="mini-thumb" style="--h:${hue(c.n)}"><span>${esc(initials(c.n))}</span>${c.l ? `<img src="${esc(c.l)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>
      <span class="ni-text"><b>${esc(c.n)}</b><small>${flag(c.c)} ${esc(c.g.map(catName).slice(0, 1).join('') || countryName(c.c))}</small></span>
      ${state.favs.has(c.id) ? '<span class="dr-fav">★</span>' : ''}
    </button>`).join('');
  $('#tvDrawer').hidden = false;
  $('#tvInfo').classList.remove('show');
  const on = $('#drList .dr-item.on') || $('#drList .dr-item');
  on.focus({ preventScroll: true });
  on.scrollIntoView({ block: 'center' });
}
function closeDrawer() {
  if (!$('#tvDrawer').hidden) {
    $('#tvDrawer').hidden = true;
    if (document.activeElement?.closest('#tvDrawer')) document.activeElement.blur();
  }
}

function numberKey(d) {
  numBuf = (numBuf + d).slice(-4);
  osd(numBuf);
  clearTimeout(numTimer);
  numTimer = setTimeout(() => {
    const n = +numBuf; numBuf = '';
    const list = navList();
    if (list[n - 1]) play(list[n - 1]); else osd('No channel ' + n);
  }, 1400);
}

function togglePlay() { if (state.current) video.paused ? tryPlay() : video.pause(); }

function tvSearchDone() {
  kbOpen = false;
  setTimeout(() => focusFirst($('#page'), $('#grid .card') || $('#page .facet')), 80);
}

// One key handler for the remote. Runs before the normal handlers.
function tvKey(e) {
  const k = e.key;
  const done = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  const isArrow = k.startsWith('Arrow');
  const backKey = k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack';
  const t = e.target;

  if (tvFull()) {
    if (drawerOpen()) {
      if (k === 'ArrowUp' || k === 'ArrowDown') { move(k, $('#tvDrawer')); done(); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight' || backKey) { closeDrawer(); done(); }
      else if (k === 'Enter') { document.activeElement?.click(); closeDrawer(); done(); }
      return;
    }
    if (k === 'ArrowUp' || k === 'ChannelUp') { step(-1); done(); }
    else if (k === 'ArrowDown' || k === 'ChannelDown') { step(1); done(); }
    else if (k === 'ArrowLeft' || k === 'ArrowRight') { openDrawer(); done(); }
    else if (k === 'Enter') {
      const btn = $('#overlay:not([hidden]) .overlay-actions .btn');
      if (btn) btn.click(); else showTvInfo();
      done();
    }
    else if (/^[0-9]$/.test(k)) { numberKey(k); done(); }
    else if (k === ' ' || k === 'MediaPlayPause') { togglePlay(); done(); }
    else if (backKey) { exitTvFull(); done(); }
    return;
  }

  const scope = $('#settings').open ? $('#settings') : document;
  if (t.id === 'search') {
    if (k === 'Enter') {
      if ((kbOpen || !NATIVE) && t.value.trim()) { setTimeout(tvSearchDone, 0); return; }
      if (NATIVE) { kbOpen = true; window.WorldTVAndroid.showKeyboard(); }
      done(); // keep the cursor in the box
      return;
    }
    if (k === 'ArrowDown') { kbOpen = false; t.blur(); focusFirst($('#page'), $('#grid .card')); done(); return; }
    if (k === 'ArrowUp' || ((k === 'ArrowLeft' || k === 'ArrowRight') && !t.value)) { if (move(k, scope)) done(); return; }
    return; // let left/right move the text cursor
  }
  if (isArrow) {
    if (!move(k, scope)) {
      // Nothing further in that direction: Up from the page goes to the top bar.
      if (k === 'ArrowUp' && scope === document) focusFirst($('.topbar'), $('.topnav a.active'));
    }
    done();
    return;
  }
  if (k === 'Enter') {
    const el = document.activeElement;
    if (!el || el === document.body) { focusFirst(scope); done(); return; }
    if (el.tagName === 'SELECT') { try { el.showPicker(); } catch { el.focus(); } done(); return; }
    if (el.classList.contains('check')) {
      const box = el.querySelector('input');
      box.checked = !box.checked;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      done();
      return;
    }
    if (el.matches('input')) return;
    el.click();
    done();
    return;
  }
  if (k === 'ChannelUp' || k === 'ChannelDown') { window.WorldTVNative.step(k === 'ChannelUp' ? 1 : -1); done(); return; }
  if (k === 'MediaPlayPause') { togglePlay(); done(); return; }
  if (backKey && !NATIVE && !(t.matches?.('input') && k === 'Backspace')) { window.WorldTVNative.back(); done(); }
}

video.addEventListener('playing', () => { clearTimeout(loadTimer); hideOverlay(); if (NATIVE) window.WorldTVAndroid.setPlaying(true); });
video.addEventListener('pause', () => { if (NATIVE) window.WorldTVAndroid.setPlaying(false); });
video.addEventListener('emptied', () => { if (NATIVE) window.WorldTVAndroid.setPlaying(false); });
video.addEventListener('waiting', () => { if (state.current && $('#overlay').hidden) showOverlay('', [], true); });
video.addEventListener('canplay', () => { if (!$('#overlay').querySelector('.btn')) hideOverlay(); });
video.addEventListener('volumechange', () => store.set('volume', { v: video.volume, m: video.muted }));
video.addEventListener('error', () => { if (!hls && !dash && state.current) sourceFailed('The stream could not be played.'); });
const vol = store.get('volume', { v: 1, m: false });
video.volume = vol.v; video.muted = vol.m;

// Called by the Android app (back button, TV remote, leaving the app).
window.WorldTVNative = {
  back() {
    if (drawerOpen()) { closeDrawer(); return true; }
    if (tvFull()) { exitTvFull(); return true; }
    if ($('#settings').open) { $('#settings').close(); return true; }
    if (state.searchOpen || state.query) { clearSearch(); return true; }
    if (state.current) { closePlayer(); return true; }
    if (state.view.type !== 'home') { setView({ type: 'home', value: '' }); return true; }
    return false;
  },
  step(dir) { if (state.current) step(dir); else randomChannel(); },
  pause() { if (state.current && !video.paused) video.pause(); },
  playPause: togglePlay,
  guide() { if (!state.current) return; enterTvFull(); drawerOpen() ? closeDrawer() : openDrawer(); },
  menu() { if ($('#settings').open) $('#settings').close(); else openSettings(); },
  search(text) {
    clearSearch(false);
    $('#search').value = text;
    runSearch(text, { record: true });
    if (TV) tvSearchDone();
  },
  goFullscreen,
};

function renderNow() {
  const { ch, idx, sources } = state.current;
  const fav = state.favs.has(ch.id);
  const langs = ch.la.map(langName);
  const list = navList();
  const pos = list.findIndex(c => c.id === ch.id);
  const upNext = pos >= 0 ? [1, 2, 3, 4, 5].map(k => list[(pos + k) % list.length]).filter(c => c && c.id !== ch.id) : [];
  $('#pTop').innerHTML = `<span class="live-tag"><i></i>LIVE</span><b>${esc(ch.n)}</b><span>${flag(ch.c)}</span>`;
  $('#now').innerHTML = `
    <div class="now-head">
      <div class="now-logo">${thumbHTML(ch)}</div>
      <div class="now-title">
        <span class="eyebrow"><i class="pulse"></i> Now playing</span>
        <h2>${esc(ch.n)}</h2>
        <div class="sub">${ch.c ? `<a href="${viewHash({ type: 'country', value: ch.c })}">${flag(ch.c)} ${esc(countryName(ch.c))}</a>` : '🌐 International'}${langs.length ? ` · ${esc(langs.join(', '))}` : ''}</div>
      </div>
    </div>
    <div class="chips">${ch.g.map(g => `<a class="chip" href="${viewHash({ type: 'category', value: g })}">${CAT_ICONS[g] || '📺'} ${esc(catName(g))}</a>`).join('')}</div>
    <div class="controls">
      <button class="ctl" data-action="prev" title="Previous channel (↑)">${icon('prev')}<span>Prev</span></button>
      <button class="ctl primary" data-action="next" title="Next channel (↓)">${icon('next')}<span>Next</span></button>
      <button class="ctl${fav ? ' on' : ''}" data-action="fav" title="Favorite (S)">${icon('star')}<span>${fav ? 'Saved' : 'Save'}</span></button>
      <button class="ctl" data-action="full" title="Fullscreen (F)">${icon('full')}<span>Full</span></button>
      <button class="ctl" data-action="pip" title="Mini player (P)">${icon('pip')}<span>Mini</span></button>
      <button class="ctl" data-action="share" title="Share">${icon('share')}<span>Share</span></button>
      <button class="ctl" data-action="close" title="Close player (Esc)">${icon('x')}<span>Close</span></button>
    </div>
    ${sources.length > 1 ? `<div class="sources"><span class="label">Sources</span>${sources.map((s, i) => `
      <button class="src${i === idx ? ' active' : ''}" data-src="${i}" title="${esc(STATUS_TEXT[s[2]] || '')}${s[3] ? ' · ' + esc(s[3]) : ''}">
        ${i + 1}${s[1] ? ` · ${esc(s[1])}` : ''}${s[4] ? ` · ${esc(s[4])}` : ''}${isVerified(s) ? ' ✓' : ''}</button>`).join('')}</div>` : ''}
    <div class="stream-info">
      ${sources[idx]?.[3] ? `<span class="pill warn">${esc(sources[idx][3])}</span>` : ''}
      ${sources[idx] ? `<span class="pill ${isVerified(sources[idx]) ? 'ok' : sources[idx][2]}">${esc(isVerified(sources[idx]) ? STATUS_TEXT.ok : STATUS_TEXT[sources[idx][2]] || '')}</span>` : ''}
      ${ch.w ? `<a class="pill" href="${esc(ch.w)}" target="_blank" rel="noopener">Website ↗</a>` : ''}
      ${sources[idx] && NATIVE ? `<button class="pill" data-action="external">Open in another player</button>` : ''}
      ${sources[idx] ? `<button class="pill" data-action="copy">Copy stream URL</button>` : ''}
    </div>
    ${upNext.length ? `<div class="up-next"><h3>Up next</h3>${upNext.map(c => `
      <button class="next-item" data-play="${esc(c.id)}">
        <span class="mini-thumb" style="--h:${hue(c.n)}"><span>${esc(initials(c.n))}</span>${c.l ? `<img src="${esc(c.l)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>
        <span class="ni-text"><b>${esc(c.n)}</b><small>${flag(c.c)} ${esc(c.g.map(catName).slice(0, 1).join('') || countryName(c.c))}</small></span>
        ${icon('play', 'ni-play')}
      </button>`).join('')}</div>` : ''}`;
}

function markPlaying() {
  $$('.card.playing').forEach(c => { c.classList.remove('playing'); c.querySelector('.live-tag')?.remove(); });
  if (!state.current) return;
  $$(`.card[data-id="${CSS.escape(state.current.ch.id)}"]`).forEach(card => {
    card.classList.add('playing');
    card.insertAdjacentHTML('beforeend', '<span class="live-tag"><i></i>LIVE</span>');
  });
}

// ---------- favorites & history ----------
function toggleFav(id, btn) {
  if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
  store.set('favs', [...state.favs]);
  const on = state.favs.has(id);
  $$(`[data-fav="${CSS.escape(id)}"]`).forEach(b => {
    b.classList.toggle('on', on);
    if (on) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  });
  if (state.current?.ch.id === id) renderNow();
  toast(on ? '⭐ Added to favorites' : 'Removed from favorites');
  if (state.view.type === 'fav' && !state.query) renderPage({ animate: false, scroll: false });
}
function addRecent(id) {
  state.recent = [id, ...state.recent.filter(x => x !== id)].slice(0, 50);
  store.set('recent', state.recent);
  store.set('last', id);
}

// ---------- playlists ----------
function addPlaylist(name, text, url = '') {
  const channels = parseM3U(text, name);
  if (!channels.length) throw new Error('No streams found in that playlist.');
  state.playlists = state.playlists.filter(p => p.name !== name).concat({ name, url, channels });
  if (!store.set('playlists', state.playlists)) toast('Playlist is too big to remember after reload, but you can use it now.');
  indexChannels();
  renderPlaylists();
  setView({ type: 'playlist', value: name });
  return channels.length;
}
function renderPlaylists() {
  $('#playlistList').innerHTML = state.playlists.map(p => `
    <div class="pl"><a href="${viewHash({ type: 'playlist', value: p.name })}">📃 ${esc(p.name)} <small>${p.channels.length} channels</small></a>
    <button class="btn ghost small" data-remove-pl="${esc(p.name)}">Remove</button></div>`).join('');
}

// ---------- UI glue ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { prompt('Copy this:', text); }
}
function setStatus(level) {
  state.status = level;
  store.set('status', level);
  $$('#statusSeg [data-status]').forEach(b => b.setAttribute('aria-checked', b.dataset.status === level));
  computeCounts();
  renderPage({ animate: false, scroll: false });
}

function handleAction(action, el) {
  const cur = state.current;
  switch (action) {
    case 'next': step(1); break;
    case 'prev': step(-1); break;
    case 'random': randomChannel(); break;
    case 'random-here': randomChannel(state.list); break;
    case 'retry': if (cur) { cur.sources.forEach(s => state.failed.delete(s[0])); play(cur.ch, 0); } break;
    case 'stay': clearInterval(skipTimer); $('#overlayActions [data-action="stay"]')?.remove(); $('#overlayMsg .countdown')?.remove(); $('#overlayMsg small:last-child')?.remove(); break;
    case 'fav': if (cur) toggleFav(cur.ch.id); break;
    case 'close': closePlayer(); break;
    case 'full': toggleFullscreen(); break;
    case 'unfloat': $('#player').classList.remove('floating'); scrollTo({ top: 0, behavior: 'smooth' }); break;
    case 'layout':
      state.layout = state.layout === 'grid' ? 'list' : 'grid';
      store.set('layout', state.layout);
      $('#grid')?.classList.toggle('list', state.layout === 'list');
      $('#grid')?.classList.toggle('grid', true);
      el.innerHTML = icon(state.layout === 'grid' ? 'list' : 'grid');
      break;
    case 'toggle-verified': setStatus(state.status === 'ok' ? 'playable' : 'ok'); break;
    case 'widen': state.lang = ''; setStatus('playable'); break;
    case 'clear-searches': state.searches = []; store.set('searches', []); renderPage({ animate: false, scroll: false }); break;
    case 'pip':
      if (NATIVE) { goFullscreen(); window.WorldTVAndroid.pip(); break; }
      if (document.pictureInPictureElement) document.exitPictureInPicture();
      else video.requestPictureInPicture?.().catch(() => toast('Mini player is not available for this stream'));
      break;
    case 'share':
      if (!cur) break;
      if (NATIVE) window.WorldTVAndroid.share(cur.ch.n, `Watch ${cur.ch.n} live on Zapply: ${SITE_URL}#ch=${encodeURIComponent(cur.ch.id)}`);
      else if (navigator.share && TOUCH) navigator.share({ title: cur.ch.n, text: `Watch ${cur.ch.n} live on Zapply`, url: location.href }).catch(() => {});
      else copy(location.href, '🔗 Link copied');
      break;
    case 'copy':
      if (!cur) break;
      if (NATIVE) window.WorldTVAndroid.copy(cur.sources[cur.idx][0], 'Stream URL copied');
      else copy(cur.sources[cur.idx][0], 'Stream URL copied — open it in VLC: Media → Open Network Stream');
      break;
    case 'external': if (cur) { video.pause(); window.WorldTVAndroid.openInPlayer(cur.sources[cur.idx][0], cur.ch.n); } break;
  }
}

function bindPlayerGestures() {
  const p = $('#player');
  // Hide the channel caption when the viewer is idle.
  const wake = () => {
    p.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => p.classList.add('idle'), 2800);
  };
  ['mousemove', 'touchstart'].forEach(ev => p.addEventListener(ev, wake, { passive: true }));

  let x0 = 0, y0 = 0, t0 = 0, lastTap = 0;
  p.addEventListener('touchstart', e => {
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
  }, { passive: true });
  p.addEventListener('touchend', e => {
    if (p.classList.contains('floating')) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Date.now() - t0 < 600 && Math.abs(dx) > 70 && Math.abs(dy) < 50) {
      step(dx < 0 ? 1 : -1);
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const now = Date.now();
      if (now - lastTap < 300) { toggleFullscreen(); lastTap = 0; }
      else lastTap = now;
    }
  });
  p.addEventListener('dblclick', e => { if (!TOUCH) { e.preventDefault(); toggleFullscreen(); } });
  video.addEventListener('click', () => { if (video.muted && !video.paused) { video.muted = false; osd('🔊 Sound on'); } });

  // Float the player in a corner while scrolling through channels (wide screens).
  new IntersectionObserver(([en]) => {
    const float = !TV && !en.isIntersecting && state.current && innerWidth >= 900 && !document.fullscreenElement;
    p.classList.toggle('floating', !!float);
  }, { threshold: 0.25 }).observe($('.player-slot'));
}

function bind() {
  if (TV) {
    document.body.classList.add('tv');
    video.controls = false;
    video.tabIndex = -1;
    window.addEventListener('keydown', tvKey, true);
    $('#search').addEventListener('blur', () => { kbOpen = false; });
    if (NATIVE) $('#voiceBtn').hidden = false;
    $('#voiceBtn').addEventListener('click', () => window.WorldTVAndroid?.voiceSearch());
    $('#search').placeholder = 'Search channels';
    // Whole toggle rows are easier to reach with a remote than the small switches.
    $$('.check').forEach(l => { l.tabIndex = 0; l.querySelector('input').tabIndex = -1; });
    $('#settings').addEventListener('close', () => setTimeout(() => focusFirst($('#page')), 50));
  }
  document.addEventListener('click', e => {
    const fav = e.target.closest('[data-fav]');
    if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav, fav); return; }
    const playBtn = e.target.closest('[data-play]');
    if (playBtn) { play(state.byId.get(playBtn.dataset.play)); return; }
    const card = e.target.closest('.card');
    if (card) {
      if (state.query) runSearch(state.query, { record: true });
      play(state.byId.get(card.dataset.id));
      return;
    }
    const act = e.target.closest('[data-action]');
    if (act) { handleAction(act.dataset.action, act); return; }
    const src = e.target.closest('[data-src]');
    if (src) { play(state.current.ch, +src.dataset.src); return; }
    const sq = e.target.closest('[data-search]');
    if (sq) { $('#search').value = sq.dataset.search; runSearch(sq.dataset.search, { record: true }); return; }
    const dot = e.target.closest('[data-dot]');
    if (dot) { $('#hero')?._go(+dot.dataset.dot); return; }
    const rail = e.target.closest('[data-rail]');
    if (rail) {
      const r = rail.parentNode.querySelector('.rail');
      r.scrollBy({ left: +rail.dataset.rail * r.clientWidth * 0.85, behavior: 'smooth' });
      return;
    }
    const rm = e.target.closest('[data-remove-pl]');
    if (rm) {
      state.playlists = state.playlists.filter(p => p.name !== rm.dataset.removePl);
      store.set('playlists', state.playlists);
      indexChannels(); renderPlaylists();
      if (state.view.type === 'playlist') setView({ type: 'home', value: '' });
      return;
    }
    const nav = e.target.closest('a[href^="#"]');
    if (nav) {
      e.preventDefault();
      if ($('#settings').open) $('#settings').close();
      const { view } = parseView(nav.getAttribute('href'));
      setView(view);
    }
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'langFilter') { state.lang = e.target.value; renderPage({ animate: false, scroll: false }); }
    if (e.target.id === 'sortSel') { state.sort = e.target.value; store.set('sort', state.sort); renderPage({ animate: false, scroll: false }); }
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'countryFilter') renderCountryGrid(e.target.value);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.classList?.contains('card')) { play(state.byId.get(e.target.dataset.id)); return; }
    const typing = /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || $('#settings').open;
    if (e.key === '/' && !typing) { e.preventDefault(); openSearch(); return; }
    if (e.key === 'Escape') {
      if (document.activeElement === $('#search')) { if (state.query) clearSearch(); else $('#search').blur(); return; }
      if (state.current && !document.fullscreenElement) closePlayer();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') randomChannel();
    if (!state.current) return;
    if (['arrowdown', 'pagedown'].includes(k)) { e.preventDefault(); step(1); }
    else if (['arrowup', 'pageup'].includes(k)) { e.preventDefault(); step(-1); }
    else if (k === ' ' && e.target === document.body) { e.preventDefault(); video.paused ? tryPlay() : video.pause(); }
    else if (k === 'f') toggleFullscreen();
    else if (k === 'm') { video.muted = !video.muted; osd(video.muted ? '🔇 Muted' : '🔊 Sound on'); }
    else if (k === 's') toggleFav(state.current.ch.id);
    else if (k === 'p') handleAction('pip');
  });

  // Search: instant results, global, works with the phone keyboard's search key.
  const input = $('#search');
  input.addEventListener('focus', () => {
    document.body.classList.add('searching');
    if (!state.searchOpen) { state.searchOpen = true; if (!state.query) renderPage({ animate: true, scroll: false }); }
  });
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    $('#searchClear').hidden = !input.value;
    searchTimer = setTimeout(() => runSearch(input.value), 120);
  });
  input.addEventListener('compositionend', () => runSearch(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      runSearch(input.value, { record: true });
      input.blur(); // close the phone keyboard so results are visible
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      $('#grid .card')?.focus();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!state.query && document.activeElement !== input) document.body.classList.remove('searching');
    }, 150);
  });
  input.addEventListener('search', () => { if (!input.value) clearSearch(); });
  $('#searchClear').addEventListener('click', () => { clearSearch(false); openSearch(); renderPage({ animate: false }); });
  $('#tabSearch').addEventListener('click', openSearch);
  $('#tabMore').addEventListener('click', openSettings);

  $('#randomBtn').addEventListener('click', () => randomChannel());
  $('#themeBtn').addEventListener('click', () => {
    const dark = !matchMedia('(prefers-color-scheme: light)').matches;
    const cur = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    const apply = () => { document.documentElement.dataset.theme = next; };
    if (document.startViewTransition && !REDUCED_MOTION) document.startViewTransition(apply); else apply();
    try { localStorage.setItem('wtv.theme', next); } catch {}
  });
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#brandLink').addEventListener('click', e => { e.preventDefault(); setView({ type: 'home', value: '' }); });

  $$('#statusSeg [data-status]').forEach(b => b.addEventListener('click', () => setStatus(b.dataset.status)));
  $('#autoSkip').checked = state.settings.autoSkip;
  $('#autoplayHero').checked = state.settings.resume;
  $('#autoSkip').addEventListener('change', e => { state.settings.autoSkip = e.target.checked; store.set('settings', state.settings); });
  $('#autoplayHero').addEventListener('change', e => { state.settings.resume = e.target.checked; store.set('settings', state.settings); });

  $('#m3uUrlBtn').addEventListener('click', async () => {
    const url = $('#m3uUrl').value.trim();
    if (!/^https?:\/\//i.test(url)) return toast('Enter a link starting with http:// or https://');
    const btn = $('#m3uUrlBtn'); btn.disabled = true; btn.textContent = 'Loading…';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(text)) {
        const ch = { id: 'url:' + url, n: new URL(url).hostname, c: '', g: [], l: '', la: [], w: '', s: [[url, '', 'unk', '', '']] };
        indexChannel(ch, '');
        state.byId.set(ch.id, ch);
        $('#settings').close();
        play(ch);
      } else {
        const name = new URL(url).pathname.split('/').pop().replace(/\.m3u8?$/i, '') || new URL(url).hostname;
        toast(`Added ${addPlaylist(name, text, url)} channels`);
        $('#settings').close();
      }
    } catch (e) {
      toast(`Could not load playlist (${e.message}). The server may block web apps.`);
    } finally { btn.disabled = false; btn.textContent = 'Add'; }
  });
  $('#m3uFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { toast(`Added ${addPlaylist(f.name.replace(/\.m3u8?$/i, ''), await f.text())} channels`); $('#settings').close(); }
    catch (err) { toast(err.message); }
    e.target.value = '';
  });
  $('#exportBtn').addEventListener('click', () => {
    const list = state.list.length ? state.list : state.catalog.channels.filter(c => streamsFor(c).length);
    const text = toM3U(list, state.catalog, ch => streamsFor(ch, 'all')[0]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'audio/x-mpegurl' }));
    a.download = (viewLabel(state.view).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'zapply') + '.m3u';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#refreshBtn').addEventListener('click', refreshFromApi);
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Clear favorites, watch history and added playlists?')) return;
    state.favs.clear(); state.recent = []; state.playlists = []; state.searches = [];
    ['favs', 'recent', 'playlists', 'searches'].forEach(k => store.set(k, []));
    store.set('last', null);
    indexChannels(); renderPage(); renderPlaylists();
    toast('Cleared');
  });

  new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && $('#grid') && state.rendered < state.list.length) appendGrid();
  }, { rootMargin: '900px' }).observe($('#sentinel'));

  window.addEventListener('popstate', () => {
    const { view, ch } = parseView(location.hash);
    state.view = view;
    clearSearch(false);
    renderPage({ scroll: false });
    if (ch && ch !== state.current?.ch.id && state.byId.get(ch)) play(state.byId.get(ch));
  });
  window.addEventListener('resize', () => requestAnimationFrame(updateNav));
  document.fonts?.ready.then(updateNav);
  bindPlayerGestures();
}

function openSettings() {
  renderPlaylists();
  updateDataInfo();
  $$('#statusSeg [data-status]').forEach(b => b.setAttribute('aria-checked', b.dataset.status === state.status));
  $('#settings').showModal();
  if (TV) focusEl($('#statusSeg [aria-checked="true"]'));
}

function updateDataInfo() {
  const c = state.catalog;
  const s = c.channels.reduce((a, ch) => a + ch.s.length, 0);
  $('#dataInfo').textContent = `${c.channels.length.toLocaleString()} channels, ${s.toLocaleString()} streams. Updated ${new Date(c.updated).toLocaleDateString()}${c.checked ? ', every stream checked' : ''}.`;
}

async function refreshFromApi() {
  const btn = $('#refreshBtn'), status = $('#refreshStatus');
  btn.disabled = true;
  try {
    status.textContent = 'Downloading the latest channel database (about 30 MB)…';
    const api = await fetchApi(fetch, (n, t) => { status.textContent = `Downloading… ${n}/${t}`; });
    const fresh = buildCatalog(api);
    const known = new Map(state.catalog.channels.flatMap(ch => ch.s.map(s => [s[0], s[2]])));
    for (const ch of fresh.channels) for (const s of ch.s) if (known.has(s[0])) s[2] = known.get(s[0]);
    fresh.checked = state.catalog.checked;
    const added = fresh.channels.length - state.catalog.channels.length;
    state.catalog = fresh;
    await cacheCatalog(fresh);
    indexChannels(); renderPage({ animate: false, scroll: false }); updateDataInfo();
    status.textContent = `Done. ${fresh.channels.length.toLocaleString()} channels (${added >= 0 ? '+' : ''}${added}). New streams are unchecked.`;
  } catch (e) {
    status.textContent = 'Update failed: ' + e.message;
  } finally { btn.disabled = false; }
}

async function cacheCatalog(cat) {
  try {
    const c = await caches.open('wtv-data');
    await c.put('catalog-live.json', new Response(JSON.stringify(cat), { headers: { 'content-type': 'application/json' } }));
  } catch {}
}
async function loadCatalog() {
  let live = null;
  try {
    const c = await caches.open('wtv-data');
    const r = await c.match('catalog-live.json');
    if (r) live = await r.json();
  } catch {}
  const res = await fetch('data/channels.json');
  if (!res.ok) throw new Error('Could not load channel list (HTTP ' + res.status + ')');
  const bundled = await res.json();
  return live && new Date(live.updated) > new Date(bundled.updated) ? live : bundled;
}

function skeleton() {
  $('#page').innerHTML = `<div class="skeleton hero-sk"></div>
    <div class="skeleton-row">${'<div class="skeleton card-sk"></div>'.repeat(8)}</div>
    <div class="skeleton-row">${'<div class="skeleton card-sk"></div>'.repeat(8)}</div>`;
}

// ---------- start ----------
async function start() {
  skeleton();
  try {
    state.catalog = await loadCatalog();
  } catch (e) {
    $('#page').innerHTML = `<div class="empty"><div class="big">⚠️</div><h3>${esc(e.message)}</h3><p class="hint">If you opened index.html directly from disk, run a local web server instead (see README).</p></div>`;
    return;
  }
  if (!state.status) state.status = state.catalog.checked ? 'ok' : 'playable';
  indexChannels();
  bind();
  const { view, ch } = parseView(location.hash);
  state.view = view;
  renderPage({ animate: false, scroll: false });
  const target = ch ? state.byId.get(ch) : (state.settings.resume ? state.byId.get(store.get('last', '')) : null);
  if (target) play(target);
  if (!NATIVE && 'serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (NATIVE) refreshFromSite();
}

// The app ships with a channel list, then quietly picks up the weekly
// refreshed list from the website.
async function refreshFromSite() {
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30000);
    const res = await fetch(SITE_URL + 'data/channels.json', { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) return;
    const fresh = await res.json();
    if (!fresh?.channels?.length || new Date(fresh.updated) <= new Date(state.catalog.updated)) return;
    state.catalog = fresh;
    await cacheCatalog(fresh);
    indexChannels();
    if (!state.current && !state.query) renderPage({ animate: false, scroll: false });
    toast(`Channel list updated · ${fresh.channels.length.toLocaleString()} channels`);
  } catch {}
}

start();
