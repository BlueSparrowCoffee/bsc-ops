/* ================================================================
 * BSC Ops — labels.js
 * Coffee-bag label tracking: monthly balance, bags-sold sync from
 * Square (auto-backfill), and end-of-month reconciliation.
 *
 * Per-location: each location has its own SharePoint list
 * BSC_<Loc>_CoffeeBagLabels (lazy-provisioned via ensureList on first
 * save). cache.labels holds rows for the current scope, with each row
 * tagged `_loc` so 'all' mode can group/sum across locations.
 *
 * Formula:
 *   Adjustment  = ceil(BagsSold × 1.1)   // 10% buffer for misprints
 *   EndBalance  = max(0, StartBalance − Adjustment)
 *   TotalValue  = EndBalance × CostPerLabel (if cost set)
 *
 * syncLabelsBagsSold runs fire-and-forget on tab enter, rate-limited
 * per location to one call per 5 minutes. It backfills current + prior
 * month in case the new-month record was created before month-end
 * Square sales finished.
 *
 * Depends on:
 *   - state.js (cache, currentUser, currentLocation)
 *   - constants.js (BAG_LABELS_LIST_COLS, COFFEE_BAG_PATTERNS)
 *   - graph.js (ensureList, addListItem, updateListItem, getListItems, getSiteId)
 *   - settings.js (getLocations)
 *   - utils.js (escHtml, toast, setLoading, openModal, closeModal)
 *   - index.html globals resolved at call time:
 *     bscNameToSquareLocId, squareAPI
 * ================================================================ */

function labelsListName(loc) {
  const l = loc || currentLocation;
  if (!l || l === 'all') return null;
  return 'BSC_' + l.replace(/[\s\/\\]/g, '_') + '_CoffeeBagLabels';
}

// Configurable via Settings → ☕ Coffee Bags. Falls back to the constant.
function getLabelWastePct() {
  const v = parseFloat(getSetting('bsc_label_waste_pct'));
  return (isNaN(v) || v < 0) ? DEFAULT_LABEL_WASTE_PCT : v;
}

// Sort: Month desc, then Created desc, then id desc as tiebreakers
// (so a transfer record made today wins over an earlier-in-the-month entry).
function _labelRowSort(a, b) {
  const am = a.Month||'', bm = b.Month||'';
  if (am !== bm) return am > bm ? -1 : 1;
  const ac = a.Created||'', bc = b.Created||'';
  if (ac !== bc) return ac > bc ? -1 : 1;
  return Number(b.id||0) - Number(a.id||0);
}

// Per-location rate-limit timestamps for syncLabelsBagsSold
let _labelsSyncedAt = {};

// Pending reconcile data (set during preview, used on confirm)
let _labelsPendingReconcile = null;

async function loadLabelsForLocation() {
  const siteId = await getSiteId();
  const tag = (rows, loc) => rows.map(r => ({ ...r, _loc: loc }));
  if (currentLocation === 'all') {
    const arrays = await Promise.all(
      getLocations().map(l => {
        const ln = labelsListName(l);
        return ln ? getListItems(siteId, ln).catch(() => []).then(rows => tag(rows, l))
                  : Promise.resolve([]);
      })
    );
    cache.labels = arrays.flat();
  } else {
    const ln = labelsListName(currentLocation);
    const rows = ln ? await getListItems(siteId, ln).catch(() => []) : [];
    cache.labels = tag(rows, currentLocation);
  }
}

async function syncLabelsBagsSold() {
  if (currentLocation === 'all') return; // aggregate view is read-only
  const loc = currentLocation;
  // Per-location rate-limit: skip if synced within last 5 minutes
  if (Date.now() - (_labelsSyncedAt[loc] || 0) < 5 * 60 * 1000) return;

  const sqLocId = bscNameToSquareLocId(loc);
  if (!sqLocId) return; // location not mapped to Square

  const listName = labelsListName(loc);
  if (!listName) return;

  _labelsSyncedAt[loc] = Date.now();

  const now = new Date();

  // Build month ranges
  const months = [
    {
      label: now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      startAt: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      endAt:   now.toISOString()
    },
    {
      label: new Date(now.getFullYear(), now.getMonth() - 1, 1)
               .toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      startAt: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(),
      endAt:   new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString()
    }
  ];

  const fetchBags = async ({ startAt, endAt }) => {
    let cursor = null, total = 0;
    do {
      const payload = {
        location_ids: [sqLocId],
        query: { filter: {
          date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
          state_filter: { states: ['COMPLETED'] }
        }},
        limit: 500,
        ...(cursor ? { cursor } : {})
      };
      const data = await squareAPI('POST', 'orders/search', payload);
      for (const order of (data.orders || [])) {
        for (const li of (order.line_items || [])) {
          const liName = (li.name || '').toLowerCase();
          if (COFFEE_BAG_PATTERNS.some(p => liName.includes(p))) {
            total += parseFloat(li.quantity || 1);
          }
        }
      }
      cursor = data.cursor || null;
    } while (cursor);
    return total;
  };

  // Normalize "April 2026", "Apr 2026", etc. to "YYYY-MM" for flexible matching
  function _monthKey(str) {
    if (!str) return '';
    const d = new Date(str.trim() + ' 1');
    if (!isNaN(d)) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    return str.trim().toLowerCase();
  }

  try {
    const [curBags, priorBags] = await Promise.all(months.map(fetchBags));
    const results = [{ label: months[0].label, bags: curBags }, { label: months[1].label, bags: priorBags }];
    let changed = false;
    for (const { label, bags } of results) {
      const labelKey = _monthKey(label);
      // Match within current location only — cache.labels in single-loc mode
      // is already scoped, but defensively filter by _loc anyway.
      const rec = cache.labels.find(r => {
        if (r._loc && r._loc !== loc) return false;
        const m = r.Month || r.Title || '';
        return m === label || _monthKey(m) === labelKey;
      });
      if (!rec) continue;
      // Auto-calc Adjustment (BagsSold × waste multiplier) and roll EndBalance = StartBalance − Adjustment
      const adjustment = Math.ceil(bags * (1 + getLabelWastePct() / 100));
      const start = parseFloat(rec.StartBalance) || 0;
      const endBal = Math.max(0, start - adjustment);
      const cost   = rec.CostPerLabel ? parseFloat(rec.CostPerLabel) : 0;
      const totalValue = cost > 0 ? +(endBal * cost).toFixed(2) : rec.TotalValue;
      const needsUpdate = rec.BagsSold !== bags || rec.Adjustment !== adjustment || rec.EndBalance !== endBal;
      if (needsUpdate) {
        const patch = { BagsSold: bags, Adjustment: adjustment, EndBalance: endBal };
        if (cost > 0) patch.TotalValue = totalValue;
        await updateListItem(listName, rec.id, patch);
        rec.BagsSold = bags;
        rec.Adjustment = adjustment;
        rec.EndBalance = endBal;
        if (cost > 0) rec.TotalValue = totalValue;
        changed = true;
      }
    }
    if (changed) renderLabelsPage();
    toast('ok', `Bags sold synced (${loc}): ${results.map(r => `${r.label} → ${r.bags}`).join(', ')}`);
  } catch(e) {
    _labelsSyncedAt[loc] = 0; // reset rate-limit so it retries next time
    const lower = (e.message || '').toLowerCase();
    const msg = (lower.includes('permission') || lower.includes('forbidden') || lower.includes('403') || lower.includes('not authorized'))
      ? 'Square Orders API permission denied — enable ORDERS_READ in your Square app settings'
      : 'Bags sold sync failed: ' + e.message;
    console.warn('[BSC] syncLabelsBagsSold:', e.message);
    toast('err', msg);
  }
}

// Page entry point — builds the wrapping structure for all three sections
// (Retail Bag Inventory, 12oz Bag Labels, 5 LB Bag Labels) and triggers
// each section's render + Square sync.
function renderLabelsInTab() {
  const container = document.getElementById('inv-labels-content');
  if (!container) return;
  if (!container.querySelector('#labels-summary-bar')) {
    container.innerHTML = `
      <section style="margin-top:8px;">
        <h2 style="font-size:18px;margin:0 0 4px;">🛍️ Retail Bag Inventory</h2>
        <div id="retail-bags-summary-bar" style="display:flex;gap:16px;flex-wrap:wrap;margin:12px 0 16px;"></div>
        <div id="retail-bags-toolbar" class="toolbar" style="margin-bottom:14px;"></div>
        <div id="retail-bags-history-wrap"></div>
      </section>
      <hr style="border:none;border-top:1px solid var(--border);margin:28px 0;">
      <section>
        <h2 style="font-size:18px;margin:0 0 4px;">🏷️ 12oz Retail Bag Labels</h2>
        <div id="labels-summary-bar" style="display:flex;gap:16px;flex-wrap:wrap;margin:12px 0 16px;"></div>
        <div id="labels-toolbar" class="toolbar" style="margin-bottom:14px;"></div>
        <div id="labels-history-wrap"></div>
      </section>
      ${(typeof FEATURE_5LB_LABELS !== 'undefined' && FEATURE_5LB_LABELS) ? `
      <hr style="border:none;border-top:1px solid var(--border);margin:28px 0;">
      <section>
        <h2 style="font-size:18px;margin:0 0 4px;">🏷️ 5 LB Bag Labels</h2>
        <div id="five-lb-labels-summary-bar" style="display:flex;gap:16px;flex-wrap:wrap;margin:12px 0 16px;"></div>
        <div id="five-lb-labels-toolbar" class="toolbar" style="margin-bottom:14px;"></div>
        <div id="five-lb-labels-history-wrap"></div>
      </section>` : ''}`;
  }
  if (typeof renderRetailBagsPage === 'function') renderRetailBagsPage();
  renderLabelsPage();
  if (typeof renderFiveLbLabelsPage === 'function') renderFiveLbLabelsPage();
  if (typeof syncRetailBagsSold === 'function') syncRetailBagsSold(); // fire-and-forget
  syncLabelsBagsSold(); // fire-and-forget — updates BagsSold from Square in background
}

function renderLabelsPage() {
  const summaryBar = document.getElementById('labels-summary-bar');
  const toolbar    = document.getElementById('labels-toolbar');
  const wrap       = document.getElementById('labels-history-wrap');
  if (!summaryBar || !toolbar || !wrap) return;

  const allMode = currentLocation === 'all';

  // ── Summary cards ─────────────────────────────────────────────
  let balanceNum, valueNum, lastMonthLabel;
  if (allMode) {
    // Group by location, take latest record per location, sum balances + values
    const byLoc = {};
    for (const r of cache.labels) {
      const l = r._loc || '—';
      if (!byLoc[l]) byLoc[l] = [];
      byLoc[l].push(r);
    }
    let totalBal = 0, totalVal = 0, anyVal = false, latestOverall = null;
    for (const l of Object.keys(byLoc)) {
      const sorted = byLoc[l].sort(_labelRowSort);
      const latest = sorted[0];
      if (!latest) continue;
      totalBal += parseFloat(latest.EndBalance) || 0;
      if (latest.TotalValue != null) { totalVal += parseFloat(latest.TotalValue) || 0; anyVal = true; }
      if (!latestOverall || (latest.Month||'') > (latestOverall.Month||'')) latestOverall = latest;
    }
    balanceNum     = totalBal.toLocaleString();
    valueNum       = anyVal ? '$' + totalVal.toFixed(2) : '—';
    lastMonthLabel = latestOverall ? (latestOverall.Month || '—') : 'None yet';
  } else {
    const rows = [...cache.labels].sort(_labelRowSort);
    const latest = rows[0];
    balanceNum     = latest ? (+latest.EndBalance).toLocaleString() : '—';
    valueNum       = latest && latest.TotalValue != null ? '$' + (+latest.TotalValue).toFixed(2) : '—';
    lastMonthLabel = latest ? (latest.Month || '—') : 'None yet';
  }
  const balLabel = allMode ? 'Total Current Balance' : 'Current Balance';
  const valLabel = allMode ? 'Total Estimated Value' : 'Estimated Value';
  summaryBar.innerHTML = `
    <div class="card" style="flex:1;min-width:140px;text-align:center;padding:18px 12px;">
      <div style="font-size:26px;font-weight:700;color:var(--dark-blue)">${balanceNum}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">${balLabel}</div>
    </div>
    <div class="card" style="flex:1;min-width:140px;text-align:center;padding:18px 12px;">
      <div style="font-size:26px;font-weight:700;color:var(--gold)">${valueNum}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">${valLabel}</div>
    </div>
    <div class="card" style="flex:1;min-width:140px;text-align:center;padding:18px 12px;">
      <div style="font-size:20px;font-weight:700;color:var(--muted)">${escHtml(lastMonthLabel)}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">Last Reconciliation</div>
    </div>`;

  // ── Toolbar ───────────────────────────────────────────────────
  if (allMode) {
    toolbar.innerHTML = `<span style="font-size:13px;color:var(--muted);">📍 Aggregate view across all locations — pick a location to update or reconcile.</span>`;
  } else {
    // Reconcile hint — suggest running if we're on/after the 1st and no record for last month
    const now = new Date();
    const lastMonthStr = new Date(now.getFullYear(), now.getMonth()-1, 1)
      .toLocaleDateString('en-US', {month:'long', year:'numeric'});
    const hasLastMonth = cache.labels.some(r => r.Month === lastMonthStr);
    const hint = (!hasLastMonth && now.getDate() >= 1)
      ? `<span style="font-size:12px;color:var(--gold);align-self:center;margin-left:8px;">💡 ${lastMonthStr} not reconciled yet</span>`
      : '';
    toolbar.innerHTML = `
      <button class="btn btn-primary" onclick="openLabelsEntryModal()">+ Update Balance</button>
      <button class="btn btn-outline" onclick="openLabelsReconcileModal()" id="labels-reconcile-btn">📊 Reconcile Month</button>
      ${hint}`;
  }

  // ── History table ─────────────────────────────────────────────
  // Sort: Month desc, then Location asc (in 'all' mode)
  const rows = [...cache.labels].sort((a,b) => {
    const am = a.Month || '', bm = b.Month || '';
    if (am !== bm) return am > bm ? -1 : 1;
    const locCmp = (a._loc || '').localeCompare(b._loc || '');
    if (locCmp !== 0) return locCmp;
    const ac = a.Created || '', bc = b.Created || '';
    if (ac !== bc) return ac > bc ? -1 : 1;
    return Number(b.id||0) - Number(a.id||0);
  });

  if (!rows.length) {
    wrap.innerHTML = `<div class="no-data" style="padding:32px 0;">No label records yet${allMode ? '' : '. Click "Update Balance" to set your starting count'}.</div>`;
    return;
  }

  const headLoc = allMode ? '<th>Location</th>' : '';
  const bodyHtml = rows.map(r => {
    const locCell = allMode ? `<td>${escHtml(r._loc || '—')}</td>` : '';
    return `<tr>
      <td><b>${escHtml(r.Month||'—')}</b></td>
      ${locCell}
      <td>${r.StartBalance != null ? (+r.StartBalance).toLocaleString() : '—'}</td>
      <td>${r.BagsSold != null ? (+r.BagsSold).toLocaleString() : '—'}</td>
      <td>${r.Adjustment != null ? (+r.Adjustment).toLocaleString() : '—'}</td>
      <td><b>${r.EndBalance != null ? (+r.EndBalance).toLocaleString() : '—'}</b></td>
      <td>${r.CostPerLabel != null ? '$'+parseFloat(r.CostPerLabel).toFixed(4) : '—'}</td>
      <td>${r.TotalValue != null ? '$'+parseFloat(r.TotalValue).toFixed(2) : '—'}</td>
      <td class="text-hint">${escHtml(r.Notes||'')}</td>
      <td class="text-hint">${escHtml(r.ReconcileBy||'')}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>Month</th>${headLoc}<th>Start</th><th>Bags Sold</th><th><a href="#" onclick="navToCoffeeBagSettings('label-waste-pct-input');return false;" style="color:inherit;text-decoration:underline dotted;cursor:pointer;" title="Click to adjust waste %">Adjusted</a></th><th>End Balance</th><th>Cost/Label</th><th>Total Value</th><th>Notes</th><th>By</th>
        </tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>`;
}

function openLabelsEntryModal() {
  if (currentLocation === 'all') { toast('err','Select a location first'); return; }
  // Pre-fill cost from this location's most recent record
  const latest = [...cache.labels].sort(_labelRowSort)[0];
  document.getElementById('labels-balance-input').value = '';
  document.getElementById('labels-cost-input').value = latest?.CostPerLabel ? parseFloat(latest.CostPerLabel).toFixed(4) : '';
  const now = new Date();
  document.getElementById('labels-date-input').value =
    now.toLocaleDateString('en-US', {month:'long', year:'numeric'});
  document.getElementById('labels-notes-input').value = '';
  openModal('modal-labels-entry');
}

async function saveLabelsEntry() {
  const listName = labelsListName(currentLocation);
  if (!listName) { toast('err','Select a location first'); return; }
  const bal = parseFloat(document.getElementById('labels-balance-input').value);
  const cost = parseFloat(document.getElementById('labels-cost-input').value) || 0;
  const month = document.getElementById('labels-date-input').value.trim();
  const notes = document.getElementById('labels-notes-input').value.trim();
  if (isNaN(bal) || bal < 0) { toast('err','Enter a valid balance'); return; }
  if (!month) { toast('err','Enter a month/date label'); return; }
  setLoading(true,'Saving…');
  try {
    await ensureList(listName, BAG_LABELS_LIST_COLS);
    const fields = {
      Title: month, Month: month,
      StartBalance: bal, EndBalance: bal,
      CostPerLabel: cost || null,
      TotalValue: cost > 0 ? +(bal * cost).toFixed(2) : null,
      Notes: notes,
      ReconcileBy: currentUser?.name || currentUser?.username || ''
    };
    const item = await addListItem(listName, fields);
    cache.labels.push({ ...item, _loc: currentLocation });
    renderLabelsPage();
    closeModal('modal-labels-entry');
    toast('ok','✓ Balance saved');
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}

async function openLabelsReconcileModal() {
  if (currentLocation === 'all') { toast('err','Select a location first'); return; }
  const body = document.getElementById('labels-reconcile-body');
  const confirmBtn = document.getElementById('labels-reconcile-confirm-btn');
  _labelsPendingReconcile = null;
  confirmBtn.disabled = true;
  body.innerHTML = '<div style="color:var(--muted);padding:12px 0;">Loading Square sales data…</div>';
  openModal('modal-labels-reconcile');

  const now = new Date();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthLabel = lastMonthStart.toLocaleDateString('en-US', {month:'long', year:'numeric'});

  try {
    const startAt = lastMonthStart.toISOString();
    const endAt   = lastMonthEnd.toISOString();
    const sqLocId = bscNameToSquareLocId(currentLocation);

    let bagsSold = 0;

    if (!sqLocId) {
      body.innerHTML = `<div style="color:var(--orange);padding:12px 0;">⚠ ${escHtml(currentLocation)} is not mapped to a Square location. Go to Square → Location Mapping first.</div>`;
      return;
    }

    // Fetch orders from Square for prior month, scoped to this location only
    body.innerHTML = '<div style="color:var(--muted);padding:4px 0;">Fetching Square sales…</div>';
    let cursor = null;
    const coffeeLineItems = [];
    do {
      const payload = {
        location_ids: [sqLocId],
        query: {
          filter: {
            date_time_filter: {
              created_at: { start_at: startAt, end_at: endAt }
            },
            state_filter: { states: ['COMPLETED'] }
          }
        },
        limit: 500,
        ...(cursor ? { cursor } : {})
      };
      const data = await squareAPI('POST', 'orders/search', payload);
      const orders = data.orders || [];
      for (const order of orders) {
        for (const li of (order.line_items || [])) {
          const liName = (li.name || '').toLowerCase();
          if (COFFEE_BAG_PATTERNS.some(p => liName.includes(p))) {
            const qty = parseFloat(li.quantity || 1);
            bagsSold += qty;
            coffeeLineItems.push({ name: li.name, qty });
          }
        }
      }
      cursor = data.cursor || null;
    } while (cursor);

    // Aggregate by name
    const byName = {};
    coffeeLineItems.forEach(li => { byName[li.name] = (byName[li.name]||0) + li.qty; });

    const wastePct = getLabelWastePct();
    const adjustment = Math.ceil(bagsSold * (1 + wastePct / 100)); // bags sold + waste %, rounded up
    const latest = [...cache.labels].sort(_labelRowSort)[0];
    const startBal = latest ? parseFloat(latest.EndBalance || 0) : 0;
    const endBal   = Math.max(0, startBal - adjustment);
    const costPerLabel = latest?.CostPerLabel ? parseFloat(latest.CostPerLabel) : 0;
    const totalValue   = costPerLabel > 0 ? +(endBal * costPerLabel).toFixed(2) : null;

    _labelsPendingReconcile = {
      month: monthLabel, startBalance: startBal, bagsSold, adjustment,
      endBalance: endBal, costPerLabel: costPerLabel || null,
      totalValue, squareData: JSON.stringify(byName),
      location: currentLocation
    };

    const breakdownRows = Object.entries(byName).sort(([,a],[,b])=>b-a)
      .map(([name,qty])=>`<tr><td style="padding:2px 8px;">${escHtml(name)}</td><td style="padding:2px 8px;text-align:right;">${qty}</td></tr>`).join('');

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
        <div style="background:var(--cream);border-radius:8px;padding:12px;">
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Month</div>
          <div style="font-weight:700">${escHtml(monthLabel)} — ${escHtml(currentLocation)}</div>
        </div>
        <div style="background:var(--cream);border-radius:8px;padding:12px;">
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Starting Balance</div>
          <div style="font-weight:700">${startBal.toLocaleString()} labels</div>
        </div>
        <div style="background:var(--cream);border-radius:8px;padding:12px;">
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Bags Sold (Square)</div>
          <div style="font-weight:700">${bagsSold.toLocaleString()}</div>
        </div>
        <div style="background:var(--cream);border-radius:8px;padding:12px;">
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Labels Deducted (+10%)</div>
          <div style="font-weight:700;color:var(--red)">−${adjustment.toLocaleString()}</div>
        </div>
        <div style="background:var(--gold);border-radius:8px;padding:12px;">
          <div style="font-size:11px;color:rgba(255,255,255,.8);margin-bottom:2px">New Balance</div>
          <div style="font-weight:700;font-size:18px;color:#fff">${endBal.toLocaleString()}</div>
        </div>
        ${totalValue != null ? `<div style="background:var(--opal);border-radius:8px;padding:12px;">
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Estimated Value</div>
          <div style="font-weight:700;color:var(--dark-blue)">$${totalValue.toFixed(2)}</div>
        </div>` : ''}
      </div>
      ${breakdownRows ? `
      <div style="font-size:12px;font-weight:600;margin-bottom:6px">Bags sold by SKU:</div>
      <div style="max-height:140px;overflow-y:auto;font-size:12px;border:1px solid var(--border);border-radius:6px;">
        <table style="width:100%;border-collapse:collapse;">${breakdownRows}</table>
      </div>` : '<div style="color:var(--muted);font-size:12px;">No matching coffee bag sales found in Square for this period.</div>'}
    `;
    confirmBtn.disabled = false;
  } catch(e) {
    body.innerHTML = `<div style="color:var(--red);padding:12px 0;">❌ ${escHtml(e.message)}</div>`;
  }
}

async function confirmLabelsReconcile() {
  if (!_labelsPendingReconcile) return;
  const d = _labelsPendingReconcile;
  const listName = labelsListName(d.location);
  if (!listName) { toast('err','Lost location context — re-open Reconcile'); return; }
  setLoading(true,'Saving reconciliation…');
  try {
    await ensureList(listName, BAG_LABELS_LIST_COLS);
    const fields = {
      Title: d.month, Month: d.month,
      StartBalance: d.startBalance,
      BagsSold: d.bagsSold,
      Adjustment: d.adjustment,
      EndBalance: d.endBalance,
      CostPerLabel: d.costPerLabel,
      TotalValue: d.totalValue,
      SquareData: d.squareData,
      ReconcileBy: currentUser?.name || currentUser?.username || ''
    };
    const item = await addListItem(listName, fields);
    cache.labels.push({ ...item, _loc: d.location });
    renderLabelsPage();
    closeModal('modal-labels-reconcile');
    toast('ok',`✓ ${d.month} reconciled (${d.location}) — ${d.endBalance.toLocaleString()} labels remaining`);
    _labelsPendingReconcile = null;
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}
