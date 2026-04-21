/* ================================================================
 * BSC Ops — labels.js
 * Coffee-bag label tracking: monthly balance, bags-sold sync from
 * Square (auto-backfill), and end-of-month reconciliation.
 *
 * Formula:
 *   Adjustment  = ceil(BagsSold × 1.1)   // 10% buffer for misprints
 *   EndBalance  = max(0, StartBalance − Adjustment)
 *   TotalValue  = EndBalance × CostPerLabel (if cost set)
 *
 * syncLabelsBagsSold runs fire-and-forget on tab enter, rate-limited
 * to one call per 5 minutes. It backfills current + prior month in
 * case the new-month record was created before month-end Square
 * sales finished.
 *
 * Depends on:
 *   - state.js (cache, currentUser)
 *   - constants.js (LISTS, COFFEE_BAG_PATTERNS)
 *   - graph.js (addListItem, updateListItem)
 *   - utils.js (escHtml, toast, setLoading, openModal, closeModal)
 *   - index.html globals resolved at call time:
 *     getSquareLocIds, getSquareLocMap, squareAPI
 * ================================================================ */

let _labelsSyncedAt = 0;

async function syncLabelsBagsSold() {
  // Rate-limit: skip if synced within last 5 minutes
  if (Date.now() - _labelsSyncedAt < 5 * 60 * 1000) return;

  const squareLocIds = getSquareLocIds();
  if (!squareLocIds.length) return; // Square not configured

  _labelsSyncedAt = Date.now();

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
        location_ids: squareLocIds,
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
      const rec = cache.labels.find(r => {
        const m = r.Month || r.Title || '';
        return m === label || _monthKey(m) === labelKey;
      });
      if (!rec) continue;
      // Auto-calc Adjustment (BagsSold × 1.1) and roll EndBalance = StartBalance − Adjustment
      const adjustment = Math.ceil(bags * 1.1);
      const start = parseFloat(rec.StartBalance) || 0;
      const endBal = Math.max(0, start - adjustment);
      const cost   = rec.CostPerLabel ? parseFloat(rec.CostPerLabel) : 0;
      const totalValue = cost > 0 ? +(endBal * cost).toFixed(2) : rec.TotalValue;
      const needsUpdate = rec.BagsSold !== bags || rec.Adjustment !== adjustment || rec.EndBalance !== endBal;
      if (needsUpdate) {
        const patch = { BagsSold: bags, Adjustment: adjustment, EndBalance: endBal };
        if (cost > 0) patch.TotalValue = totalValue;
        await updateListItem(LISTS.labels, rec.id, patch);
        rec.BagsSold = bags;
        rec.Adjustment = adjustment;
        rec.EndBalance = endBal;
        if (cost > 0) rec.TotalValue = totalValue;
        changed = true;
      }
    }
    if (changed) renderLabelsPage();
    toast('ok', `Bags sold synced: ${results.map(r => `${r.label} → ${r.bags}`).join(', ')}`);
  } catch(e) {
    _labelsSyncedAt = 0; // reset rate-limit so it retries next time
    const lower = (e.message || '').toLowerCase();
    const msg = (lower.includes('permission') || lower.includes('forbidden') || lower.includes('403') || lower.includes('not authorized'))
      ? 'Square Orders API permission denied — enable ORDERS_READ in your Square app settings'
      : 'Bags sold sync failed: ' + e.message;
    console.warn('[BSC] syncLabelsBagsSold:', e.message);
    toast('err', msg);
  }
}

function renderLabelsInTab() {
  const container = document.getElementById('inv-labels-content');
  if (!container) return;
  if (!container.querySelector('#labels-summary-bar')) {
    container.innerHTML = `
      <div id="labels-summary-bar" style="display:flex;gap:16px;flex-wrap:wrap;margin:16px 0 20px;">
        <div class="card" style="flex:1;min-width:140px;text-align:center;padding:18px 12px;">
          <div style="font-size:26px;font-weight:700;color:var(--dark-blue)" id="labels-balance-num">—</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">Current Balance</div>
        </div>
        <div class="card" style="flex:1;min-width:140px;text-align:center;padding:18px 12px;">
          <div style="font-size:26px;font-weight:700;color:var(--gold)" id="labels-value-num">—</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">Estimated Value</div>
        </div>
        <div class="card" style="flex:1;min-width:140px;text-align:center;padding:18px 12px;">
          <div style="font-size:20px;font-weight:700;color:var(--muted)" id="labels-last-month">—</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">Last Reconciliation</div>
        </div>
      </div>
      <div class="toolbar" style="margin-bottom:16px;">
        <button class="btn btn-primary" onclick="openLabelsEntryModal()">+ Update Balance</button>
        <button class="btn btn-outline" onclick="openLabelsReconcileModal()" id="labels-reconcile-btn">📊 Reconcile Month</button>
        <span id="labels-reconcile-hint" style="font-size:12px;color:var(--muted);align-self:center;margin-left:8px;"></span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>
            <th>Month</th><th>Start</th><th>Bags Sold</th><th>Adjustment</th><th>End Balance</th><th>Cost/Label</th><th>Total Value</th><th>Notes</th><th>By</th>
          </tr></thead>
          <tbody id="labels-history-body"></tbody>
        </table>
        <div class="no-data" id="labels-empty" style="display:none">No label records yet. Click "Update Balance" to set your starting count.</div>
      </div>`;
  }
  renderLabelsPage();
  syncLabelsBagsSold(); // fire-and-forget — updates BagsSold from Square in background
}

function renderLabelsPage() {
  const rows = [...cache.labels].sort((a,b)=>(a.Month||'')>(b.Month||'')?-1:1);
  // Summary bar
  const latest = rows[0];
  document.getElementById('labels-balance-num').textContent =
    latest ? (+latest.EndBalance).toLocaleString() : '—';
  document.getElementById('labels-value-num').textContent =
    latest && latest.TotalValue != null ? '$' + (+latest.TotalValue).toFixed(2) : '—';
  document.getElementById('labels-last-month').textContent =
    latest ? (latest.Month || '—') : 'None yet';

  // Reconcile hint — suggest running if we're on/after the 1st and no record for last month
  const now = new Date();
  const lastMonthLabel = new Date(now.getFullYear(), now.getMonth()-1, 1)
    .toLocaleDateString('en-US', {month:'long', year:'numeric'});
  const hasLastMonth = rows.some(r => r.Month === lastMonthLabel);
  const hint = document.getElementById('labels-reconcile-hint');
  if (!hasLastMonth && now.getDate() >= 1) {
    hint.textContent = `💡 ${lastMonthLabel} not reconciled yet`;
    hint.style.color = 'var(--gold)';
  } else {
    hint.textContent = '';
  }

  // Table
  const tbody = document.getElementById('labels-history-body');
  const empty = document.getElementById('labels-empty');
  if (!rows.length) { tbody.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display = 'none';
  tbody.innerHTML = rows.map(r => `<tr>
    <td><b>${escHtml(r.Month||'—')}</b></td>
    <td>${r.StartBalance != null ? (+r.StartBalance).toLocaleString() : '—'}</td>
    <td>${r.BagsSold != null ? (+r.BagsSold).toLocaleString() : '—'}</td>
    <td>${r.Adjustment != null ? (+r.Adjustment).toLocaleString() : '—'}</td>
    <td><b>${r.EndBalance != null ? (+r.EndBalance).toLocaleString() : '—'}</b></td>
    <td>${r.CostPerLabel != null ? '$'+parseFloat(r.CostPerLabel).toFixed(4) : '—'}</td>
    <td>${r.TotalValue != null ? '$'+parseFloat(r.TotalValue).toFixed(2) : '—'}</td>
    <td class="text-hint">${escHtml(r.Notes||'')}</td>
    <td class="text-hint">${escHtml(r.ReconcileBy||'')}</td>
  </tr>`).join('');
}

function openLabelsEntryModal() {
  // Pre-fill cost from last record
  const latest = [...cache.labels].sort((a,b)=>(a.Month||'')>(b.Month||'')?-1:1)[0];
  document.getElementById('labels-balance-input').value = '';
  document.getElementById('labels-cost-input').value = latest?.CostPerLabel ? parseFloat(latest.CostPerLabel).toFixed(4) : '';
  const now = new Date();
  document.getElementById('labels-date-input').value =
    now.toLocaleDateString('en-US', {month:'long', year:'numeric'});
  document.getElementById('labels-notes-input').value = '';
  openModal('modal-labels-entry');
}

async function saveLabelsEntry() {
  const bal = parseFloat(document.getElementById('labels-balance-input').value);
  const cost = parseFloat(document.getElementById('labels-cost-input').value) || 0;
  const month = document.getElementById('labels-date-input').value.trim();
  const notes = document.getElementById('labels-notes-input').value.trim();
  if (isNaN(bal) || bal < 0) { toast('err','Enter a valid balance'); return; }
  if (!month) { toast('err','Enter a month/date label'); return; }
  setLoading(true,'Saving…');
  try {
    const fields = {
      Title: month, Month: month,
      StartBalance: bal, EndBalance: bal,
      CostPerLabel: cost || null,
      TotalValue: cost > 0 ? +(bal * cost).toFixed(2) : null,
      Notes: notes,
      ReconcileBy: currentUser?.name || currentUser?.username || ''
    };
    const item = await addListItem(LISTS.labels, fields);
    cache.labels.push(item);
    renderLabelsPage();
    closeModal('modal-labels-entry');
    toast('ok','✓ Balance saved');
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}

// Pending reconcile data (set during preview, used on confirm)
let _labelsPendingReconcile = null;

async function openLabelsReconcileModal() {
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
    // Pull Square sales from the prior calendar month
    const startAt = lastMonthStart.toISOString();
    const endAt   = lastMonthEnd.toISOString();
    const locMap  = getSquareLocMap();
    const squareLocIds = Object.keys(locMap);

    let bagsSold = 0;
    const bagDetails = [];

    if (squareLocIds.length === 0) {
      body.innerHTML = '<div style="color:var(--orange);padding:12px 0;">⚠ No Square location mapping set up. Go to Square → Location Mapping first.</div>';
      return;
    }

    // Fetch orders from Square for prior month across all mapped locations
    body.innerHTML = '<div style="color:var(--muted);padding:4px 0;">Fetching Square sales…</div>';
    let cursor = null;
    const coffeeLineItems = [];
    do {
      const payload = {
        location_ids: squareLocIds,
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

    const adjustment = Math.ceil(bagsSold * 1.1); // bags sold + 10% buffer, rounded up
    const latest = [...cache.labels].sort((a,b)=>(a.Month||'')>(b.Month||'')?-1:1)[0];
    const startBal = latest ? parseFloat(latest.EndBalance || 0) : 0;
    const endBal   = Math.max(0, startBal - adjustment);
    const costPerLabel = latest?.CostPerLabel ? parseFloat(latest.CostPerLabel) : 0;
    const totalValue   = costPerLabel > 0 ? +(endBal * costPerLabel).toFixed(2) : null;

    _labelsPendingReconcile = {
      month: monthLabel, startBalance: startBal, bagsSold, adjustment,
      endBalance: endBal, costPerLabel: costPerLabel || null,
      totalValue, squareData: JSON.stringify(byName)
    };

    const breakdownRows = Object.entries(byName).sort(([,a],[,b])=>b-a)
      .map(([name,qty])=>`<tr><td style="padding:2px 8px;">${escHtml(name)}</td><td style="padding:2px 8px;text-align:right;">${qty}</td></tr>`).join('');

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
        <div style="background:var(--cream);border-radius:8px;padding:12px;">
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Month</div>
          <div style="font-weight:700">${escHtml(monthLabel)}</div>
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
  setLoading(true,'Saving reconciliation…');
  try {
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
    const item = await addListItem(LISTS.labels, fields);
    cache.labels.push(item);
    renderLabelsPage();
    closeModal('modal-labels-reconcile');
    toast('ok',`✓ ${d.month} reconciled — ${d.endBalance.toLocaleString()} labels remaining`);
    _labelsPendingReconcile = null;
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}
