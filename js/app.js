import { buildCatalog, fetchApi } from './builder.js';
import { parseM3U, toM3U } from './m3u.js';

// ---------- helpers ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('wtv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wtv.' + k, JSON.stringify(v)); return true; } catch { return false; } },
};
const PAGE = 60;
const IS_HTTPS = location.protocol === 'https:';
const CAT_ICONS = {
  animation: '🎨', auto: '🚗', business: '💼', classic: '🎞️', comedy: '😂', cooking: '🍳', culture: '🎭',
  documentary: '🌍', education: '🎓', entertainment: '🎬', family: '👨‍👩‍👧', general: '📺', interactive: '🕹️',
  kids: '🧸', legislative: '🏛️', lifestyle: '🌿', movies: '🍿', music: '🎵', news: '📰', outdoor: '🏕️',
  public: '🏢', relax: '🧘', religious: '🙏', science: '🔬', series: '📼', shop: '🛍️', sports: '⚽',
  travel: '✈️', weather: '⛅', xxx: '🔞',
};
const STATUS_TEXT = { ok: 'Verified', unk: 'Unchecked', geo: 'May be region locked', nc: 'May not play in browsers' };

// ---------- state ----------
const state = {
  catalog: null,
  all: [],              // bundled + custom channels
  byId: new Map(),
  view: { type: 'all', value: '' },
  query: '',
  lang: '',
  status: store.get('status', null),
  sort: store.get('sort', 'name'),
  layout: store.get('layout', 'grid'),
  favs: new Set(store.get('favs', [])),
  recent: store.get('recent', []),
  playlists: store.get('playlists', []),  // [{name, url?, channels}]
  settings: Object.assign({ autoSkip: true, resume: true }, store.get('settings', {})),
  failed: new Set(),    // stream URLs that failed this session
  list: [],             // current filtered list
  rendered: 0,
  current: null,        // { ch, idx (source index) }
};

// ---------- stream helpers ----------
function playable(s) {
  if (state.failed.has(s[0])) return false;
  if (IS_HTTPS && s[0].startsWith('http:')) return false;
  return true;
}
function streamsFor(ch, level = state.status) {
  return ch.s.filter(s => playable(s) && (
    level === 'all' ? true :
    level === 'ok' ? s[2] === 'ok' :
    s[2] !== 'nc'));
}
function bestQuality(ch) { return Math.max(0, ...ch.s.map(s => parseInt(s[1]) || 0)); }
function countryName(code) { return state.catalog.countries[code]?.[0] || (code ? code : 'International'); }
function flag(code) { return state.catalog.countries[code]?.[1] || '🌐'; }

function indexChannels() {
  state.all = [...state.catalog.channels, ...state.playlists.flatMap(p => p.channels)];
  state.byId = new Map(state.all.map(ch => [ch.id, ch]));
  for (const ch of state.all) {
    ch._q = (ch.n + ' ' + countryName(ch.c) + ' ' + ch.c + ' ' + ch.g.join(' ') + ' ' +
      ch.la.map(l => state.catalog.languages[l] || l).join(' ')).toLowerCase();
  }
}

// ---------- filtering ----------
function baseList(view) {
  switch (view.type) {
    case 'fav': return state.all.filter(ch => state.favs.has(ch.id));
    case 'recent': return state.recent.map(id => state.byId.get(id)).filter(Boolean);
    case 'country': return state.all.filter(ch => ch.c === view.value && !ch.custom);
    case 'category': return state.all.filter(ch => ch.g.includes(view.value) && !ch.custom);
    case 'playlist': return state.all.filter(ch => ch.custom === view.value);
    default: return state.catalog.channels;
  }
}

function computeList() {
  const v = state.view;
  let list = baseList(v);
  // Favorites, history and personal playlists show everything the user picked.
  const level = ['fav', 'recent', 'playlist'].includes(v.type) ? 'all' : state.status;
  list = list.filter(ch => streamsFor(ch, level).length);
  if (state.lang) list = list.filter(ch => ch.la.includes(state.lang));
  if (state.query) {
    const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter(ch => terms.every(t => ch._q.includes(t)));
    const q = state.query.toLowerCase();
    list = [...list].sort((a, b) => (b.n.toLowerCase().startsWith(q) - a.n.toLowerCase().startsWith(q)));
  } else if (v.type !== 'recent') {
    if (state.sort === 'country') list = [...list].sort((a, b) => countryName(a.c).localeCompare(countryName(b.c)) || a.n.localeCompare(b.n));
    else if (state.sort === 'quality') list = [...list].sort((a, b) => bestQuality(b) - bestQuality(a) || a.n.localeCompare(b.n));
  }
  return list;
}

// ---------- sidebar ----------
function renderSidebar() {
  const cat = state.catalog;
  const counts = { country: {}, category: {} };
  let total = 0;
  for (const ch of cat.channels) {
    if (!streamsFor(ch).length) continue;
    total++;
    counts.country[ch.c] = (counts.country[ch.c] || 0) + 1;
    for (const g of ch.g) counts.category[g] = (counts.category[g] || 0) + 1;
  }
  const item = (type, value, icon, label, count) => {
    const active = state.view.type === type && state.view.value === value;
    return `<a href="${viewHash({ type, value })}" class="nav-item${active ? ' active' : ''}" data-type="${type}" data-value="${esc(value)}">
      <span class="nav-icon">${icon}</span><span class="nav-label">${esc(label)}</span>${count != null ? `<span class="nav-count">${count.toLocaleString()}</span>` : ''}</a>`;
  };

  $('#libraryNav').innerHTML =
    item('all', '', '📺', 'All channels', total) +
    item('fav', '', '⭐', 'Favorites', state.favs.size) +
    item('recent', '', '🕘', 'Recently watched', state.recent.length) +
    state.playlists.map(p => item('playlist', p.name, '📃', p.name, p.channels.length)).join('');

  $('#categoryNav').innerHTML = Object.entries(cat.categories)
    .filter(([id]) => counts.category[id])
    .sort((a, b) => counts.category[b[0]] - counts.category[a[0]])
    .map(([id, name]) => item('category', id, CAT_ICONS[id] || '📺', name, counts.category[id])).join('');

  const f = $('#countryFilter').value.trim().toLowerCase();
  $('#countryNav').innerHTML = Object.keys(counts.country)
    .map(code => [code, countryName(code)])
    .filter(([code, name]) => !f || name.toLowerCase().includes(f) || code.toLowerCase() === f)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => item('country', code, flag(code), name, counts.country[code])).join('');
}

function fillLanguages() {
  const counts = {};
  for (const ch of state.catalog.channels) for (const l of ch.la) counts[l] = (counts[l] || 0) + 1;
  const opts = Object.entries(counts).filter(([, n]) => n >= 3)
    .map(([code]) => [code, state.catalog.languages[code] || code])
    .sort((a, b) => a[1].localeCompare(b[1]));
  $('#langFilter').innerHTML = '<option value="">All languages</option>' +
    opts.map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join('');
  $('#langFilter').value = state.lang;
}

// ---------- grid ----------
function viewLabel(v) {
  switch (v.type) {
    case 'fav': return '⭐ Favorites';
    case 'recent': return '🕘 Recently watched';
    case 'country': return `${flag(v.value)} ${countryName(v.value)}`;
    case 'category': return `${CAT_ICONS[v.value] || '📺'} ${state.catalog.categories[v.value] || v.value}`;
    case 'playlist': return `📃 ${v.value}`;
    default: return 'All channels';
  }
}

function initials(name) {
  return name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'TV';
}
function hue(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

function cardHTML(ch) {
  const q = bestQuality(ch);
  const playing = state.current?.ch.id === ch.id;
  const fav = state.favs.has(ch.id);
  const cat = ch.g[0] ? (state.catalog.categories[ch.g[0]] || ch.g[0]) : '';
  const verified = ch.s.some(s => s[2] === 'ok');
  return `<article class="card${playing ? ' playing' : ''}" data-id="${esc(ch.id)}" tabindex="0" role="button" aria-label="Play ${esc(ch.n)}">
    <div class="thumb" style="--h:${hue(ch.n)}">
      <span class="initials">${esc(initials(ch.n))}</span>
      ${ch.l ? `<img src="${esc(ch.l)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      ${q >= 720 ? `<span class="badge q">${q >= 2160 ? '4K' : q >= 1080 ? 'FHD' : 'HD'}</span>` : ''}
      ${playing ? '<span class="badge live">● LIVE</span>' : ''}
    </div>
    <div class="meta">
      <div class="name" title="${esc(ch.n)}">${esc(ch.n)}</div>
      <div class="sub"><span>${flag(ch.c)} ${esc(countryName(ch.c))}</span>${cat ? `<span class="dot">·</span><span>${esc(cat)}</span>` : ''}</div>
    </div>
    ${verified ? '<span class="verified" title="Stream checked and working">✓</span>' : ''}
    <button class="fav${fav ? ' on' : ''}" data-fav="${esc(ch.id)}" aria-label="${fav ? 'Remove from' : 'Add to'} favorites" title="Favorite">★</button>
  </article>`;
}

function renderGrid(reset = true) {
  const grid = $('#grid');
  if (reset) {
    state.list = computeList();
    state.rendered = 0;
    grid.innerHTML = '';
    grid.className = 'grid ' + state.layout;
    $('#viewTitle').textContent = state.query ? `Results for “${state.query}”` : viewLabel(state.view);
    $('#viewCount').textContent = `${state.list.length.toLocaleString()} channel${state.list.length === 1 ? '' : 's'}`;
    const empty = $('#empty');
    empty.hidden = state.list.length > 0;
    if (!state.list.length) {
      empty.innerHTML = state.view.type === 'fav' && !state.query
        ? '<div class="big">⭐</div><p>No favorites yet. Tap the star on any channel to save it here.</p>'
        : `<div class="big">📡</div><p>No channels match.</p>${state.status === 'ok' ? '<button class="btn" id="widenBtn">Show unverified streams too</button>' : ''}`;
    }
    renderHero();
  }
  const next = state.list.slice(state.rendered, state.rendered + PAGE);
  grid.insertAdjacentHTML('beforeend', next.map(cardHTML).join(''));
  state.rendered += next.length;
}

function renderHero() {
  const hero = $('#hero');
  if (state.view.type !== 'all' || state.query || state.current) { hero.innerHTML = ''; return; }
  const countries = new Set(state.catalog.channels.map(c => c.c)).size;
  const verified = state.catalog.channels.filter(c => c.s.some(s => s[2] === 'ok')).length;
  const picks = ['news', 'sports', 'movies', 'music', 'kids', 'documentary', 'entertainment', 'science']
    .filter(c => state.catalog.categories[c]);
  hero.innerHTML = `<div class="hero-card">
    <div>
      <h2>Live TV from around the world</h2>
      <p>${state.catalog.channels.length.toLocaleString()} free channels from ${countries} countries${verified ? `, ${verified.toLocaleString()} checked and working` : ''}. Pick a channel and it starts playing.</p>
      <div class="chips">${picks.map(c => `<a class="chip" href="${viewHash({ type: 'category', value: c })}">${CAT_ICONS[c]} ${esc(state.catalog.categories[c])}</a>`).join('')}</div>
    </div>
    <button class="btn big-btn" data-action="random">🎲 Surprise me</button>
  </div>`;
}

// ---------- routing ----------
function viewHash(v, ch = null) {
  const p = new URLSearchParams();
  if (v.type !== 'all') p.set('v', v.value ? `${v.type}:${v.value}` : v.type);
  if (ch) p.set('ch', ch);
  const s = p.toString();
  return '#' + s;
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const v = p.get('v') || '';
  const i = v.indexOf(':');
  return { view: v ? { type: i < 0 ? v : v.slice(0, i), value: i < 0 ? '' : v.slice(i + 1) } : { type: 'all', value: '' }, ch: p.get('ch') };
}
function setView(view, push = true) {
  state.view = view;
  if (push) history.pushState(null, '', viewHash(view, state.current?.ch.id));
  closeMenu();
  renderSidebar();
  renderGrid();
  document.querySelector('.browse').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---------- player ----------
const video = $('#video');
let hls = null, dash = null, loadTimer = null, skipTimer = null, osdTimer = null;

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
  $('#overlayActions').innerHTML = actions.map(a => `<button class="btn${a.ghost ? ' ghost' : ''}" data-action="${a.action}">${a.label}</button>`).join('');
}
function hideOverlay() { $('#overlay').hidden = true; }

function osd(text) {
  const el = $('#osd');
  el.textContent = text;
  el.classList.add('show');
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
  state.current = { ch, idx: srcIdx, sources };
  $('#playerWrap').hidden = false;
  document.title = `${ch.n} — WorldTV`;
  history.replaceState(null, '', viewHash(state.view, ch.id));
  addRecent(ch.id);
  renderNow();
  markPlaying();
  renderHero();

  destroyEngines();
  if (!sources.length) return fail('No playable source for this channel.');
  const src = sources[srcIdx];
  showOverlay(`Tuning to <b>${esc(ch.n)}</b>${sources.length > 1 ? ` · source ${srcIdx + 1}/${sources.length}` : ''}`, [], true);
  loadTimer = setTimeout(() => sourceFailed('The stream took too long to start.'), 20000);
  attach(src[0]).catch(e => sourceFailed(e.message));
  if (innerWidth < 900) $('#playerWrap').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function attach(url) {
  const isDash = /\.mpd(\?|$)/i.test(url);
  if (isDash) {
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
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url; // Safari / iOS play HLS natively
  } else {
    video.src = url;
  }
  tryPlay();
}

function tryPlay() {
  const p = video.play();
  if (p) p.catch(err => {
    if (err.name === 'NotAllowedError') {
      // Browser blocked autoplay with sound: start muted and offer to unmute.
      video.muted = true;
      video.play().then(() => osd('🔇 Muted — tap to unmute')).catch(() => {});
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
    osd(`Source ${cur.idx + 1} failed, trying source ${cur.idx + 2}…`);
    play(cur.ch, cur.idx + 1);
    return;
  }
  fail(reason);
}

function fail(reason) {
  destroyEngines();
  const card = document.querySelector(`.card[data-id="${CSS.escape(state.current.ch.id)}"]`);
  card?.classList.add('broken');
  const actions = [{ action: 'next', label: 'Next channel ▶' }, { action: 'retry', label: 'Try again', ghost: true }];
  if (state.settings.autoSkip && state.list.length > 1) {
    let n = 5;
    const msg = () => `<b>${esc(state.current.ch.n)}</b> isn't available right now.<br><small>${esc(reason)}</small><br><small>Skipping to the next channel in ${n}s…</small>`;
    showOverlay(msg(), actions.concat({ action: 'stay', label: 'Stay', ghost: true }));
    skipTimer = setInterval(() => {
      n--;
      if (n <= 0) { clearInterval(skipTimer); step(1); }
      else $('#overlayMsg').innerHTML = msg();
    }, 1000);
  } else {
    showOverlay(`<b>${esc(state.current.ch.n)}</b> isn't available right now.<br><small>${esc(reason)}</small>`, actions);
  }
}

function step(dir) {
  const list = state.list.length ? state.list : state.catalog.channels;
  const i = state.current ? list.findIndex(c => c.id === state.current.ch.id) : -1;
  const next = list[(i + dir + list.length) % list.length];
  play(next);
  osd(`${dir > 0 ? '▶' : '◀'} ${next.n}`);
}

function randomChannel() {
  const pool = state.list.length > 1 ? state.list : state.catalog.channels.filter(c => streamsFor(c).length);
  play(pool[Math.floor(Math.random() * pool.length)]);
}

function closePlayer() {
  destroyEngines();
  state.current = null;
  $('#playerWrap').hidden = true;
  document.title = 'WorldTV — Free Live TV';
  history.replaceState(null, '', viewHash(state.view));
  markPlaying();
  renderHero();
}

video.addEventListener('playing', () => { clearTimeout(loadTimer); hideOverlay(); });
video.addEventListener('waiting', () => { if (state.current && $('#overlay').hidden) showOverlay('', [], true); });
video.addEventListener('canplay', () => { if (!$('#overlay').querySelector('.btn')) hideOverlay(); });
video.addEventListener('volumechange', () => store.set('volume', { v: video.volume, m: video.muted }));
video.addEventListener('error', () => { if (!hls && !dash && state.current) sourceFailed('The stream could not be played.'); });
const vol = store.get('volume', { v: 1, m: false });
video.volume = vol.v; video.muted = vol.m;

function renderNow() {
  const { ch, idx, sources } = state.current;
  const fav = state.favs.has(ch.id);
  const cats = ch.g.map(g => state.catalog.categories[g] || g);
  const langs = ch.la.map(l => state.catalog.languages[l] || l);
  $('#now').innerHTML = `
    <div class="now-head">
      <div class="now-logo" style="--h:${hue(ch.n)}"><span>${esc(initials(ch.n))}</span>${ch.l ? `<img src="${esc(ch.l)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</div>
      <div class="now-title">
        <h2>${esc(ch.n)}</h2>
        <div class="sub">${ch.c ? `<a href="${viewHash({ type: 'country', value: ch.c })}">${flag(ch.c)} ${esc(countryName(ch.c))}</a>` : '🌐 International'}
          ${langs.length ? ` · ${esc(langs.join(', '))}` : ''}</div>
      </div>
    </div>
    <div class="chips">${ch.g.map((g, i) => `<a class="chip" href="${viewHash({ type: 'category', value: g })}">${CAT_ICONS[g] || '📺'} ${esc(cats[i])}</a>`).join('')}</div>
    <div class="controls">
      <button class="btn ghost" data-action="prev" title="Previous channel (↑)">◀ Prev</button>
      <button class="btn" data-action="next" title="Next channel (↓)">Next ▶</button>
      <button class="btn ghost${fav ? ' on' : ''}" data-action="fav" title="Favorite (S)">${fav ? '★ Saved' : '☆ Save'}</button>
      <button class="btn ghost" data-action="pip" title="Picture-in-picture (P)">⧉ Mini</button>
      <button class="btn ghost" data-action="share" title="Copy link to this channel">🔗 Share</button>
      <button class="btn ghost" data-action="close" title="Close player (Esc)">✕</button>
    </div>
    ${sources.length > 1 ? `<div class="sources"><span class="label">Sources</span>${sources.map((s, i) => `
      <button class="src${i === idx ? ' active' : ''}" data-src="${i}" title="${esc(STATUS_TEXT[s[2]] || '')}${s[3] ? ' · ' + esc(s[3]) : ''}">
        ${i + 1}${s[1] ? ` · ${esc(s[1])}` : ''}${s[4] ? ` · ${esc(s[4])}` : ''}${s[2] === 'ok' ? ' ✓' : ''}</button>`).join('')}</div>` : ''}
    <div class="stream-info">
      ${sources[idx]?.[3] ? `<span class="pill warn">${esc(sources[idx][3])}</span>` : ''}
      ${sources[idx] ? `<span class="pill ${sources[idx][2]}">${esc(STATUS_TEXT[sources[idx][2]] || '')}</span>` : ''}
      ${ch.w ? `<a class="pill" href="${esc(ch.w)}" target="_blank" rel="noopener">Website ↗</a>` : ''}
      ${sources[idx] ? `<button class="pill" data-action="copy" title="Copy stream URL to use in VLC or another player">Copy stream URL</button>` : ''}
    </div>`;
}

function markPlaying() {
  document.querySelectorAll('.card.playing').forEach(c => {
    c.classList.remove('playing'); c.querySelector('.badge.live')?.remove();
  });
  if (!state.current) return;
  const card = document.querySelector(`.card[data-id="${CSS.escape(state.current.ch.id)}"]`);
  if (card) {
    card.classList.add('playing');
    card.querySelector('.thumb').insertAdjacentHTML('beforeend', '<span class="badge live">● LIVE</span>');
  }
}

// ---------- favorites & history ----------
function toggleFav(id) {
  if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
  store.set('favs', [...state.favs]);
  const on = state.favs.has(id);
  document.querySelectorAll(`[data-fav="${CSS.escape(id)}"]`).forEach(b => b.classList.toggle('on', on));
  if (state.current?.ch.id === id) renderNow();
  toast(on ? '★ Added to favorites' : 'Removed from favorites');
  renderSidebar();
  if (state.view.type === 'fav') renderGrid();
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
  renderSidebar();
  renderPlaylists();
  setView({ type: 'playlist', value: name });
  return channels.length;
}
function renderPlaylists() {
  $('#playlistList').innerHTML = state.playlists.map(p => `
    <div class="pl"><span>📃 ${esc(p.name)} <small>${p.channels.length} channels</small></span>
    <button class="btn ghost small" data-remove-pl="${esc(p.name)}">Remove</button></div>`).join('');
}

// ---------- UI glue ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function openMenu() { document.body.classList.add('menu-open'); }
function closeMenu() { document.body.classList.remove('menu-open'); }

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { prompt('Copy this:', text); }
}

function handleAction(action) {
  const cur = state.current;
  switch (action) {
    case 'next': step(1); break;
    case 'prev': step(-1); break;
    case 'random': randomChannel(); break;
    case 'retry': if (cur) { cur.sources.forEach(s => state.failed.delete(s[0])); play(cur.ch, 0); } break;
    case 'stay': clearInterval(skipTimer); $('#overlayActions [data-action="stay"]')?.remove(); $('#overlayMsg small:last-child')?.remove(); break;
    case 'fav': if (cur) toggleFav(cur.ch.id); break;
    case 'close': closePlayer(); break;
    case 'pip':
      if (document.pictureInPictureElement) document.exitPictureInPicture();
      else video.requestPictureInPicture?.().catch(() => toast('Mini player not available for this stream'));
      break;
    case 'share': if (cur) copy(location.href, '🔗 Link copied'); break;
    case 'copy': if (cur) copy(cur.sources[cur.idx][0], 'Stream URL copied — open it in VLC: Media → Open Network Stream'); break;
  }
}

function bind() {
  document.addEventListener('click', e => {
    const fav = e.target.closest('[data-fav]');
    if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
    const card = e.target.closest('.card');
    if (card) { play(state.byId.get(card.dataset.id)); return; }
    const act = e.target.closest('[data-action]');
    if (act) { handleAction(act.dataset.action); return; }
    const src = e.target.closest('[data-src]');
    if (src) { play(state.current.ch, +src.dataset.src); return; }
    const rm = e.target.closest('[data-remove-pl]');
    if (rm) {
      state.playlists = state.playlists.filter(p => p.name !== rm.dataset.removePl);
      store.set('playlists', state.playlists);
      indexChannels(); renderPlaylists();
      if (state.view.type === 'playlist') setView({ type: 'all', value: '' }); else renderSidebar();
      return;
    }
    if (e.target.id === 'widenBtn') { $('#statusFilter').value = 'playable'; $('#statusFilter').dispatchEvent(new Event('change')); return; }
    const nav = e.target.closest('a[href^="#"]');
    if (nav) {
      e.preventDefault();
      setView(parseView(nav.getAttribute('href')));
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.classList?.contains('card')) { play(state.byId.get(e.target.dataset.id)); return; }
    const typing = /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || $('#settings').open;
    if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); return; }
    if (e.key === 'Escape') {
      if (document.activeElement === $('#search')) { $('#search').blur(); return; }
      if (document.body.classList.contains('menu-open')) { closeMenu(); return; }
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
    else if (k === 'f') document.fullscreenElement ? document.exitFullscreen() : $('#player').requestFullscreen?.();
    else if (k === 'm') { video.muted = !video.muted; osd(video.muted ? '🔇 Muted' : '🔊 Sound on'); }
    else if (k === 's') toggleFav(state.current.ch.id);
    else if (k === 'p') handleAction('pip');
  });
  video.addEventListener('click', () => { if (video.muted && !video.paused) { video.muted = false; osd('🔊 Sound on'); } });

  let searchTimer;
  $('#search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value.trim(); renderGrid(); }, 150);
  });
  $('#countryFilter').addEventListener('input', renderSidebar);
  $('#langFilter').addEventListener('change', e => { state.lang = e.target.value; renderGrid(); });
  $('#statusFilter').addEventListener('change', e => { state.status = e.target.value; store.set('status', state.status); renderSidebar(); renderGrid(); });
  $('#sortSel').addEventListener('change', e => { state.sort = e.target.value; store.set('sort', state.sort); renderGrid(); });
  $('#layoutBtn').addEventListener('click', () => { state.layout = state.layout === 'grid' ? 'list' : 'grid'; store.set('layout', state.layout); $('#grid').className = 'grid ' + state.layout; });
  $('#menuBtn').addEventListener('click', openMenu);
  $('#scrim').addEventListener('click', closeMenu);
  $('#randomBtn').addEventListener('click', randomChannel);
  $('#brandLink').addEventListener('click', e => { e.preventDefault(); $('#search').value = ''; state.query = ''; setView({ type: 'all', value: '' }); });
  $('#themeBtn').addEventListener('click', () => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const cur = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('wtv.theme', next); } catch {}
  });
  $('#settingsBtn').addEventListener('click', () => { renderPlaylists(); updateDataInfo(); $('#settings').showModal(); });

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
        // A single live stream rather than a channel list: play it directly.
        const ch = { id: 'url:' + url, n: url.split('/').slice(2, 3)[0] || 'Stream', c: '', g: [], l: '', la: [], w: '', s: [[url, '', 'unk', '', '']], _q: '' };
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
    } finally { btn.disabled = false; btn.textContent = 'Add from URL'; }
  });
  $('#m3uFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { toast(`Added ${addPlaylist(f.name.replace(/\.m3u8?$/i, ''), await f.text())} channels`); $('#settings').close(); }
    catch (err) { toast(err.message); }
    e.target.value = '';
  });
  $('#exportBtn').addEventListener('click', () => {
    const text = toM3U(state.list, state.catalog, ch => streamsFor(ch, 'all')[0]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'audio/x-mpegurl' }));
    a.download = (viewLabel(state.view).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'worldtv') + '.m3u';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#refreshBtn').addEventListener('click', refreshFromApi);
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Clear favorites, watch history and added playlists?')) return;
    state.favs.clear(); state.recent = []; state.playlists = [];
    ['favs', 'recent', 'playlists', 'last'].forEach(k => store.set(k, k === 'last' ? null : []));
    indexChannels(); renderSidebar(); renderGrid(); renderPlaylists();
    toast('Cleared');
  });

  new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && state.rendered < state.list.length) renderGrid(false);
  }, { rootMargin: '800px' }).observe($('#sentinel'));

  window.addEventListener('popstate', () => {
    const { view, ch } = readHash();
    state.view = view; renderSidebar(); renderGrid();
    if (ch && ch !== state.current?.ch.id && state.byId.get(ch)) play(state.byId.get(ch));
  });
}

function parseView(href) {
  const p = new URLSearchParams(href.replace(/^#/, ''));
  const v = p.get('v') || '';
  const i = v.indexOf(':');
  return v ? { type: i < 0 ? v : v.slice(0, i), value: i < 0 ? '' : v.slice(i + 1) } : { type: 'all', value: '' };
}

function updateDataInfo() {
  const c = state.catalog;
  const n = c.channels.length, s = c.channels.reduce((a, ch) => a + ch.s.length, 0);
  $('#dataInfo').textContent = `${n.toLocaleString()} channels, ${s.toLocaleString()} streams. Last updated ${new Date(c.updated).toLocaleDateString()}${c.checked ? ', with every stream checked' : ''}.`;
}

async function refreshFromApi() {
  const btn = $('#refreshBtn'), status = $('#refreshStatus');
  btn.disabled = true;
  try {
    status.textContent = 'Downloading the latest channel database (about 30 MB)…';
    const api = await fetchApi(fetch, (n, t) => { status.textContent = `Downloading… ${n}/${t}`; });
    const fresh = buildCatalog(api);
    // Keep what we already know about each stream's health.
    const known = new Map(state.catalog.channels.flatMap(ch => ch.s.map(s => [s[0], s[2]])));
    for (const ch of fresh.channels) for (const s of ch.s) if (known.has(s[0])) s[2] = known.get(s[0]);
    fresh.checked = state.catalog.checked;
    const added = fresh.channels.length - state.catalog.channels.length;
    state.catalog = fresh;
    await cacheCatalog(fresh);
    indexChannels(); fillLanguages(); renderSidebar(); renderGrid(); updateDataInfo();
    status.textContent = `Done. ${fresh.channels.length.toLocaleString()} channels (${added >= 0 ? '+' : ''}${added}). New streams are unchecked; pick “Likely playable” to see them.`;
  } catch (e) {
    status.textContent = 'Update failed: ' + e.message;
  } finally { btn.disabled = false; }
}

// Live updates are kept in the Cache API so they survive reloads.
async function cacheCatalog(cat) {
  try {
    const c = await caches.open('wtv-data');
    await c.put('catalog-live.json', new Response(JSON.stringify(cat), { headers: { 'content-type': 'application/json' } }));
  } catch {}
}
async function loadCatalog() {
  let bundled = null, live = null;
  try {
    const c = await caches.open('wtv-data');
    const r = await c.match('catalog-live.json');
    if (r) live = await r.json();
  } catch {}
  const res = await fetch('data/channels.json');
  if (!res.ok) throw new Error('Could not load channel list (HTTP ' + res.status + ')');
  bundled = await res.json();
  // Use the live copy only if it is newer than what ships with the app.
  return live && new Date(live.updated) > new Date(bundled.updated) ? live : bundled;
}

// ---------- start ----------
async function start() {
  $('#grid').innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading channels…</p></div>';
  try {
    state.catalog = await loadCatalog();
  } catch (e) {
    $('#grid').innerHTML = `<div class="empty"><div class="big">⚠️</div><p>${esc(e.message)}</p><p class="hint">If you opened index.html directly from disk, run a local web server instead (see README).</p></div>`;
    return;
  }
  if (!state.status) state.status = state.catalog.checked ? 'ok' : 'playable';
  $('#statusFilter').value = state.status;
  $('#sortSel').value = state.sort;
  indexChannels();
  fillLanguages();
  bind();
  const { view, ch } = readHash();
  state.view = view;
  renderSidebar();
  renderGrid();
  const target = ch ? state.byId.get(ch) : (state.settings.resume ? state.byId.get(store.get('last', '')) : null);
  if (target) play(target);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
