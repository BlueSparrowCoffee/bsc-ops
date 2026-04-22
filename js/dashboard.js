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
  const low = locInv.filter(i => (cm[i.ItemName||'']?.total??0) <= (i.ParLevel||0));
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
    return `
    <div class="alert-item">
      <div class="alert-dot ${stock===0?'red':'orange'}"></div>
      <span>${escHtml(i.ItemName||'Unknown')}</span>
      <span style="margin-left:auto;font-size:11px;color:var(--muted)">${escHtml(loc)}</span>
      <span class="badge ${stock===0?'badge-red':'badge-orange'}" style="margin-left:8px">
        ${stock} / ${i.ParLevel||0} ${escHtml(i.Unit||'')}
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

  updateMaintDashboard();
}
