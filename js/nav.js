/* ================================================================
 * BSC Ops — nav.js
 * Page switching + mobile drawer.
 *
 * nav(page) is the single entry point — it hides all .page elements,
 * shows #page-{page}, activates the matching sidebar item, then calls
 * the per-page render function for the pages that need one.
 *
 * Depends on:
 *   - constants.js (PAGE_MODULE)
 *   - utils.js (toast)
 *   - state.js (currentUser — indirectly via isOwner/userCanAccess)
 *   - permissions helpers still in index.html (isOwner, userCanAccess)
 *   - various render* fns still in index.html (renderChecklists,
 *     renderMaintSchedule, renderRoles, renderLocations,
 *     renderSlackSettings, renderSquareSettings, renderTagsSettings,
 *     initColMgr, renderSquarePage, renderMenu, renderCogs,
 *     renderParking, renderPrepItems) — resolved at call time, so
 *     extraction order doesn't matter as long as all are in the
 *     global scope by the time nav() fires
 * ================================================================ */

// ── Mobile drawer toggle ─────────────────────────────────────────
function toggleNav(){
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('nav-backdrop');
  const open = sb.classList.toggle('open');
  bd.classList.toggle('show', open);
}
function closeNav(){
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('nav-backdrop')?.classList.remove('show');
}

// ── Page switch ──────────────────────────────────────────────────
// Closes the drawer first, runs a page-level access check, then shows
// the target page and invokes its render function.
function nav(page) {
  closeNav();
  // Legacy redirect — Contacts used to be a top-level page; it now lives as a
  // tab under Maintenance. Reroute deep links / stale bookmarks and auto-select
  // the Contacts tab after the page renders.
  if (page === 'maint-contacts') {
    nav('maint-schedule');
    setTimeout(() => { if (typeof switchMaintTab === 'function') switchMaintTab('contacts', null); }, 0);
    return;
  }
  // Page-level access check — blocks direct navigation even if nav item is hidden
  const module = PAGE_MODULE[page];
  if (module && !userCanAccess(module)) {
    toast('err', 'You don\'t have access to that page');
    nav('dashboard');
    return;
  }

  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+page)?.classList.add('active');
  document.querySelector(`.nav-item[data-module="${module}"]`)?.classList.add('active');
  // Arriving on a page wipes its search box + filter dropdowns so the user
  // always lands on a clean, unfiltered view. For pages with no auto-render
  // in the dispatch below, _resetPageFilters also triggers a fresh render
  // to flush any stale filtered DOM from the last visit.
  _resetPageFilters(page);
  if (page==='checklists')    renderChecklists();
  if (page==='maint-schedule') renderMaintSchedule();
  if (page==='settings') {
    const denied = !isOwner();
    document.getElementById('settings-access-denied').style.display = denied ? '' : 'none';
    document.getElementById('settings-body').style.display = denied ? 'none' : '';
    if (!denied) { renderRoles(); renderLocations(); renderSlackSettings(); renderTagsSettings(); initColMgr(); if (typeof renderCoffeeBagSettings === 'function') renderCoffeeBagSettings(); if (typeof renderClockInAlertSettings === 'function') renderClockInAlertSettings(); if (typeof renderAutoSendOrdersCard === 'function') renderAutoSendOrdersCard(); if (typeof renderOrderEmailTemplateCard === 'function') renderOrderEmailTemplateCard(); }
  }
  if (page==='square') {
    renderSquarePage();
    if (typeof renderSquareSettings === 'function') renderSquareSettings();
    if (typeof renderAutoSyncCard   === 'function') renderAutoSyncCard();
  }
  if (page==='menu')        renderMenu();
  if (page==='cogs')        renderCogs();
  if (page==='parking')     renderParking();
  if (page==='prep-items')  renderPrepItems();
  if (page==='market-analysis' && typeof renderMarketAnalysis === 'function') renderMarketAnalysis();
  if (page==='projects' && typeof renderProjects === 'function') renderProjects();
}

// ── Per-page filter reset ───────────────────────────────────────
// Clears the search box + filter dropdowns + checkbox toggles for the page
// we're arriving at. Safe to call before deps are ready (null-guards on
// every element). For pages whose render fn isn't already invoked in
// nav()'s dispatch block above (inventory, ordering, vendors, maint-
// contacts, staff, recipes), we also re-render so the table/grid reflects
// the cleared inputs instead of showing stale filtered rows.
function _resetPageFilters(page) {
  const byId = id => document.getElementById(id);
  const qs   = sel => document.querySelector(sel);
  const clearInp = el => { if (el) el.value = ''; };
  const clearChk = el => { if (el) el.checked = false; };
  switch (page) {
    case 'inventory':
      clearInp(byId('inv-search-input'));
      clearInp(byId('inv-cat-filter'));
      clearInp(byId('inv-status-filter'));
      clearInp(byId('inv-supplier-filter'));
      clearChk(byId('inv-show-archived'));
      if (typeof renderInventory === 'function') renderInventory();
      break;
    case 'ordering':
      clearInp(qs('#page-ordering .search-input'));
      clearInp(byId('order-status-filter'));
      if (typeof renderOrders === 'function') renderOrders();
      break;
    case 'vendors':
      clearInp(qs('#page-vendors .search-input'));
      clearInp(byId('vendor-tag-filter'));
      if (typeof renderVendors === 'function') renderVendors();
      break;
    case 'staff':
      clearInp(qs('#page-staff .search-input'));
      if (typeof filterStaff === 'function') filterStaff('');
      break;
    case 'recipes':
      clearInp(byId('recipe-search'));
      if (typeof filterRecipes === 'function') filterRecipes('');
      break;
    case 'checklists':
      clearInp(byId('cl-role-filter'));
      break; // renderChecklists is already called by nav(); location comes from top-bar currentLocation
    case 'menu':
      clearInp(byId('menu-search'));
      clearInp(byId('menu-cat-filter'));
      clearChk(byId('menu-show-hidden'));
      break; // renderMenu is already called by nav()
    case 'cogs':
      clearInp(byId('cogs-overview-sort'));
      clearInp(byId('cogs-overview-type'));
      clearInp(byId('cogs-search'));
      clearInp(byId('merch-cogs-search'));
      clearInp(byId('food-cogs-search'));
      clearInp(byId('grocery-cogs-search'));
      break; // renderCogs is already called by nav()
    case 'maint-schedule':
      clearInp(qs('#maint-schedule-panel .search-input'));
      clearInp(byId('maint-filter-loc'));
      clearInp(byId('maint-filter-equip'));
      clearInp(byId('maint-filter-status'));
      clearInp(byId('maint-log-filter-equip'));
      clearInp(qs('#maint-contacts-panel .search-input'));
      break; // renderMaintSchedule is already called by nav()
    case 'parking':
      clearInp(qs('#page-parking .search-input'));
      clearInp(byId('parking-status-filter'));
      clearInp(byId('parking-loc-filter'));
      break; // renderParking is already called by nav()
    case 'projects':
      clearInp(byId('proj-search'));
      clearInp(byId('proj-owner-filter'));
      clearInp(byId('proj-loc-filter'));
      clearInp(byId('proj-tag-filter'));
      clearChk(byId('proj-show-archived'));
      // Reset to grid view (in case user was on a detail page)
      if (typeof exitProjectDetail === 'function') exitProjectDetail();
      break;
  }
}

// ── Offline detection (PR 14a) ──────────────────────────────────
// Browser online/offline events flip:
//   - the topbar .sync-pill (cream "Connected" → red pulse "Offline · 2m ago")
//   - the per-page .offline-banner on Inventory + Checklists
// Last-online timestamp persists in localStorage so the relative time
// survives reloads and reflects the true time-since-online window.
const _SYNC_LAST_ONLINE_KEY = 'bsc_last_online_at';

function _markOnlineNow() {
  try { localStorage.setItem(_SYNC_LAST_ONLINE_KEY, String(Date.now())); } catch {}
}

function _relativeTimeSince(ts) {
  if (!ts) return '';
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function applyOfflineState() {
  const online = navigator.onLine;
  const pill = document.getElementById('sync-pill');
  const label = document.getElementById('sync-label');
  const banners = [
    { banner: document.getElementById('inv-offline-banner'), meta: document.getElementById('inv-offline-meta') },
    { banner: document.getElementById('cl-offline-banner'),  meta: document.getElementById('cl-offline-meta') }
  ];

  if (online) {
    _markOnlineNow();
    if (pill) pill.classList.remove('offline');
    // Don't override the auto-sync.js "🔄 Auto-syncing…" status mid-run.
    if (label && !label.textContent.startsWith('🔄')) label.textContent = 'Connected';
    banners.forEach(b => {
      if (b.banner) b.banner.classList.remove('show');
      if (b.meta) b.meta.textContent = '';
    });
    return;
  }

  // Offline.
  let lastTs = 0;
  try { lastTs = parseInt(localStorage.getItem(_SYNC_LAST_ONLINE_KEY) || '0', 10); } catch {}
  const rel = lastTs ? _relativeTimeSince(lastTs) : '';
  if (pill) pill.classList.add('offline');
  if (label) label.textContent = rel ? `Offline · ${rel}` : 'Offline';
  banners.forEach(b => {
    if (b.banner) b.banner.classList.add('show');
    if (b.meta) b.meta.textContent = rel ? `Last synced ${rel}` : '';
  });
}

window.addEventListener('online',  applyOfflineState);
window.addEventListener('offline', applyOfflineState);
// Initial paint + a 30 s tick so the relative timestamp keeps updating
// while offline ("Offline · 2m ago" → "Offline · 3m ago" without reload).
window.addEventListener('DOMContentLoaded', () => {
  if (navigator.onLine) _markOnlineNow();
  applyOfflineState();
  setInterval(() => { if (!navigator.onLine) applyOfflineState(); }, 30_000);
});
