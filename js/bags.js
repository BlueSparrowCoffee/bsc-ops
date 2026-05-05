/* ================================================================
 * BSC Ops — bags.js
 * Retail coffee bag inventory tracker — sibling to labels.js. Same
 * monthly reconcile pattern, same Square data feed (COFFEE_BAG_PATTERNS),
 * different list + waste multiplier:
 *
 *   EndBalance = StartBalance − Adjustment
 *   Adjustment = ceil(BagsSold × (1 + getRetailBagWastePct()/100))
 *
 * Per-location: BSC_<Loc>_RetailBagInventory (lazy-provisioned via
 * ensureList on first save). cache.retailBags holds rows for the
 * current scope, tagged with `_loc` so 'all' mode aggregates correctly.
 *
 * Waste % is configurable via Settings → ☕ Coffee Bags. Defaults to 2%.
 *
 * Depends on:
 *   - state.js (cache, currentUser, currentLocation)
 *   - constants.js (RETAIL_BAGS_LIST_COLS, COFFEE_BAG_PATTERNS,
 *     DEFAULT_RETAIL_BAG_WASTE_PCT)
 *   - graph.js (ensureList, addListItem, updateListItem, getListItems, getSiteId)
 *   - settings.js (getLocations, getSetting)
 *   - utils.js (escHtml, toast, setLoading, openModal, closeModal)
 *   - index.html globals resolved at call time:
 *     bscNameToSquareLocId, squareAPI
 * ================================================================ */

function retailBagsListName(loc) {
  const l = loc || currentLocation;
  if (!l || l === 'all') return null;
  return 'BSC_' + l.replace(/[\s\/\\]/g, '_') + '_RetailBagInventory';
}

// Configurable via Settings → ☕ Coffee Bags. Falls back to the constant.
function getRetailBagWastePct() {
  const v = parseFloat(getSetting('bsc_retail_bag_waste_pct'));
  return (isNaN(v) || v < 0) ? DEFAULT_RETAIL_BAG_WASTE_PCT : v;
}

// Sort: Month desc, then Created desc, then id desc as tiebreakers
function _retailBagRowSort(a, b) {
  const am = a.Month||'', bm = b.Month||'';
  if (am !== bm) return am > bm ? -1 : 1;
  const ac = a.Created||'', bc = b.Created||'';
  if (ac !== bc) return ac > bc ? -1 : 1;
  return Number(b.id||0) - Number(a.id||0);
}

// Per-location rate-limit timestamps for syncRetailBagsSold
let _retailBagsSyncedAt = {};

// Pending reconcile data (set during preview, used on confirm)
let _retailBagsPendingReconcile = null;

async function loadRetailBagsForLocation() {
  const siteId = await getSiteId();
  const tag = (rows, loc) => rows.map(r => ({ ...r, _loc: loc }));
  if (currentLocation === 'all') {
    const arrays = await Promise.all(
      getLocations().map(l => {
        const ln = retailBagsListName(l);
        return ln ? getListItems(siteId, ln).catch(() => []).then(rows => tag(rows, l))
                  : Promise.resolve([]);
      })
    );
    cache.retailBags = arrays.flat();
  } else {
    const ln = retailBagsListName(currentLocation);
    const rows = ln ? await getListItems(siteId, ln).catch(() => []) : [];
    cache.retailBags = tag(rows, currentLocation);
  }
}

async function syncRetailBagsSold() {
  if (currentLocation === 'all') return; // aggregate view is read-only
  const loc = currentLocation;
  if (Date.now() - (_retailBagsSyncedAt[loc] || 0) < 5 * 60 * 1000) return;

  const sqLocId = bscNameToSquareLocId(loc);
  if (!sqLocId) return;

  const listName = retailBagsListName(loc);
  if (!listName) return;

  _retailBagsSyncedAt[loc] = Date.now();

  const now = new Date();
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

  // _monthKey lives in utils.js (shared with labels.js).

  try {
    const [curBags, priorBags] = await Promise.all(months.map(fetchBags));
    const results = [{ label: months[0].label, bags: curBags }, { label: months[1].label, bags: priorBags }];
    const wasteMul = 1 + getRetailBagWastePct() / 100;
    let changed = false;
    for (const { label, bags } of results) {
      const labelKey = _monthKey(label);
      const rec = cache.retailBags.find(r => {
        if (r._loc && r._loc !== loc) return false;
        const m = r.Month || r.Title || '';
        return m === label || _monthKey(m) === labelKey;
      });
      if (!rec) continue;
      const adjustment = Math.ceil(bags * wasteMul);
      const start = parseFloat(rec.StartBalance) || 0;
      const endBal = Math.max(0, start - adjustment);
      const cost   = rec.CostPerBag ? parseFloat(rec.CostPerBag) : 0;
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
    if (changed) renderRetailBagsPage();
    toast('ok', `Retail bags synced (${loc}): ${results.map(r => `${r.label} → ${r.bags}`).join(', ')}`);
  } catch(e) {
    _retailBagsSyncedAt[loc] = 0;
    const lower = (e.message || '').toLowerCase();
    const msg = (lower.includes('permission') || lower.includes('forbidden') || lower.includes('403') || lower.includes('not authorized'))
      ? 'Square Orders API permission denied — enable ORDERS_READ in your Square app settings'
      : 'Retail bags sync failed: ' + e.message;
    console.warn('[BSC] syncRetailBagsSold:', e.message);
    toast('err', msg);
  }
}

function renderRetailBagsPage() {
  const summaryBar = document.getElementById('retail-bags-summary-bar');
  const toolbar    = document.getElementById('retail-bags-toolbar');
  const wrap       = document.getElementById('retail-bags-history-wrap');
  if (!summaryBar || !toolbar || !wrap) return;

  const allMode = currentLocation === 'all';

  // ── Summary cards ─────────────────────────────────────────────
  let balanceNum, valueNum, lastMonthLabel;
  if (allMode) {
    const byLoc = {};
    for (const r of cache.retailBags) {
      const l = r._loc || '—';
      if (!byLoc[l]) byLoc[l] = [];
      byLoc[l].push(r);
    }
    let totalBal = 0, totalVal = 0, anyVal = false, latestOverall = null;
    for (const l of Object.keys(byLoc)) {
      const sorted = byLoc[l].sort(_retailBagRowSort);
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
    const rows = [...cache.retailBags].sort(_retailBagRowSort);
    const latest = rows[0];
    balanceNum     = latest ? (+latest.EndBalance).toLocaleString() : '—';
    valueNum       = latest && latest.TotalValue != null ? '$' + (+latest.TotalValue).toFixed(2) : '—';
    lastMonthLabel = latest ? (latest.Month || '—') : 'None yet';
  }
  const balLabel = allMode ? 'Total Bags On Hand' : 'Bags On Hand';
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
    const now = new Date();
    const lastMonthStr = new Date(now.getFullYear(), now.getMonth()-1, 1)
      .toLocaleDateString('en-US', {month:'long', year:'numeric'});
    const hasLastMonth = cache.retailBags.some(r => r.Month === lastMonthStr);
    const hint = (!hasLastMonth && now.getDate() >= 1)
      ? `<span style="font-size:12px;color:var(--gold);align-self:center;margin-left:8px;">💡 ${lastMonthStr} not reconciled yet</span>`
      : '';
    toolbar.innerHTML = `
      <button class="btn btn-primary" onclick="openRetailBagsEntryModal()">+ Update Stock</button>
      <button class="btn btn-outline" onclick="openRetailBagsReconcileModal()" id="retail-bags-reconcile-btn">📊 Reconcile Month</button>
      ${hint}`;
  }

  // ── History table ─────────────────────────────────────────────
  const rows = [...cache.retailBags].sort((a,b) => {
    const am = a.Month || '', bm = b.Month || '';
    if (am !== bm) return am > bm ? -1 : 1;
    const locCmp = (a._loc || '').localeCompare(b._loc || '');
    if (locCmp !== 0) return locCmp;
    const ac = a.Created || '', bc = b.Created || '';
    if (ac !== bc) return ac > bc ? -1 : 1;
    return Number(b.id||0) - Number(a.id||0);
  });

  if (!rows.length) {
    wrap.innerHTML = `<div class="no-data" style="padding:24px 0;">No retail bag records yet${allMode ? '' : '. Click "Update Stock" to set your starting count'}.</div>`;
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
      <td>${r.CostPerBag != null ? '$'+parseFloat(r.CostPerBag).toFixed(2) : '—'}</td>
      <td>${r.TotalValue != null ? '$'+parseFloat(r.TotalValue).toFixed(2) : '—'}</td>
      <td class="text-hint">${escHtml(r.Notes||'')}</td>
      <td class="text-hint">${escHtml(r.ReconcileBy||'')}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>Month</th>${headLoc}<th>Start</th><th>Bags Sold</th><th><a href="#" onclick="navToCoffeeBagSettings('retail-bag-waste-pct-input');return false;" style="color:inherit;text-decoration:underline dotted;cursor:pointer;" title="Click to adjust waste %">Adjusted</a></th><th>End Balance</th><th>Cost/Bag</th><th>Total Value</th><th>Notes</th><th>By</th>
        </tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>`;
}

function openRetailBagsEntryModal() {
  if (currentLocation === 'all') { toast('err','Select a location first'); return; }
  const latest = [...cache.retailBags].sort(_retailBagRowSort)[0];
  document.getElementById('retail-bags-balance-input').value = '';
  document.getElementById('retail-bags-cost-input').value = latest?.CostPerBag ? parseFloat(latest.CostPerBag).toFixed(2) : '';
  const now = new Date();
  document.getElementById('retail-bags-date-input').value =
    now.toLocaleDateString('en-US', {month:'long', year:'numeric'});
  document.getElementById('retail-bags-notes-input').value = '';
  openModal('modal-retail-bags-entry');
}

async function saveRetailBagsEntry() {
  const listName = retailBagsListName(currentLocation);
  if (!listName) { toast('err','Select a location first'); return; }
  const bal = parseFloat(document.getElementById('retail-bags-balance-input').value);
  const cost = parseFloat(document.getElementById('retail-bags-cost-input').value) || 0;
  const month = document.getElementById('retail-bags-date-input').value.trim();
  const notes = document.getElementById('retail-bags-notes-input').value.trim();
  if (isNaN(bal) || bal < 0) { toast('err','Enter a valid balance'); return; }
  if (!month) { toast('err','Enter a month/date label'); return; }
  setLoading(true,'Saving…');
  try {
    await ensureList(listName, RETAIL_BAGS_LIST_COLS);
    const fields = {
      Title: month, Month: month,
      StartBalance: bal, EndBalance: bal,
      CostPerBag: cost || null,
      TotalValue: cost > 0 ? +(bal * cost).toFixed(2) : null,
      Notes: notes,
      ReconcileBy: currentUser?.name || currentUser?.username || ''
    };
    const item = await addListItem(listName, fields);
    cache.retailBags.push({ ...item, _loc: currentLocation });
    renderRetailBagsPage();
    closeModal('modal-retail-bags-entry');
    toast('ok','✓ Stock saved');
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}

async function openRetailBagsReconcileModal() {
  if (currentLocation === 'all') { toast('err','Select a location first'); return; }
  const body = document.getElementById('retail-bags-reconcile-body');
  const confirmBtn = document.getElementById('retail-bags-reconcile-confirm-btn');
  _retailBagsPendingReconcile = null;
  confirmBtn.disabled = true;
  body.innerHTML = '<div style="color:var(--muted);padding:12px 0;">Loading Square sales data…</div>';
  openModal('modal-retail-bags-reconcile');

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

    body.innerHTML = '<div style="color:var(--muted);padding:4px 0;">Fetching Square sales…</div>';
    let cursor = null;
    const coffeeLineItems = [];
    do {
      const payload = {
        location_ids: [sqLocId],
        query: {
          filter: {
            date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
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

    const byName = {};
    coffeeLineItems.forEach(li => { byName[li.name] = (byName[li.name]||0) + li.qty; });

    const wastePct = getRetailBagWastePct();
    const adjustment = Math.ceil(bagsSold * (1 + wastePct / 100));
    const latest = [...cache.retailBags].sort(_retailBagRowSort)[0];
    const startBal = latest ? parseFloat(latest.EndBalance || 0) : 0;
    const endBal   = Math.max(0, startBal - adjustment);
    const costPerBag = latest?.CostPerBag ? parseFloat(latest.CostPerBag) : 0;
    const totalValue = costPerBag > 0 ? +(endBal * costPerBag).toFixed(2) : null;

    _retailBagsPendingReconcile = {
      month: monthLabel, startBalance: startBal, bagsSold, adjustment,
      endBalance: endBal, costPerBag: costPerBag || null,
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
          <div style="font-weight:700">${startBal.toLocaleString()} bags</div>
        </div>
        <div style="background:var(--cream);border-radius:8px;padding:12px;">
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Bags Sold (Square)</div>
          <div style="font-weight:700">${bagsSold.toLocaleString()}</div>
        </div>
        <div style="background:var(--cream);border-radius:8px;padding:12px;">
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Bags Deducted (+${wastePct}%)</div>
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

async function confirmRetailBagsReconcile() {
  if (!_retailBagsPendingReconcile) return;
  const d = _retailBagsPendingReconcile;
  const listName = retailBagsListName(d.location);
  if (!listName) { toast('err','Lost location context — re-open Reconcile'); return; }
  setLoading(true,'Saving reconciliation…');
  try {
    await ensureList(listName, RETAIL_BAGS_LIST_COLS);
    const fields = {
      Title: d.month, Month: d.month,
      StartBalance: d.startBalance,
      BagsSold: d.bagsSold,
      Adjustment: d.adjustment,
      EndBalance: d.endBalance,
      CostPerBag: d.costPerBag,
      TotalValue: d.totalValue,
      SquareData: d.squareData,
      ReconcileBy: currentUser?.name || currentUser?.username || ''
    };
    const item = await addListItem(listName, fields);
    cache.retailBags.push({ ...item, _loc: d.location });
    renderRetailBagsPage();
    closeModal('modal-retail-bags-reconcile');
    toast('ok',`✓ ${d.month} reconciled (${d.location}) — ${d.endBalance.toLocaleString()} bags remaining`);
    _retailBagsPendingReconcile = null;
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}
