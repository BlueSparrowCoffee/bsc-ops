/* ================================================================
 * BSC Ops — nav.js
 * Page switching, back-stack, mobile drawer.
 *
 * nav(page) is the single entry point — it hides all .page elements,
 * shows #page-{page}, activates the matching sidebar item, then calls
 * the per-page render function for the pages that need one.
 *
 * The back-stack caps at 20 entries; _navSkipHistory lets navBack()
 * avoid pushing the from-page while it's walking backward.
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

// ── Back-stack state ─────────────────────────────────────────────
const _navHistory = [];
let _navCurrent = null;
let _navSkipHistory = false;

function navBack() {
  if (!_navHistory.length) return;
  const prev = _navHistory.pop();
  _navCurrent = prev;
  _navSkipHistory = true;
  nav(prev);
  _navSkipHistory = false;
  document.getElementById('back-btn').style.display = _navHistory.length ? '' : 'none';
}

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
// Closes the drawer first, runs a page-level access check, pushes
// the old page onto the back-stack (unless _navSkipHistory is set),
// then shows the target page and invokes its render function.
function nav(page) {
  closeNav();
  // Page-level access check — blocks direct navigation even if nav item is hidden
  const module = PAGE_MODULE[page];
  if (module && !userCanAccess(module)) {
    toast('err', 'You don\'t have access to that page');
    nav('dashboard');
    return;
  }

  if (!_navSkipHistory && _navCurrent && _navCurrent !== page) {
    _navHistory.push(_navCurrent);
    if (_navHistory.length > 20) _navHistory.shift();
  }
  _navCurrent = page;
  const backBtn = document.getElementById('back-btn');
  if (backBtn) backBtn.style.display = _navHistory.length ? '' : 'none';

  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+page)?.classList.add('active');
  document.querySelector(`.nav-item[data-module="${module}"]`)?.classList.add('active');
  if (page==='checklists')    renderChecklists();
  if (page==='maint-schedule') renderMaintSchedule();
  if (page==='settings') {
    const denied = !isOwner();
    document.getElementById('settings-access-denied').style.display = denied ? '' : 'none';
    document.getElementById('settings-body').style.display = denied ? 'none' : '';
    if (!denied) { renderRoles(); renderLocations(); renderSlackSettings(); renderSquareSettings(); renderTagsSettings(); initColMgr(); }
  }
  if (page==='square')      renderSquarePage();
  if (page==='menu')        renderMenu();
  if (page==='cogs')        renderCogs();
  if (page==='parking')     renderParking();
  if (page==='prep-items')  renderPrepItems();
}
