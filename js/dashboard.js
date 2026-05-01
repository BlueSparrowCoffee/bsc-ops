/* ================================================================
 * BSC Ops — dashboard.js
 * Dashboard page render — summary cards, low-stock alerts, today's
 * checklist progress bar, recent orders, maintenance summary.
 *
 * Reads cache.inventory, cache.orders, cache.checklists,
 * cache.clProgress, plus per-location count history via
 * getLatestCountsMap(). updateMaintDashboard() fills in the
 * maintenance summary card — it still lives in index.html (will
 * move to js/maintenance.js later).
 *
 * Depends on:
 *   - state.js (cache, currentLocation)
 *   - utils.js (escHtml)
 *   - index.html globals resolved at call time:
 *     getLatestCountsMap, updateMaintDashboard
 * ================================================================ */
function renderDashboard() {
  const locInv = cache.inventory;
  const cm = getLatestCountsMap(currentLocation);
  // Low-stock alerts only make sense for a specific location; on 'all' we show
  // the "all OK" placeholder rather than falsely flagging everything.
  const isAllLoc = (currentLocation === 'all');
  // Low alert: only items that have BOTH a count and a threshold. Items with
  // no count or no par are "Untracked" and excluded.
  const low = isAllLoc ? [] : locInv.filter(i => {
    const thresh = invLowThreshold(i, currentLocation);
    if (thresh == null || thresh <= 0) return false;
    const t = cm[i.ItemName||'']?.total;
    if (t == null) return false;
    return t <= thresh;
  });
  const pendingOrders = cache.orders.filter(o=>o.Status==='Pending'||o.Status==='Ordered');
  const todayTasks = cache.checklists.filter(c=>c.Frequency==='Daily');
  const done = todayTasks.filter(t => cache.clProgress[t.id]);

  document.getElementById('d-inventory').textContent = locInv.length;
  document.getElementById('d-low').textContent = low.length;
  document.getElementById('d-orders').textContent = pendingOrders.length;
  document.getElementById('d-checklist').textContent = `${done.length}/${todayTasks.length}`;

  // alerts
  const alertsEl = document.getElementById('dash-alerts');
  if (!low.length) { alertsEl.innerHTML = '<div class="no-data" style="padding:16px">All stock levels OK ✓</div>'; }
  else alertsEl.innerHTML = low.slice(0,8).map(i=>{
    const stock = cm[i.ItemName||'']?.total??0;
    const loc   = cm[i.ItemName||'']?.location||i.Location||'';
    const par   = (typeof getItemPar === 'function') ? (getItemPar(i, currentLocation) ?? 0) : (i.ParLevel||0);
    return `
    <div class="alert-item">
      <div class="alert-dot ${stock===0?'red':'orange'}"></div>
      <span>${escHtml(i.ItemName||'Unknown')}</span>
      <span style="margin-left:auto;font-size:11px;color:var(--muted)">${escHtml(loc)}</span>
      <span class="badge ${stock===0?'badge-red':'badge-orange'}" style="margin-left:8px">
        ${stock} / ${par} ${escHtml(i.Unit||'')}
      </span>
    </div>`;
  }).join('');

  // checklist preview
  const clEl = document.getElementById('dash-checklist-preview');
  if (!todayTasks.length) { clEl.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:8px 0">No daily tasks configured yet.</div>'; }
  else {
    const pct = todayTasks.length ? Math.round(done.length/todayTasks.length*100) : 0;
    clEl.innerHTML = `
      <div class="progress-wrap"><div class="progress-bar ${pct===100?'complete':''}" style="width:${pct}%"></div></div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">${done.length} of ${todayTasks.length} tasks complete · ${pct}%</div>`;
  }

  // recent orders
  const ordEl = document.getElementById('dash-orders');
  if (!pendingOrders.length) { ordEl.innerHTML = '<div class="no-data" style="padding:16px">No pending orders</div>'; }
  else ordEl.innerHTML = pendingOrders.slice(0,5).map(o=>`
    <div class="alert-item">
      <div class="alert-dot gold"></div>
      <span>${escHtml(o.Vendor||'Unknown')}</span>
      <span style="margin-left:auto"><span class="badge badge-gold">${escHtml(o.Status)}</span></span>
    </div>`).join('');

  renderInventoryValueByLocation();

  updateMaintDashboard();
}

// ── Inventory Value by Location card (owner/accounting only) ─────
// Rows = each BSC location; cols = Consumables · Merch · Total.
// Grand-total row aggregates across all locations.
// Values = latest submitted counts × per-unit cost (consumables use
// CostPerCase ÷ OrderSize, merch uses CostPerUnit).
function renderInventoryValueByLocation() {
  const card = document.getElementById('dash-inv-value-card');
  if (!card) return;
  if (!isOwnerOrAccounting()) { card.style.display = 'none'; return; }
  card.style.display = '';

  const body = document.getElementById('dash-inv-value-body');
  if (!body) return;

  const locations = getLocations();

  // Lightweight per-location latest-counts reader that does NOT depend on
  // invCfg()/current inventory tab. Returns { itemName → TotalCount }.
  const latestCountsByItem = (countCache, loc) => {
    const filtered = (!loc || loc === 'all') ? countCache : countCache.filter(r => r.Location === loc);
    const map = {};
    [...filtered].sort((a,b) => {
      const aw = a.WeekOf||'', bw = b.WeekOf||'';
      return aw < bw ? -1 : aw > bw ? 1 : 0;
    }).forEach(r => {
      const name = (r.Title || r.ItemName || '').trim();
      if (name) map[name] = r.TotalCount || 0;
    });
    return map;
  };

  const consumableValue = (loc) => {
    const counts = latestCountsByItem(cache.countHistory || [], loc);
    return (cache.inventory || []).reduce((sum, i) => {
      if (i.Archived) return sum;
      const qty  = counts[i.ItemName || ''] || 0;
      const cost = i.CostPerCase || 0;
      const size = i.OrderSize   || 1;
      return sum + qty * (cost / (size || 1));
    }, 0);
  };

  const merchValue = (loc) => {
    const counts = latestCountsByItem(cache.merchCountHistory || [], loc);
    return (cache.merchInventory || []).reduce((sum, i) => {
      if (i.Archived) return sum;
      const qty  = counts[i.ItemName || ''] || 0;
      const cost = i.CostPerUnit || 0;
      return sum + qty * cost;
    }, 0);
  };

  const equipmentValue = (loc) => {
    const counts = latestCountsByItem(cache.equipCountHistory || [], loc);
    return (cache.equipInventory || []).reduce((sum, i) => {
      if (i.Archived) return sum;
      const qty  = counts[i.ItemName || ''] || 0;
      const cost = i.CostPerUnit || 0;
      return sum + qty * cost;
    }, 0);
  };

  // Bags & Labels: latest monthly EndBalance × cost across the three sub-lists.
  // TotalValue is persisted at save time as (EndBalance × CostPer*), so just
  // sum the most recent record per location per sub-type.
  const bagLabelsValue = (loc) => {
    const latestValueForLoc = (cacheKey) => {
      const rows = (cache[cacheKey] || []).filter(r => (r._loc || '') === loc);
      if (!rows.length) return 0;
      // Sort: Month desc → Created desc → id desc (matches the bag modules)
      rows.sort((a,b) => {
        const am = a.Month||'', bm = b.Month||'';
        if (am !== bm) return am > bm ? -1 : 1;
        const ac = a.Created||'', bc = b.Created||'';
        if (ac !== bc) return ac > bc ? -1 : 1;
        return Number(b.id||0) - Number(a.id||0);
      });
      return parseFloat(rows[0].TotalValue) || 0;
    };
    return latestValueForLoc('labels')
         + latestValueForLoc('retailBags')
         + latestValueForLoc('fiveLbLabels');
  };

  const fmt = n => '$' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  let totalC = 0, totalM = 0, totalE = 0, totalB = 0;
  const locRows = locations.map(loc => {
    const c = consumableValue(loc);
    const m = merchValue(loc);
    const e = equipmentValue(loc);
    const b = bagLabelsValue(loc);
    totalC += c; totalM += m; totalE += e; totalB += b;
    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px 10px;font-weight:500">${escHtml(loc)}</td>
        <td style="padding:8px 10px;text-align:right">${fmt(c)}</td>
        <td style="padding:8px 10px;text-align:right">${fmt(m)}</td>
        <td style="padding:8px 10px;text-align:right">${fmt(e)}</td>
        <td style="padding:8px 10px;text-align:right">${fmt(b)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:600">${fmt(c + m + e + b)}</td>
      </tr>`;
  }).join('');

  body.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;min-width:560px;">
        <thead>
          <tr style="border-bottom:2px solid var(--border);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;">
            <th style="text-align:left;padding:8px 10px;">Location</th>
            <th style="text-align:right;padding:8px 10px;">Consumables</th>
            <th style="text-align:right;padding:8px 10px;">Merch</th>
            <th style="text-align:right;padding:8px 10px;">Equipment</th>
            <th style="text-align:right;padding:8px 10px;">Bags &amp; Labels</th>
            <th style="text-align:right;padding:8px 10px;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${locRows || `<tr><td colspan="6" style="padding:12px;color:var(--muted);text-align:center;">No locations configured.</td></tr>`}
          <tr style="border-top:2px solid var(--border);background:var(--cream);font-weight:700;">
            <td style="padding:10px;">All Locations</td>
            <td style="padding:10px;text-align:right;">${fmt(totalC)}</td>
            <td style="padding:10px;text-align:right;">${fmt(totalM)}</td>
            <td style="padding:10px;text-align:right;">${fmt(totalE)}</td>
            <td style="padding:10px;text-align:right;">${fmt(totalB)}</td>
            <td style="padding:10px;text-align:right;">${fmt(totalC + totalM + totalE + totalB)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
}
