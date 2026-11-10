// Remote-control (D-pad) navigation for TVs.
// Arrow keys move focus to the nearest item in that direction, the way TV
// apps behave; OK (Enter) activates it.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select, [tabindex]:not([tabindex="-1"])';

function visible(el) {
  if (el.matches('[tabindex="-1"]') || el.closest('[hidden]') || el.closest('[inert]')) return false;
  // Buttons inside a channel card (the star) are skipped: OK on the card plays it.
  if (!el.classList.contains('card') && el.closest('.card')) return false;
  if (el.closest('.slide:not(.active)')) return false; // hidden hero slides
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
}

export function focusables(scope = document) {
  return [...scope.querySelectorAll(FOCUSABLE)].filter(visible);
}

const DIRS = {
  ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1],
};

/** Picks the best element to move to from `from` in direction `key`. */
export function nextInDirection(from, key, scope = document) {
  const [dx, dy] = DIRS[key];
  const a = from.getBoundingClientRect();
  let best = null, bestScore = Infinity;
  for (const el of focusables(scope)) {
    if (el === from || from.contains(el) || el.contains(from)) continue;
    const b = el.getBoundingClientRect();
    // Distance along the direction of travel (edge to edge), must be ahead of us.
    let main, cross;
    if (dx) {
      main = dx > 0 ? b.left - a.right : a.left - b.right;
      if ((dx > 0 ? b.left + b.width / 2 <= a.left + a.width / 2 : b.left + b.width / 2 >= a.left + a.width / 2)) continue;
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      cross = overlap > 0 ? 0 : Math.min(Math.abs(b.top - a.bottom), Math.abs(a.top - b.bottom));
    } else {
      main = dy > 0 ? b.top - a.bottom : a.top - b.bottom;
      if ((dy > 0 ? b.top + b.height / 2 <= a.top + a.height / 2 : b.top + b.height / 2 >= a.top + a.height / 2)) continue;
      const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      // Prefer the item most directly above/below; then left-most alignment.
      cross = overlap > 0 ? Math.abs(b.left - a.left) / 8 : Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right)) / 2 + 20;
    }
    const score = Math.max(main, -a.width / 2) + cross * (dx ? 3 : 2);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

export function focusEl(el, { center = false } = {}) {
  if (!el) return false;
  el.focus({ preventScroll: true });
  const r = el.getBoundingClientRect();
  const top = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--top')) || 60;
  // Keep the focused item comfortably on screen.
  if (center || r.top < top + 10 || r.bottom > innerHeight - 10) {
    el.scrollIntoView({ block: center ? 'center' : 'nearest', inline: 'nearest', behavior: 'smooth' });
    if (!center && r.top < top + 10) scrollBy({ top: -(top + 24), behavior: 'smooth' });
  } else {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
  return true;
}

/** Moves focus in a direction within `scope`; returns true if it moved. */
export function move(key, scope = document) {
  const cur = document.activeElement;
  const inScope = cur && cur !== document.body && scope.contains(cur) && visible(cur);
  if (!inScope) return focusFirst(scope);
  const next = nextInDirection(cur, key, scope);
  if (!next) return false;
  return focusEl(next, { center: key === 'ArrowDown' || key === 'ArrowUp' });
}

/** Focuses the first visible item, preferring ones already on screen. */
export function focusFirst(scope = document, preferred = null) {
  if (preferred && visible(preferred)) return focusEl(preferred);
  const list = focusables(scope);
  const onScreen = list.find(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  return focusEl(onScreen || list[0]);
}
