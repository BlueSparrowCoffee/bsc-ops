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
  const low = isAllLoc ? [] : locInv.filter(i => {
    const thresh = invLowThreshold(i, currentLocation);
    if (thresh == null) return false;
    return (cm[i.ItemName||'']?.total??0) <= thresh;
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

  const fmt = n => '$' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  let totalC = 0, totalM = 0;
  const locRows = locations.map(loc => {
    const c = consumableValue(loc);
    const m = merchValue(loc);
    totalC += c; totalM += m;
    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px 10px;font-weight:500">${escHtml(loc)}</td>
        <td style="padding:8px 10px;text-align:right">${fmt(c)}</td>
        <td style="padding:8px 10px;text-align:right">${fmt(m)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:600">${fmt(c + m)}</td>
      </tr>`;
  }).join('');

  body.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;font-size:13px;border-collapse:collapse;min-width:420px;">
        <thead>
          <tr style="border-bottom:2px solid var(--border);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;">
            <th style="text-align:left;padding:8px 10px;">Location</th>
            <th style="text-align:right;padding:8px 10px;">Consumables</th>
            <th style="text-align:right;padding:8px 10px;">Merch</th>
            <th style="text-align:right;padding:8px 10px;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${locRows || `<tr><td colspan="4" style="padding:12px;color:var(--muted);text-align:center;">No locations configured.</td></tr>`}
          <tr style="border-top:2px solid var(--border);background:var(--cream);font-weight:700;">
            <td style="padding:10px;">All Locations</td>
            <td style="padding:10px;text-align:right;">${fmt(totalC)}</td>
            <td style="padding:10px;text-align:right;">${fmt(totalM)}</td>
            <td style="padding:10px;text-align:right;">${fmt(totalC + totalM)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
}
