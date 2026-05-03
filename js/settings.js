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
  // Merch inventory table hide state — distinct from COG hide
  if (typeof _merchInvHidden !== 'undefined') {
    const merchInvStr = getSetting('bsc_merch_inv_hidden') || localStorage.getItem('bsc_merch_inv_hidden');
    if (merchInvStr) _merchInvHidden = new Set(parse(merchInvStr));
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
    el.innerHTML = locs.map(l => {
      const addr = (typeof getSetting === 'function' ? getSetting('location_address_' + l) : '') || '';
      return `
      <div style="padding:10px 0;border-bottom:1px solid var(--opal);">
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:13px;margin-bottom:6px;">
          <span style="font-weight:600;">${escHtml(l)}</span>
          <button data-loc="${escHtml(l)}" onclick="removeLocation(this.dataset.loc)" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px;padding:0 4px;line-height:1;" title="Remove">×</button>
        </div>
        <textarea data-loc="${escHtml(l)}" placeholder="Address (used in order emails as {location_address})" rows="2"
          style="width:100%;font-size:12px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-family:inherit;resize:vertical;"
          onblur="saveLocationAddress(this.dataset.loc, this.value)">${escHtml(addr)}</textarea>
      </div>`;
    }).join('');
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

// Per-location address used by the order email template's {location_address}
// token. Stored in BSC_Settings under `location_address_<Name>` so it
// syncs across devices. Saved on blur from the Locations card; only
// writes when the value actually changed.
async function saveLocationAddress(name, value) {
  if (!name) return;
  const key = 'location_address_' + name;
  const next = (value || '').trim();
  const prev = (getSetting(key) || '').trim();
  if (next === prev) return;
  try {
    await saveSetting(key, next);
    toast('ok', next ? `✓ Address saved for ${name}` : `✓ Address cleared for ${name}`);
    if (typeof renderOrderEmailPreview === 'function') renderOrderEmailPreview();
  } catch (e) {
    toast('err', 'Save failed: ' + e.message);
  }
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
  // Show section-scoped loading bars on all .section-load-target elements
  // visible on the active page. Cleared in finally below.
  const _hideBars = (typeof showActivePageSectionLoading === 'function') ? showActivePageSectionLoading() : (() => {});
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
    // Reload coffee-bag labels (per-location lists, tagged with _loc)
    if (typeof loadLabelsForLocation === 'function') {
      await loadLabelsForLocation().catch(e => console.warn('Labels reload failed:', e));
    }
    // Reload retail bag inventory (per-location lists, tagged with _loc)
    if (typeof loadRetailBagsForLocation === 'function') {
      await loadRetailBagsForLocation().catch(e => console.warn('Retail bags reload failed:', e));
    }
    // Reload 5 LB bag labels (per-location lists, tagged with _loc)
    if (typeof loadFiveLbLabelsForLocation === 'function') {
      await loadFiveLbLabelsForLocation().catch(e => console.warn('5LB labels reload failed:', e));
    }
  } catch(e) { console.warn('Counts reload failed:', e); }
  finally { _hideBars(); }
  renderInventory();
  renderDashboard();
  if (typeof renderChecklists === 'function') renderChecklists();
  // Re-render food pars if that panel is currently visible
  if (document.getElementById('inv-tab-foodpars')?.style.display !== 'none' && _invType) {
    renderFoodParsInTab(_invType);
  }
  // Re-render Coffee Bags page (retail bags + 12oz labels + 5LB labels sections live here)
  if (document.getElementById('inv-tab-labels')?.style.display !== 'none') {
    if (typeof renderRetailBagsPage === 'function') renderRetailBagsPage();
    if (typeof renderLabelsPage === 'function') renderLabelsPage();
    if (typeof renderFiveLbLabelsPage === 'function') renderFiveLbLabelsPage();
    if (typeof syncRetailBagsSold === 'function') syncRetailBagsSold();
    if (typeof syncLabelsBagsSold === 'function') syncLabelsBagsSold();
  }
}

// ── Coffee Bags Settings card ────────────────────────────────────
// Two number inputs (label waste %, retail bag waste %) saved to BSC_Settings.
// Both rates are read at sync/reconcile time, so changes apply immediately.
function renderCoffeeBagSettings() {
  const labelInput  = document.getElementById('label-waste-pct-input');
  const bagInput    = document.getElementById('retail-bag-waste-pct-input');
  if (!labelInput || !bagInput) return;
  const labelPct = getSetting('bsc_label_waste_pct');
  const bagPct   = getSetting('bsc_retail_bag_waste_pct');
  labelInput.value = labelPct !== '' ? labelPct : DEFAULT_LABEL_WASTE_PCT;
  bagInput.value   = bagPct   !== '' ? bagPct   : DEFAULT_RETAIL_BAG_WASTE_PCT;
}

async function saveLabelWastePct() {
  const v = parseFloat(document.getElementById('label-waste-pct-input').value);
  if (isNaN(v) || v < 0 || v > 100) { toast('err','Enter a number between 0 and 100'); return; }
  await saveSetting('bsc_label_waste_pct', String(v));
  toast('ok',`✓ Label waste saved (${v}%)`);
}

async function saveRetailBagWastePct() {
  const v = parseFloat(document.getElementById('retail-bag-waste-pct-input').value);
  if (isNaN(v) || v < 0 || v > 100) { toast('err','Enter a number between 0 and 100'); return; }
  await saveSetting('bsc_retail_bag_waste_pct', String(v));
  toast('ok',`✓ Retail bag waste saved (${v}%)`);
}

// Jumps from any "Adjusted" column header to the Coffee Bags settings card,
// scrolling it into view and focusing the relevant waste-% input.
function navToCoffeeBagSettings(focusInputId) {
  if (typeof nav === 'function') nav('settings');
  setTimeout(() => {
    const card = document.getElementById('settings-coffee-bags');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (focusInputId) {
      const input = document.getElementById(focusInputId);
      if (input) { input.focus(); input.select?.(); }
    }
  }, 150);
}

// ── Morning Clock-In Alert recipients ────────────────────────────
// Per-location list of staff emails to DM via Slack when no one
// clocks in by 6:20 AM Mountain. Stored in BSC_Settings as JSON
// keyed by BSC location name.
function getClockInAlertRecipients() {
  try {
    const raw = getSetting('clock_in_alert_recipients');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function _eligibleClockInManagers() {
  // Staff with role containing "manager" or "owner" (owners are often the
  // backstop). Filter out inactive. Sort by name.
  return (cache.staff || [])
    .filter(s => {
      if (s.Active === 'No') return false;
      const r = (s.Role || '').toLowerCase();
      return r.includes('manager') || r.includes('owner') || r.includes('admin');
    })
    .filter(s => s.Email)
    .sort((a, b) => (a.Title || '').localeCompare(b.Title || ''));
}

function renderClockInAlertSettings() {
  const wrap = document.getElementById('clock-in-alert-recipients-list');
  if (!wrap) return;
  const locs = getLocations();
  const recipients = getClockInAlertRecipients();
  const managers = _eligibleClockInManagers();

  if (!managers.length) {
    wrap.innerHTML = `<div class="no-data" style="padding:12px;font-size:13px;">
      No staff with a manager/owner role found. Add or update a staff member's role to "Manager" first.
    </div>`;
    return;
  }

  wrap.innerHTML = locs.map(loc => {
    const selected = new Set((recipients[loc] || []).map(e => e.toLowerCase()));
    const checkboxes = managers.map(m => {
      const checked = selected.has((m.Email || '').toLowerCase()) ? 'checked' : '';
      return `<label style="display:flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--border);border-radius:14px;font-size:12px;cursor:pointer;background:#fff;">
        <input type="checkbox" data-loc="${escHtml(loc)}" data-email="${escHtml(m.Email || '')}" ${checked} style="margin:0;">
        <span>${escHtml(m.Title || m.Email)}</span>
      </label>`;
    }).join('');
    return `
      <div style="padding:12px 14px;background:var(--cream);border-radius:10px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:8px;">${escHtml(loc)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">${checkboxes}</div>
      </div>`;
  }).join('');
  const status = document.getElementById('clock-in-alert-status');
  if (status) status.textContent = '';
}

async function saveClockInAlertRecipients() {
  const wrap = document.getElementById('clock-in-alert-recipients-list');
  const status = document.getElementById('clock-in-alert-status');
  if (!wrap) return;
  const recipients = {};
  wrap.querySelectorAll('input[type="checkbox"][data-loc]').forEach(cb => {
    if (!cb.checked) return;
    const loc = cb.dataset.loc;
    const email = cb.dataset.email;
    if (!loc || !email) return;
    (recipients[loc] = recipients[loc] || []).push(email);
  });
  try {
    if (status) status.textContent = 'Saving…';
    await saveSetting('clock_in_alert_recipients', JSON.stringify(recipients));
    if (status) status.textContent = '✓ Saved';
    toast('ok', '✓ Clock-in alert recipients saved');
  } catch (e) {
    if (status) { status.textContent = '✗ Save failed: ' + e.message; status.style.color = 'var(--red)'; }
    toast('err', 'Save failed: ' + e.message);
  }
}

// ── Auto-Send Orders by Email ────────────────────────────────────
// Owner toggle: when enabled, the Build Order Send action calls
// Microsoft Graph /me/sendMail directly (no mailto: client) for vendors
// whose OrderMethod is "Email". OFF by default — current mailto behavior
// remains the safe default. Read by sendOrderToVendor in ordering-build.js.
function renderAutoSendOrdersCard() {
  const container = document.getElementById('auto-send-orders-card-body');
  if (!container) return;
  const enabled   = getSetting('auto_send_orders_enabled') === '1';
  const ownerOnly = !isOwner();
  container.innerHTML = `
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px;">
      When enabled, Build Order's Send action emails the vendor directly from your mailbox via Microsoft 365 — no mail client opens, no extra click. Sent items are saved to your Outlook Sent folder. Only applies to vendors with OrderMethod = Email; everything else still uses the existing flow.
    </p>
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500;margin-bottom:12px;${ownerOnly?'opacity:.5;cursor:not-allowed;':'cursor:pointer;'}">
      <input type="checkbox" id="auto-send-orders-enabled" ${enabled?'checked':''} ${ownerOnly?'disabled':''} onchange="toggleAutoSendOrders(this.checked)">
      Auto-send orders by email
    </label>
    <div style="font-size:11px;color:var(--muted);">
      First time you Send an order with this on, your browser may prompt for one-time consent to the <code>Mail.Send</code> permission. Each user has to consent on their own device.
    </div>
    ${ownerOnly ? '<div style="font-size:11px;color:var(--muted);margin-top:10px;">Owner access required to change this setting.</div>' : ''}
  `;
}

async function toggleAutoSendOrders(checked) {
  if (!isOwner()) { toast('err','Owner access required'); renderAutoSendOrdersCard(); return; }
  try {
    await saveSetting('auto_send_orders_enabled', checked ? '1' : '');
    toast('ok', checked ? '✓ Auto-send enabled' : '✓ Auto-send disabled');
  } catch (e) {
    toast('err', 'Failed: ' + e.message);
  }
  renderAutoSendOrdersCard();
}

// ── Order Email Template ─────────────────────────────────────────
// Lets the owner customize the subject/intro/signature used when
// sending orders to vendors. Stored in BSC_Settings under
// order_email_subject / order_email_intro / order_email_signature.
// Read by _orderEmailTemplates() in ordering-build.js. Blank settings
// fall back to _ORDER_EMAIL_DEFAULTS.
function renderOrderEmailTemplateCard() {
  const wrap = document.getElementById('order-email-template-card-body');
  if (!wrap) return;
  const subj = getSetting('order_email_subject')   || (typeof _ORDER_EMAIL_DEFAULTS !== 'undefined' ? _ORDER_EMAIL_DEFAULTS.subject   : '');
  const intro = getSetting('order_email_intro')    || (typeof _ORDER_EMAIL_DEFAULTS !== 'undefined' ? _ORDER_EMAIL_DEFAULTS.intro     : '');
  const sig  = getSetting('order_email_signature') || (typeof _ORDER_EMAIL_DEFAULTS !== 'undefined' ? _ORDER_EMAIL_DEFAULTS.signature : '');
  const ownerOnly = !isOwner();
  wrap.innerHTML = `
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px;">
      Customize what vendors see when you send an order. Placeholders: <code>{vendor}</code> <code>{location}</code> <code>{location_address}</code> <code>{date}</code> <code>{user}</code> <code>{total}</code>. The items list, total, and notes are filled in automatically. Addresses are set per location in the Locations card below.
    </p>
    <label class="field-label">Subject</label>
    <input id="oet-subject" class="field-input" style="width:100%;margin-bottom:14px;" value="${escHtml(subj)}" ${ownerOnly?'disabled':''} oninput="renderOrderEmailPreview()">
    <label class="field-label">Intro (above items)</label>
    <textarea id="oet-intro" rows="4" class="field-input" style="width:100%;margin-bottom:14px;font-family:inherit;" ${ownerOnly?'disabled':''} oninput="renderOrderEmailPreview()">${escHtml(intro)}</textarea>
    <label class="field-label">Signature (below items)</label>
    <textarea id="oet-signature" rows="3" class="field-input" style="width:100%;margin-bottom:14px;font-family:inherit;" ${ownerOnly?'disabled':''} oninput="renderOrderEmailPreview()">${escHtml(sig)}</textarea>
    <div style="display:flex;gap:8px;margin-bottom:18px;">
      <button class="btn btn-primary" onclick="saveOrderEmailTemplate()" ${ownerOnly?'disabled':''}>Save</button>
      <button class="btn btn-outline" onclick="resetOrderEmailTemplate()" ${ownerOnly?'disabled':''}>Reset to defaults</button>
    </div>
    <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px;letter-spacing:.04em">PREVIEW</div>
    <div style="background:#f9f9f9;border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.5;">
      <div style="font-weight:600;margin-bottom:8px;color:var(--dark-blue);">Subject: <span id="oet-preview-subject"></span></div>
      <pre id="oet-preview-body" style="margin:0;white-space:pre-wrap;font-family:inherit;color:#333;"></pre>
    </div>
    ${ownerOnly ? '<div style="font-size:11px;color:var(--muted);margin-top:10px;">Owner access required to change this setting.</div>' : ''}
  `;
  renderOrderEmailPreview();
}

function _orderEmailPreviewVars() {
  const sampleLoc = 'Blake';
  const realAddr = getSetting('location_address_' + sampleLoc) || '';
  return {
    vendor:           'Costco',
    location:         sampleLoc,
    location_address: realAddr || '1234 Sample St\nDenver, CO 80205',
    date:             'Friday, May 8',
    user:             currentUser?.name || currentUser?.username || 'Manager',
    total:            '$245.30'
  };
}

function renderOrderEmailPreview() {
  const subj  = document.getElementById('oet-subject')?.value   || '';
  const intro = document.getElementById('oet-intro')?.value     || '';
  const sig   = document.getElementById('oet-signature')?.value || '';
  const vars  = _orderEmailPreviewVars();
  const sub   = (s) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const subjEl = document.getElementById('oet-preview-subject');
  const bodyEl = document.getElementById('oet-preview-body');
  if (subjEl) subjEl.textContent = sub(subj);
  if (bodyEl) {
    const sampleItems = '  • 5 × Whole Milk (gallon)\n  • 12 × Oat Milk (carton)\n  • 2 × Heavy Cream (quart)';
    bodyEl.textContent = [
      sub(intro), '', 'Items:', sampleItems, '', `Total: ${vars.total}`, '', sub(sig)
    ].filter(Boolean).join('\n');
  }
}

async function saveOrderEmailTemplate() {
  if (!isOwner()) { toast('err','Owner access required'); return; }
  const subj = document.getElementById('oet-subject')?.value.trim()   || '';
  const intro = document.getElementById('oet-intro')?.value           || '';
  const sig  = document.getElementById('oet-signature')?.value        || '';
  try {
    await Promise.all([
      saveSetting('order_email_subject',   subj),
      saveSetting('order_email_intro',     intro),
      saveSetting('order_email_signature', sig)
    ]);
    toast('ok', '✓ Order email template saved');
  } catch (e) {
    toast('err', 'Save failed: ' + e.message);
  }
}

async function resetOrderEmailTemplate() {
  if (!isOwner()) { toast('err','Owner access required'); return; }
  if (!confirm('Reset subject, intro, and signature to defaults?')) return;
  try {
    await Promise.all([
      saveSetting('order_email_subject',   ''),
      saveSetting('order_email_intro',     ''),
      saveSetting('order_email_signature', '')
    ]);
    renderOrderEmailTemplateCard();
    toast('ok', '✓ Reset to defaults');
  } catch (e) {
    toast('err', 'Reset failed: ' + e.message);
  }
}
