// Remote-control (D-pad) navigation for TVs.
// Arrow keys move focus to the nearest item in that direction, the way TV
// apps behave; OK (Enter) activates it. Written to stay fast on slow TV chips:
// no style recalculation per item, instant scrolling, and a steady focus row.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select, [tabindex]:not([tabindex="-1"])';
// Things the remote should skip: the star inside cards (OK on a card plays it),
// the tiny hero dots, header "See all" links (rows end with a See all tile),
// and anything on a hidden hero slide.
const SKIP = '[tabindex="-1"], .card button, .dot-btn, .see-all, .slide:not(.active) *';

let last = null;
document.addEventListener('focusin', e => { if (e.target instanceof Element && e.target !== document.body) last = e.target; });

function usable(el) {
  if (!el || !el.isConnected || el === document.body) return false;
  if (el.matches(SKIP) || el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}

export function focusables(scope = document) {
  const out = [];
  for (const el of scope.querySelectorAll(FOCUSABLE)) {
    if (el.matches(SKIP) || el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 2 && r.height > 2) out.push([el, r]);
  }
  return out;
}

/** Picks the best element to move to from `from` in direction `key`. */
export function nextInDirection(from, key, scope = document) {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const sign = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
  let best = null, bestScore = Infinity;
  for (const [el, b] of focusables(scope)) {
    if (el === from || from.contains(el) || el.contains(from)) continue;
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    let main, cross;
    if (horizontal) {
      if ((bx - ax) * sign <= 1) continue;
      // Left/right stays on the same row: never jump to another row.
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlap < Math.min(a.height, b.height) * 0.3) continue;
      main = sign > 0 ? b.left - a.right : a.left - b.right;
      cross = Math.abs(by - ay);
    } else {
      if ((by - ay) * sign <= 1) continue;
      main = sign > 0 ? b.top - a.bottom : a.top - b.bottom;
      const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      cross = overlap > 0 ? Math.abs(b.left - a.left) / 6 : Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right)) / 2 + 24;
    }
    const score = Math.max(main, -20) + cross * 2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

function topInset() {
  const bar = document.querySelector('.topbar');
  return bar ? bar.getBoundingClientRect().bottom : 0;
}

/** Focuses `el` and scrolls instantly so it sits in a steady, comfortable spot. */
export function focusEl(el) {
  if (!el) return false;
  el.focus({ preventScroll: true });
  if (el.closest('.topbar')) return true;

  // Rows that scroll sideways: keep the item inside with a margin.
  const rail = el.closest('.rail');
  if (rail) {
    const r = el.getBoundingClientRect(), rr = rail.getBoundingClientRect();
    const pad = Math.min(60, rr.width * 0.08);
    if (r.left < rr.left + pad) rail.scrollLeft -= rr.left + pad - r.left;
    else if (r.right > rr.right - pad) rail.scrollLeft += r.right - (rr.right - pad);
  }

  // Lists inside panels (channel list, settings, now-playing panel).
  const box = el.closest('.dr-list, .modal, .now');
  if (box) {
    const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
    if (r.top < br.top + 8) box.scrollTop -= br.top + 8 - r.top;
    else if (r.bottom > br.bottom - 8) box.scrollTop += r.bottom - (br.bottom - 8);
    return true;
  }

  // The page: keep the focused row about a third of the way down the screen.
  const r = el.getBoundingClientRect();
  const top = topInset();
  if (r.top < top + 16 || r.bottom > innerHeight - 24) {
    const target = scrollY + r.top - (top + (innerHeight - top) * 0.3);
    scrollTo(0, Math.max(0, target));
  }
  return true;
}

/** Moves focus in a direction within `scope`; returns true if it moved. */
export function move(key, scope = document) {
  let from = document.activeElement;
  if (!usable(from) || !scope.contains(from)) {
    // Focus was lost (e.g. the page re-drew): continue from the last item if
    // it is still there, otherwise start from what is on screen.
    if (usable(last) && scope.contains(last)) { focusEl(last); from = last; }
    else return focusFirst(scope);
  }
  const next = nextInDirection(from, key, scope);
  if (!next) return false;
  return focusEl(next);
}

/** Focuses `preferred` if usable, else the first item on screen in `scope`. */
export function focusFirst(scope = document, preferred = null) {
  if (usable(preferred)) return focusEl(preferred);
  // On the whole document, prefer the page content over the top bar.
  if (scope === document) {
    const main = document.querySelector('#playerWrap:not([hidden])') ? document.querySelector('main') : document.querySelector('#page');
    if (main && focusFirst(main)) return true;
  }
  const list = focusables(scope);
  const top = scope === document ? topInset() : 0;
  const onScreen = list.find(([, r]) => r.top >= top && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth);
  const pick = (onScreen || list[0])?.[0];
  return pick ? focusEl(pick) : false;
}
