/* ================================================================
 * BSC Ops — settings.js
 * Core settings plumbing + locations management + topbar location
 * switcher. Slack / notification-rule UI lives in js/slack.js.
 *
 * getSetting / saveSetting are the canonical read/write for the
 * BSC_Settings list. Any value that needs to persist across devices
 * (Slack webhook, cog hidden IDs, paused flags, notification rules)
 * goes through these — localStorage is used as a per-device fallback
 * only.
 *
 * Locations are stored in localStorage ("bsc_locations") and default
 * to CFG.locations. getAllowedLocations() narrows by the current
 * staff member's LocationAccess field so a single-location employee
 * never sees other sites' data.
 *
 * Depends on:
 *   - state.js (cache, currentLocation, currentStaffMember)
 *   - auth.js (CFG)
 *   - constants.js (LISTS, INV_TYPE_CFG, INV_COG_CFG)
 *   - graph.js (getSiteId, addListItem, updateListItem,
 *     getListItems, getCountHistoryForList)
 *   - utils.js (escHtml, toast)
 *   - index.html globals resolved at call time:
 *     _cogsHiddenIds, _invCogState, _invType, foodParsListName,
 *     renderInventory, renderDashboard, renderFoodParsInTab,
 *     applyModulePermissions
 * ================================================================ */

// ── Core settings read / write (BSC_Settings list) ───────────────
function getSetting(key) {
  return cache.settingsItems.find(i => i.Title === key)?.Value || '';
}

async function saveSetting(key, value) {
  const siteId = await getSiteId();
  const existing = cache.settingsItems.find(i => i.Title === key);
  if (existing) {
    await updateListItem(LISTS.settings, existing.id, { Value: value });
    existing.Value = value;
  } else {
    const item = await addListItem(LISTS.settings, { Title: key, Value: value });
    cache.settingsItems.push(item);
  }
}

// Re-init all hidden-ID sets from SharePoint settings (falls back to
// localStorage). Called once after initial data load so hide state
// persists across devices/browsers.
function applyHiddenSettings() {
  const parse = str => { try { return JSON.parse(str); } catch { return []; } };
  // Menu COGs
  const cogsStr = getSetting('cogs_hidden') || localStorage.getItem('bsc_cogs_hidden');
  if (cogsStr) _cogsHiddenIds = new Set(parse(cogsStr));
  // Inventory COGs (merch / food / grocery)
  for (const [tabKey, cfg] of Object.entries(INV_COG_CFG)) {
    const str = getSetting(cfg.hiddenKey) || localStorage.getItem(cfg.hiddenKey);
    if (str) _invCogState[tabKey].hiddenIds = new Set(parse(str));
  }
}

// ── Locations ────────────────────────────────────────────────────
function getLocations() {
  try {
    const stored = localStorage.getItem('bsc_locations');
    return stored ? JSON.parse(stored) : [...CFG.locations];
  } catch { return [...CFG.locations]; }
}
function saveLocations(locs) {
  localStorage.setItem('bsc_locations', JSON.stringify(locs));
}
function getAllowedLocations(locs) {
  locs = locs || getLocations();
  if (!currentStaffMember) return locs; // unlinked → see everything
  const access = currentStaffMember.LocationAccess || 'All';
  if (!access || access.trim() === 'All') return locs;
  const allowed = access.split(',').map(l=>l.trim()).filter(Boolean);
  return locs.filter(l => allowed.includes(l));
}

function applyLocationAccess() {
  const allowed = getAllowedLocations();
  // Auto-select if user is restricted to exactly one location
  if (allowed.length === 1 && currentLocation !== allowed[0]) {
    currentLocation = allowed[0];
  }
  renderLocations();
  applyModulePermissions();
}

function renderLocations() {
  const locs = getLocations();
  // Settings card list
  const el = document.getElementById('locations-list');
  if (el) {
    el.innerHTML = locs.map(l=>`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--opal);font-size:13px;">
        <span>${escHtml(l)}</span>
        <button data-loc="${escHtml(l)}" onclick="removeLocation(this.dataset.loc)" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px;padding:0 4px;line-height:1;" title="Remove">×</button>
      </div>`).join('');
  }
  // Topbar location buttons — use active state from currentLocation, filter by access
  const allowed = getAllowedLocations(locs);
  const showAll = allowed.length > 1;
  const btnsHTML =
    (showAll ? `<button class="loc-btn${currentLocation==='all'?' active':''}" onclick="setLocation('all',this)">All</button>` : '')
    + allowed.map(l=>`<button class="loc-btn${currentLocation===l?' active':''}" data-loc="${escHtml(l)}" onclick="setLocation(this.dataset.loc,this)">${escHtml(l)}</button>`).join('');
  const switcher = document.getElementById('loc-switcher');
  if (switcher) switcher.innerHTML = btnsHTML;
  const switcherMobile = document.getElementById('loc-switcher-mobile');
  if (switcherMobile) switcherMobile.innerHTML = btnsHTML;
}

function addLocation() {
  const input = document.getElementById('new-location-input');
  const name = input.value.trim();
  if (!name) { toast('err','Enter a location name'); return; }
  const locs = getLocations();
  if (locs.includes(name)) { toast('err','Location already exists'); return; }
  locs.push(name);
  saveLocations(locs);
  input.value = '';
  renderLocations();
  toast('ok',`✓ ${name} added`);
}

function removeLocation(name) {
  if (!confirm(`Remove "${name}" from locations?`)) return;
  const locs = getLocations().filter(l=>l!==name);
  saveLocations(locs);
  renderLocations();
  toast('ok',`✓ ${name} removed`);
}

// ── Topbar location switcher ────────────────────────────────────
// Reloads all count histories and food-pars for the new scope, then
// re-renders inventory and dashboard. Called on button click.
async function setLocation(loc, btn) {
  currentLocation = loc;
  renderLocations();
  // Clear all count caches
  cache.countHistory = [];
  cache.merchCountHistory = [];
  cache.equipCountHistory = [];
  renderInventory();
  renderDashboard();
  if (typeof renderChecklists === 'function') renderChecklists();
  try {
    const siteId = await getSiteId();
    const locs = getLocations();
    // Reload counts for all inventory types
    for (const [, cfg] of Object.entries(INV_TYPE_CFG)) {
      if (loc === 'all') {
        const arrays = await Promise.all(
          locs.map(l => {
            const cn = cfg.countsPrefix.replace('{loc}', l.replace(/[\s\/\\]/g, '_'));
            return getCountHistoryForList(siteId, cn).catch(() => []);
          })
        );
        cache[cfg.countKey] = arrays.flat();
      } else {
        const cn = cfg.countsPrefix.replace('{loc}', loc.replace(/[\s\/\\]/g, '_'));
        cache[cfg.countKey] = await getCountHistoryForList(siteId, cn).catch(() => []);
      }
    }
    // Reload food pars master + per-location par values
    cache.foodPars = await getListItems(siteId, LISTS.foodPars).catch(() => []);
    if (loc === 'all') {
      const fpArrays = await Promise.all(
        locs.map(l => {
          const ln = foodParsListName(l);
          return ln ? getListItems(siteId, ln).catch(() => []) : Promise.resolve([]);
        })
      );
      cache.foodParValues = fpArrays.flat();
    } else {
      const fpLn = foodParsListName(loc);
      cache.foodParValues = fpLn ? await getListItems(siteId, fpLn).catch(() => []) : [];
    }
  } catch(e) { console.warn('Counts reload failed:', e); }
  renderInventory();
  renderDashboard();
  if (typeof renderChecklists === 'function') renderChecklists();
  // Re-render food pars if that panel is currently visible
  if (document.getElementById('inv-tab-foodpars')?.style.display !== 'none' && _invType) {
    renderFoodParsInTab(_invType);
  }
}
