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
function setLoading(on, msg = '') {
  document.getElementById('loading').classList.toggle('show', on);
  if (msg) document.getElementById('loading-msg').textContent = msg;
}

// ── Per-key input debounce (search/filter) ───────────────────────
// Call like: debounceFilter('inv-search', filterInventory, value)
// Coalesces repeated calls with the same key.
const _dfTimers = {};
function debounceFilter(key, fn, ...args) {
  clearTimeout(_dfTimers[key]);
  _dfTimers[key] = setTimeout(() => fn(...args), SEARCH_DEBOUNCE_MS);
}

// ── Modal-overlay click-to-dismiss ───────────────────────────────
// Any element with .modal-overlay closes when the user clicks the
// dimmed backdrop (but not when clicking inside the modal body).
// Runs at script load — index.html script tags sit after the markup,
// so all overlays already exist in the DOM.
document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', e => {
    if (e.target === el) el.classList.remove('show');
  });
});
