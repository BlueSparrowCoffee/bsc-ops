/* ================================================================
 * BSC Ops — utils.js
 * Pure DOM/string helpers. No app-state dependencies.
 * Loaded as a classic <script src="...">, so every declaration is a global.
 * Depends on: SEARCH_DEBOUNCE_MS (from constants.js).
 * ================================================================ */

// ── HTML escaping ─────────────────────────────────────────────────
// Always run user-supplied strings through escHtml() before inserting
// into innerHTML. Non-negotiable: prevents XSS.
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Toast notifications ──────────────────────────────────────────
// toast('ok', '✓ Saved') or toast('err', 'Something broke')
// Reuses two fixed #toast-ok / #toast-err elements in index.html.
const toastT = {};
function toast(type, msg = '✓ Saved') {
  const el = document.getElementById('toast-' + type);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT[type]);
  toastT[type] = setTimeout(() => el.classList.remove('show'), type === 'err' ? 5000 : 2500);
}

// ── Full-screen loading overlay ──────────────────────────────────
// Toggles #loading.show AND locks body scroll (body.is-loading) so nothing
// can render on top of the overlay via Safari's sticky-under-fixed bug.
// Resets --load-progress to 0 (fully opaque bg) on every show; bootstrapApp
// repopulates it via setLoadingTotal/bumpLoadingProgress as fetches resolve.
function setLoading(on, msg = '') {
  document.getElementById('loading').classList.toggle('show', on);
  document.body.classList.toggle('is-loading', on);
  if (on) {
    _loadingTotal = 0;
    _loadingDone  = 0;
    document.documentElement.style.setProperty('--load-progress', '0');
  }
  if (msg) {
    document.getElementById('loading-msg').textContent = msg;
    // Splash overlay (when present) is on top of #loading and hides its own
    // message — keep its label in sync so users see real progress text.
    const sp = document.getElementById('splash-msg');
    if (sp) sp.textContent = msg;
  }
}

// ── Loading-screen progress fade ─────────────────────────────────
// Drives `--load-progress` (0→1) on <html>; CSS turns that into the
// rgba alpha of #loading / #splash backgrounds. Call setLoadingTotal(N)
// before kicking off N tracked promises, then bumpLoadingProgress() as
// each resolves (or use trackLoad(promise) to wire it in one step).
let _loadingTotal = 0;
let _loadingDone  = 0;
function setLoadingTotal(n) {
  _loadingTotal = Math.max(0, n | 0);
  _loadingDone  = 0;
  document.documentElement.style.setProperty('--load-progress', '0');
}
function bumpLoadingProgress() {
  if (!_loadingTotal) return;
  _loadingDone++;
  const p = Math.min(1, _loadingDone / _loadingTotal);
  document.documentElement.style.setProperty('--load-progress', String(p));
}
function trackLoad(promise) {
  return Promise.resolve(promise).finally(bumpLoadingProgress);
}

// ── Per-key input debounce (search/filter) ───────────────────────
// Call like: debounceFilter('inv-search', filterInventory, value)
// Coalesces repeated calls with the same key.
const _dfTimers = {};
function debounceFilter(key, fn, ...args) {
  clearTimeout(_dfTimers[key]);
  _dfTimers[key] = setTimeout(() => fn(...args), SEARCH_DEBOUNCE_MS);
}

// ── Modal-overlay click-to-dismiss (DISABLED) ────────────────────
// Backdrop clicks no longer close modals — accidental taps while
// editing a card kept wiping unsaved changes. Users must hit Save,
// Cancel, or the ✕ button explicitly. Escape still works.
