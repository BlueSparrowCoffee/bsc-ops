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
  _renderDashBreadcrumb();
  // ── Accounting-only view: financial cards only, operational hidden ──
  // Owner/admin always sees the full dashboard. Pure accounting role gets
  // the inventory-value table + merch / bags / cogs summary cards.
  const acctOnly = (typeof isAccountingOnly === 'function') && isAccountingOnly();
  _applyAcctDashboardLayout(acctOnly);
  if (acctOnly) {
    renderInventoryValueByLocation();
    renderTransfersDashboardCard();
    renderAcctMerchCard();
    renderAcctBagsCard();
    renderAcctCogsCard();
    return;
  }

  const locInv = cache.inventory;
  const cm = getLatestCountsMap(currentLocation);
  const isAllLoc = (currentLocation === 'all');
  // Owner-on-all: render per-location breakdowns instead of the single "All OK"
  // placeholder. Other roles keep the existing single-location behavior.
  const ownerAllView = isAllLoc && (typeof isOwner === 'function') && isOwner();

  // Per-location low-stock map { loc → { list, cm } } for owner-on-all view.
  const lowByLoc = {};
  if (ownerAllView) {
    for (const loc of getLocations()) {
      const cmL = getLatestCountsMap(loc);
      const list = locInv.filter(i => {
        const thresh = invLowThreshold(i, loc);
        if (thresh == null || thresh <= 0) return false;
        const t = cmL[i.ItemName||'']?.total;
        if (t == null) return false;
        return t <= thresh;
      });
      if (list.length) lowByLoc[loc] = { list, cm: cmL };
    }
  }

  // Single-location low list (unchanged behavior for non-all / non-owner views).
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

  const totalLow = ownerAllView
    ? Object.values(lowByLoc).reduce((s,o) => s + o.list.length, 0)
    : low.length;
  document.getElementById('d-low').textContent = totalLow;
  document.getElementById('d-orders').textContent = pendingOrders.length;
  document.getElementById('d-checklist').textContent = `${done.length}/${todayTasks.length}`;
  // Inventory-items stat (PR 5) — total active consumable items across the
  // current location filter. Trend line stays static text for now; per-day
  // delta plumbing comes in a follow-up (would need a localStorage snapshot).
  const invEl = document.getElementById('d-inv-items');
  if (invEl) {
    const activeItems = (cache.inventory || []).filter(i => !i.Archived);
    invEl.textContent = activeItems.length;
  }

  // ── Per-location section renderer (used by alerts + orders cards) ──
  // When `clickable` is true, the location name acts as a link to that
  // location's consumable inventory filtered to Low/Out.
  const _locHeader = (loc, count, clickable) => {
    const nameHtml = clickable
      ? `<span data-loc="${escHtml(loc)}" onclick="event.stopPropagation();navLocationLowStock(this.dataset.loc)" style="cursor:pointer;color:var(--gold);text-decoration:underline dotted;" title="View low stock at ${escHtml(loc)}">${escHtml(loc)}</span>`
      : `<span>${escHtml(loc)}</span>`;
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0 6px;margin-top:6px;border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;">
        ${nameHtml}
        <span style="margin-left:auto;font-weight:600;color:var(--muted);">${count}</span>
      </div>`;
  };

  // alerts
  const alertsEl = document.getElementById('dash-alerts');
  const _lowItemHtml = (i, stock, par, locLabel) => `
    <div class="alert-item">
      <div class="alert-dot ${stock===0?'red':'orange'}"></div>
      <span class="alert-name">${escHtml(i.ItemName||'Unknown')}</span>
      ${locLabel ? `<span class="alert-loc">${escHtml(locLabel)}</span>` : ''}
      <span class="badge ${stock===0?'badge-red':'badge-orange'}" style="${locLabel?'margin-left:8px':'margin-left:auto'}">
        ${stock} / ${par} ${escHtml(i.Unit||'')}
      </span>
    </div>`;
  if (ownerAllView) {
    const locKeys = Object.keys(lowByLoc).sort();
    if (!locKeys.length) {
      alertsEl.innerHTML = '<div class="no-data" style="padding:16px">All stock levels OK ✓</div>';
    } else {
      alertsEl.innerHTML = locKeys.map(loc => {
        const { list, cm: cmL } = lowByLoc[loc];
        const items = list.slice(0,5).map(i => {
          const stock = cmL[i.ItemName||'']?.total ?? 0;
          const par   = (typeof getItemPar === 'function') ? (getItemPar(i, loc) ?? 0) : (i.ParLevel||0);
          return _lowItemHtml(i, stock, par, '');
        }).join('');
        const more = list.length > 5
          ? `<div style="font-size:11px;color:var(--muted);padding:4px 0 0;">+${list.length - 5} more</div>` : '';
        return _locHeader(loc, list.length, true) + items + more;
      }).join('');
    }
  } else if (!low.length) {
    alertsEl.innerHTML = '<div class="no-data" style="padding:16px">All stock levels OK ✓</div>';
  } else {
    alertsEl.innerHTML = low.slice(0,8).map(i => {
      const stock = cm[i.ItemName||'']?.total ?? 0;
      const loc   = cm[i.ItemName||'']?.location || i.Location || '';
      const par   = (typeof getItemPar === 'function') ? (getItemPar(i, currentLocation) ?? 0) : (i.ParLevel||0);
      return _lowItemHtml(i, stock, par, loc);
    }).join('');
  }

  // checklist preview (global — checklists have no Location field)
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
  const _orderRowHtml = (o) => `
    <div class="alert-item">
      <div class="alert-dot blue"></div>
      <span class="alert-name">${escHtml(o.Vendor||'Unknown')}</span>
      ${o.Location ? `<span class="alert-loc">${escHtml(o.Location)}</span>` : ''}
      <span class="badge badge-blue" style="${o.Location?'margin-left:8px':'margin-left:auto'}">${escHtml(o.Status)}</span>
    </div>`;
  if (ownerAllView) {
    if (!pendingOrders.length) {
      ordEl.innerHTML = '<div class="no-data" style="padding:16px">No pending orders</div>';
    } else {
      const byLoc = {};
      pendingOrders.forEach(o => {
        const loc = o.Location || 'Unassigned';
        (byLoc[loc] = byLoc[loc] || []).push(o);
      });
      const locKeys = Object.keys(byLoc).sort();
      ordEl.innerHTML = locKeys.map(loc => {
        const orders = byLoc[loc];
        const items = orders.slice(0,4).map(_orderRowHtml).join('');
        const more = orders.length > 4
          ? `<div style="font-size:11px;color:var(--muted);padding:4px 0 0;">+${orders.length - 4} more</div>` : '';
        return _locHeader(loc, orders.length) + items + more;
      }).join('');
    }
  } else if (!pendingOrders.length) {
    ordEl.innerHTML = '<div class="no-data" style="padding:16px">No pending orders</div>';
  } else {
    ordEl.innerHTML = pendingOrders.slice(0,5).map(_orderRowHtml).join('');
  }

  renderInventoryValueByLocation();
  renderTransfersDashboardCard();

  if (typeof renderClockedInCard === 'function') renderClockedInCard();

  updateMaintDashboard();
}

// Updates the dashboard page-header breadcrumb (location · day · time).
// Called from renderDashboard and the initial bootstrap. Keeps the location
// label in sync with currentLocation as the user clicks topbar location chips.
function _renderDashBreadcrumb() {
  const el = document.getElementById('dash-date');
  if (!el) return;
  const loc = (currentLocation === 'all' || !currentLocation) ? 'All locations' : currentLocation;
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
  const time = now.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'});
  el.innerHTML = `<b>${escHtml(loc)}</b> · ${escHtml(date)} · ${escHtml(time)}`;
}

// Stub for the dashboard "Export" header button. Full implementation deferred.
function exportDashboard() {
  if (typeof toast === 'function') toast('ok', 'Export coming soon — bug Jeff if you need this.');
}

// ── Transfer summary helpers (shared by dashboard card + transfer page) ──
// Bucket the per-transfer InventoryType into one of the 4 user-facing
// categories: Consumable, Merch, Equipment & Smallwares, Bags & Labels.
const TRANSFER_CATEGORIES = ['Consumable', 'Merch', 'Equipment & Smallwares', 'Bags & Labels'];
function _xferCategory(invType) {
  if (invType === 'merch')      return 'Merch';
  if (invType === 'equipment')  return 'Equipment & Smallwares';
  if (invType === 'retailBags' || invType === 'labels' || invType === 'fiveLbLabels') return 'Bags & Labels';
  return 'Consumable';
}

// Resolve current per-unit cost ($) for a transfer record by looking up
// the matching item master at render time. Bags/labels read the most-
// recent record's CostPerBag / CostPerLabel.
function _xferCostPerUnit(t) {
  const type = t.InventoryType || 'consumable';
  const name = (t.ItemName || '').trim();
  if (type === 'consumable' || type === 'equipment') {
    const items = type === 'consumable' ? (cache.inventory || []) : (cache.equipInventory || []);
    const item = items.find(i => (i.ItemName || '').trim() === name);
    if (!item) return 0;
    const cost = parseFloat(item.CostPerCase) || 0;
    const size = parseFloat(item.OrderSize) || 1;
    return cost / (size || 1);
  }
  if (type === 'merch') {
    const item = (cache.merchInventory || []).find(i => (i.ItemName || '').trim() === name);
    return item ? (parseFloat(item.CostPerUnit) || 0) : 0;
  }
  const field = type === 'retailBags' ? 'CostPerBag' : 'CostPerLabel';
  const recs = (cache[type] || []).filter(r => r[field] != null && r[field] !== '');
  if (!recs.length) return 0;
  const latest = [...recs].sort((a,b) => {
    const aT = a.Created ? new Date(a.Created).getTime() : 0;
    const bT = b.Created ? new Date(b.Created).getTime() : 0;
    return bT - aT;
  })[0];
  return parseFloat(latest[field]) || 0;
}

function _xferMonthKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function _xferMonthName(d) { return d.toLocaleDateString('en-US', {month:'long', year:'numeric'}); }
function _xferMoney(n) { return '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }

// Aggregate a list of transfers into category totals + per-route breakdown.
function _summarizeTransfers(transfers) {
  const byCategory = {};                  // cat → total $
  const byRoute    = {};                  // cat → { route → { count, total } }
  let total = 0, count = 0;
  for (const t of transfers) {
    const qty = parseFloat(t.Quantity) || 0;
    if (!qty) continue;
    const value = qty * _xferCostPerUnit(t);
    const cat   = _xferCategory(t.InventoryType);
    const route = `${t.FromLocation || '?'} → ${t.ToLocation || '?'}`;
    byCategory[cat] = (byCategory[cat] || 0) + value;
    if (!byRoute[cat]) byRoute[cat] = {};
    if (!byRoute[cat][route]) byRoute[cat][route] = { count: 0, total: 0 };
    byRoute[cat][route].count++;
    byRoute[cat][route].total += value;
    total += value;
    count++;
  }
  return { total, count, byCategory, byRoute };
}

// ── Owner/Accounting card: Transfer Summary ──────────────────────
// This-month total $ + per-category breakdown, with last-month total
// as a comparison line. Visible to owner OR accounting.
function renderTransfersDashboardCard() {
  const card = document.getElementById('dash-transfers-card');
  const body = document.getElementById('dash-transfers-body');
  if (!card || !body) return;
  if (typeof isOwnerOrAccounting !== 'function' || !isOwnerOrAccounting()) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  const transfers = cache.transfers || [];
  if (!transfers.length) {
    body.innerHTML = '<div class="no-data" style="padding:16px">No transfers yet</div>';
    return;
  }

  const now = new Date();
  const lastDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const thisKey  = _xferMonthKey(now);
  const lastKey  = _xferMonthKey(lastDate);
  const thisXfers = transfers.filter(t => t.Created && _xferMonthKey(new Date(t.Created)) === thisKey);
  const lastXfers = transfers.filter(t => t.Created && _xferMonthKey(new Date(t.Created)) === lastKey);
  const thisSum = _summarizeTransfers(thisXfers);
  const lastSum = _summarizeTransfers(lastXfers);

  const catRow = (cat) => {
    const v = thisSum.byCategory[cat] || 0;
    return `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;">
      <span style="color:var(--muted);">${escHtml(cat)}</span>
      <span style="font-weight:600;">${_xferMoney(v)}</span>
    </div>`;
  };

  body.innerHTML = `
    <div style="padding:4px 0 12px;border-bottom:1px solid var(--border);margin-bottom:10px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);">${escHtml(_xferMonthName(now))}</div>
      <div style="font-size:24px;font-weight:700;color:var(--dark-blue);line-height:1.2;">${_xferMoney(thisSum.total)}</div>
      <div style="font-size:12px;color:var(--muted);">${thisSum.count} transfer${thisSum.count===1?'':'s'}</div>
    </div>
    ${TRANSFER_CATEGORIES.map(catRow).join('')}
    <div style="padding-top:10px;margin-top:10px;border-top:1px solid var(--border);font-size:12px;color:var(--muted);display:flex;justify-content:space-between;">
      <span>${escHtml(_xferMonthName(lastDate))}</span>
      <span>${_xferMoney(lastSum.total)} · ${lastSum.count} transfer${lastSum.count===1?'':'s'}</span>
    </div>`;
}

// ── Page-top panel: Transfer Summary on the Transfers tab ────────
// Toggle pills (This Month / Last Month) drive a category-grouped
// table of routes (From → To) with transfer counts + dollar value.
// Owner/accounting only.
let _transferSummaryView = null; // 'this' | 'last' — lazy-init from localStorage
function _getTransferSummaryView() {
  if (_transferSummaryView != null) return _transferSummaryView;
  try { _transferSummaryView = localStorage.getItem('bsc_transfer_summary_view') || 'this'; }
  catch { _transferSummaryView = 'this'; }
  return _transferSummaryView;
}
function setTransferSummaryView(v) {
  _transferSummaryView = v;
  try { localStorage.setItem('bsc_transfer_summary_view', v); } catch {}
  renderTransferSummaryPanel();
}

function renderTransferSummaryPanel() {
  const el = document.getElementById('transfer-summary');
  if (!el) return;
  if (typeof isOwnerOrAccounting !== 'function' || !isOwnerOrAccounting()) {
    el.style.display = 'none'; return;
  }
  el.style.display = '';

  const transfers = cache.transfers || [];
  const now = new Date();
  const lastDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const view = _getTransferSummaryView();
  const target = view === 'last' ? lastDate : now;
  const targetKey  = _xferMonthKey(target);
  const targetName = _xferMonthName(target);

  const filtered = transfers.filter(t => t.Created && _xferMonthKey(new Date(t.Created)) === targetKey);
  const sum = _summarizeTransfers(filtered);

  const pillBtn = (key, label) => {
    const active = view === key;
    const bg     = active ? 'var(--dark-blue)' : 'var(--bg-card)';
    const color  = active ? '#fff' : 'var(--text)';
    return `<button type="button" data-view="${escHtml(key)}" onclick="setTransferSummaryView(this.dataset.view)" style="padding:6px 14px;border-radius:999px;border:1px solid var(--border);background:${bg};color:${color};cursor:pointer;font-size:12px;font-weight:600;">${escHtml(label)}</button>`;
  };

  let tbody = '';
  if (!filtered.length) {
    tbody = `<tr><td colspan="4" style="padding:14px;color:var(--muted);font-style:italic;text-align:center;">No transfers in ${escHtml(targetName)}</td></tr>`;
  } else {
    for (const cat of TRANSFER_CATEGORIES) {
      const routes = sum.byRoute[cat];
      if (!routes) continue;
      const sortedRoutes = Object.entries(routes).sort((a,b) => b[1].total - a[1].total);
      const catTotal = sum.byCategory[cat] || 0;
      const catCount = sortedRoutes.reduce((n, [,v]) => n + v.count, 0);
      sortedRoutes.forEach(([route, v], i) => {
        const catCell = i === 0
          ? `<td rowspan="${sortedRoutes.length + 1}" style="vertical-align:top;font-weight:600;color:var(--dark-blue);">${escHtml(cat)}</td>`
          : '';
        tbody += `<tr>${catCell}<td>${escHtml(route)}</td><td style="text-align:right;">${v.count}</td><td style="text-align:right;font-weight:600;">${_xferMoney(v.total)}</td></tr>`;
      });
      tbody += `<tr style="background:var(--cream);">
        <td style="padding:6px 8px;font-size:12px;color:var(--muted);text-align:right;">Subtotal</td>
        <td style="padding:6px 8px;text-align:right;font-size:12px;color:var(--muted);">${catCount}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:700;">${_xferMoney(catTotal)}</td>
      </tr>`;
    }
  }

  el.innerHTML = `
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
        <div class="card-title" style="margin:0;">🧮 Transfer Summary</div>
        <div style="display:flex;gap:6px;">
          ${pillBtn('this', _xferMonthName(now))}
          ${pillBtn('last', _xferMonthName(lastDate))}
        </div>
        <div class="ml-auto" style="font-size:13px;color:var(--muted);text-align:right;">
          <div><strong style="color:var(--dark-blue);font-size:22px;">${_xferMoney(sum.total)}</strong></div>
          <div style="font-size:12px;">${sum.count} transfer${sum.count===1?'':'s'}</div>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Category</th><th>From → To</th><th style="text-align:right;">Transfers</th><th style="text-align:right;">Value</th>
          </tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Per-location value helpers (module scope so accounting cards reuse) ──
// Lightweight per-location latest-counts reader that does NOT depend on
// invCfg()/current inventory tab. Returns { itemName → TotalCount }.
function _latestCountsByItem(countCache, loc) {
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
}
function _consumableValue(loc) {
  const counts = _latestCountsByItem(cache.countHistory || [], loc);
  return (cache.inventory || []).reduce((sum, i) => {
    if (i.Archived) return sum;
    const qty  = counts[i.ItemName || ''] || 0;
    const cost = i.CostPerCase || 0;
    const size = i.OrderSize   || 1;
    return sum + qty * (cost / (size || 1));
  }, 0);
}
function _merchValue(loc) {
  const counts = _latestCountsByItem(cache.merchCountHistory || [], loc);
  return (cache.merchInventory || []).reduce((sum, i) => {
    if (i.Archived) return sum;
    const qty  = counts[i.ItemName || ''] || 0;
    const cost = i.CostPerUnit || 0;
    return sum + qty * cost;
  }, 0);
}
// Equipment goes through the non-merch save path, so cost lives in
// CostPerCase + OrderSize (same shape as consumable). Falls back to
// CostPerUnit for any items that were saved with the merch shape.
function _equipmentValue(loc) {
  const counts = _latestCountsByItem(cache.equipCountHistory || [], loc);
  return (cache.equipInventory || []).reduce((sum, i) => {
    if (i.Archived) return sum;
    const qty  = counts[i.ItemName || ''] || 0;
    const cpc  = parseFloat(i.CostPerCase) || 0;
    const size = parseFloat(i.OrderSize)   || 1;
    const perUnit = cpc > 0 ? cpc / (size || 1) : (parseFloat(i.CostPerUnit) || 0);
    return sum + qty * perUnit;
  }, 0);
}
// Bags & Labels: latest monthly EndBalance × cost across the three sub-lists.
// Returns { labels, retailBags, fiveLbLabels, total } so callers can show
// the breakdown when needed.
function _bagLabelsBreakdown(loc) {
  const latestValueForLoc = (cacheKey) => {
    const rows = (cache[cacheKey] || []).filter(r => (r._loc || '') === loc);
    if (!rows.length) return 0;
    rows.sort((a,b) => {
      const am = a.Month||'', bm = b.Month||'';
      if (am !== bm) return am > bm ? -1 : 1;
      const ac = a.Created||'', bc = b.Created||'';
      if (ac !== bc) return ac > bc ? -1 : 1;
      return Number(b.id||0) - Number(a.id||0);
    });
    return parseFloat(rows[0].TotalValue) || 0;
  };
  const labels       = latestValueForLoc('labels');
  const retailBags   = latestValueForLoc('retailBags');
  const fiveLbLabels = latestValueForLoc('fiveLbLabels');
  return { labels, retailBags, fiveLbLabels, total: labels + retailBags + fiveLbLabels };
}
function _bagLabelsValue(loc) { return _bagLabelsBreakdown(loc).total; }

const _fmtMoney = n => '$' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ── Inventory Value by Location card (owner/accounting only) ─────
// Rows = each BSC location; cols = Consumables · Merch · Total.
// Grand-total row aggregates across all locations.
// Values = latest submitted counts × per-unit cost (consumables use
// CostPerCase ÷ OrderSize, merch uses CostPerUnit).
function renderInventoryValueByLocation() {
  const card = document.getElementById('dash-inv-value-card');
  if (!card) return;
  // Section divider rides along with the inventory-value card — visible
  // whenever owner/accounting content is on the page.
  const divider = document.getElementById('dash-acct-divider');
  if (!isOwnerOrAccounting()) {
    card.style.display = 'none';
    if (divider) divider.style.display = 'none';
    return;
  }
  card.style.display = '';
  if (divider) divider.style.display = '';

  const body = document.getElementById('dash-inv-value-body');
  if (!body) return;

  const locations = getLocations();
  const fmt = _fmtMoney;

  let totalC = 0, totalM = 0, totalE = 0, totalB = 0;
  const locRows = locations.map(loc => {
    const c = _consumableValue(loc);
    const m = _merchValue(loc);
    const e = _equipmentValue(loc);
    const b = _bagLabelsValue(loc);
    totalC += c; totalM += m; totalE += e; totalB += b;
    return `
      <tr>
        <td class="loc">${escHtml(loc)}</td>
        <td class="num">${fmt(c)}</td>
        <td class="num">${fmt(m)}</td>
        <td class="num">${fmt(e)}</td>
        <td class="num">${fmt(b)}</td>
        <td class="num total">${fmt(c + m + e + b)}</td>
      </tr>`;
  }).join('');

  const emptyRow = `<tr><td colspan="6" style="padding:12px;color:var(--muted);text-align:center;">No locations configured.</td></tr>`;

  body.innerHTML = `
    <div style="overflow-x:auto;">
      <table class="iv-table" style="min-width:560px;">
        <thead>
          <tr>
            <th>Location</th>
            <th class="num">Consumables</th>
            <th class="num">Merch</th>
            <th class="num">Equipment</th>
            <th class="num">Bags &amp; Labels</th>
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>
          ${locRows || emptyRow}
          <tr class="grand">
            <td class="loc">All Locations</td>
            <td class="num">${fmt(totalC)}</td>
            <td class="num">${fmt(totalM)}</td>
            <td class="num">${fmt(totalE)}</td>
            <td class="num">${fmt(totalB)}</td>
            <td class="num total">${fmt(totalC + totalM + totalE + totalB)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="iv-foot">
      <span>Based on latest submitted counts × per-unit cost. Visible to owner and accounting only.</span>
    </div>`;
}

// ── Accounting-only dashboard layout ─────────────────────────────
// Hides the operational stats row + cards (Low Stock, Pending Orders,
// Today's Checklist, Maintenance, Recent Orders) when an accounting-role
// user is on the dashboard, and reveals the three accounting summary
// cards. Owner/admin always sees the full layout.
function _applyAcctDashboardLayout(acctOnly) {
  const opsIds = [
    'dash-alerts', 'dash-checklist-preview', 'dash-orders',
    'dash-maint-alerts', 'dash-clocked-in-body'
  ];
  // Walk up to the .card wrapper for each operational body and toggle it.
  opsIds.forEach(id => {
    const el = document.getElementById(id);
    const card = el?.closest('.card');
    if (card) card.style.display = acctOnly ? 'none' : '';
  });
  // Top stats row
  const statsRow = document.querySelector('#page-dashboard .stats-row');
  if (statsRow) statsRow.style.display = acctOnly ? 'none' : '';
  // Accounting cards
  ['dash-acct-merch-card', 'dash-acct-bags-card', 'dash-acct-cogs-card'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = acctOnly ? '' : 'none';
  });
}

// ── Accounting card: Merch Inventory per location + total ────────
function renderAcctMerchCard() {
  const body = document.getElementById('dash-acct-merch-body');
  if (!body) return;
  const locations = getLocations();
  let grandTotal = 0;
  const rows = locations.map(loc => {
    const v = _merchValue(loc);
    grandTotal += v;
    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:6px 8px;font-weight:500;">${escHtml(loc)}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:600;">${_fmtMoney(v)}</td>
      </tr>`;
  }).join('');
  const skuCount = (cache.merchInventory || []).filter(i => !i.Archived).length;
  body.innerHTML = `
    <table style="width:100%;font-size:12px;border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:2px solid var(--border);color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em;">
          <th style="text-align:left;padding:6px 8px;">Location</th>
          <th style="text-align:right;padding:6px 8px;">Value</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="2" style="padding:12px;color:var(--muted);text-align:center;">No locations.</td></tr>`}
        <tr style="border-top:2px solid var(--border);background:var(--cream);font-weight:700;">
          <td style="padding:8px;">All Locations</td>
          <td style="padding:8px;text-align:right;">${_fmtMoney(grandTotal)}</td>
        </tr>
      </tbody>
    </table>
    <div style="margin-top:8px;font-size:11px;color:var(--muted);">${skuCount} active SKU${skuCount===1?'':'s'}</div>`;
}

// ── Accounting card: Bags & Labels per location + total ──────────
function renderAcctBagsCard() {
  const body = document.getElementById('dash-acct-bags-body');
  if (!body) return;
  const locations = getLocations();
  let grandTotal = 0;
  const rows = locations.map(loc => {
    const b = _bagLabelsBreakdown(loc);
    grandTotal += b.total;
    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:6px 8px;font-weight:500;">${escHtml(loc)}</td>
        <td style="padding:6px 8px;text-align:right;">${_fmtMoney(b.labels)}</td>
        <td style="padding:6px 8px;text-align:right;">${_fmtMoney(b.retailBags)}</td>
        <td style="padding:6px 8px;text-align:right;">${_fmtMoney(b.fiveLbLabels)}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:600;">${_fmtMoney(b.total)}</td>
      </tr>`;
  }).join('');
  body.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;font-size:12px;border-collapse:collapse;min-width:420px;">
        <thead>
          <tr style="border-bottom:2px solid var(--border);color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em;">
            <th style="text-align:left;padding:6px 8px;">Location</th>
            <th style="text-align:right;padding:6px 8px;">12oz Labels</th>
            <th style="text-align:right;padding:6px 8px;">Retail Bags</th>
            <th style="text-align:right;padding:6px 8px;">5LB Labels</th>
            <th style="text-align:right;padding:6px 8px;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="5" style="padding:12px;color:var(--muted);text-align:center;">No locations.</td></tr>`}
          <tr style="border-top:2px solid var(--border);background:var(--cream);font-weight:700;">
            <td style="padding:8px;">All Locations</td>
            <td colspan="3"></td>
            <td style="padding:8px;text-align:right;">${_fmtMoney(grandTotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

// ── Accounting card: COGs Overview (no target line) ──────────────
// Reuses the same item-build logic as renderCogsOverview() but skips the
// target threshold (per accounting card spec).
function renderAcctCogsCard() {
  const body = document.getElementById('dash-acct-cogs-body');
  if (!body) return;

  // Build the same items array the COGs Overview uses, minus filters/sort.
  const items = [];
  if (typeof buildCogMap === 'function') {
    const cogMap   = buildCogMap();
    const invMap   = buildInvMap();
    const invIdMap = buildInvIdMap();
    const prepMap  = buildPrepItemMap();
    (cache.menu || []).forEach(menuItem => {
      if ((menuItem.Category||'').toLowerCase() !== 'coffee bar') return;
      if (menuItem.Archived) return;
      const itemId = menuItem.SquareId || menuItem.id;
      const spId   = menuItem.id || itemId;
      const cardId = menuItem.SquareId || menuItem.id || itemId;
      const isHidden = (typeof _cogsHiddenIds !== 'undefined') &&
        (_cogsHiddenIds.has(spId) || _cogsHiddenIds.has(cardId));
      if (isHidden) return;
      const variations = (typeof getVariationNames === 'function') ? getVariationNames(menuItem) : [];
      for (const v of variations) {
        if (!v.price) continue;
        const { cog, hasMissingCost } = calcCog(itemId, v.name, cogMap, invMap, prepMap, invIdMap);
        if (hasMissingCost || !cog) continue;
        const margin = ((v.price - cog) / v.price) * 100;
        items.push({ name: menuItem.ItemName || menuItem.Title || itemId, margin, type: 'Coffee Bar' });
      }
    });
  }
  if (typeof INV_COG_CFG !== 'undefined') {
    for (const [tabKey, cfg] of Object.entries(INV_COG_CFG)) {
      const state = (typeof _invCogState !== 'undefined') ? _invCogState[tabKey] : null;
      const typeLabel = tabKey.charAt(0).toUpperCase() + tabKey.slice(1);
      (cache[cfg.cacheKey] || []).forEach(i => {
        if (i.Archived) return;
        if (state?.hiddenIds?.has(i.id)) return;
        const cost  = parseFloat(i.CostPerUnit);
        const price = parseFloat(i.SellingPrice);
        if (!cost || !price) return;
        const margin = ((price - cost) / price) * 100;
        items.push({ name: i.ItemName, margin, type: typeLabel });
      });
    }
  }

  if (!items.length) {
    body.innerHTML = '<div class="no-data" style="padding:16px">No COGs data yet — set Cost &amp; Price on items to populate.</div>';
    return;
  }

  const avg = items.reduce((s,i) => s + i.margin, 0) / items.length;
  const best  = items.reduce((b,i) => i.margin > (b?.margin ?? -Infinity) ? i : b, null);
  const worst = items.reduce((w,i) => i.margin < (w?.margin ??  Infinity) ? i : w, null);

  // Type breakdown (avg margin per type, count)
  const byType = {};
  items.forEach(i => {
    (byType[i.type] = byType[i.type] || []).push(i.margin);
  });
  const typeRows = Object.entries(byType)
    .sort((a,b) => a[0].localeCompare(b[0]))
    .map(([type, margins]) => {
      const a = margins.reduce((s,m)=>s+m,0) / margins.length;
      return `
        <tr style="border-bottom:1px solid var(--border);">
          <td style="padding:6px 8px;font-weight:500;">${escHtml(type)}</td>
          <td style="padding:6px 8px;text-align:right;">${margins.length}</td>
          <td style="padding:6px 8px;text-align:right;font-weight:600;color:${a>=50?'var(--good)':a>=30?'var(--warn)':'var(--bad)'};">${a.toFixed(1)}%</td>
        </tr>`;
    }).join('');

  body.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px;">
      <div style="padding:10px 12px;background:var(--cream);border-radius:8px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Total Items</div>
        <div style="font-size:22px;font-weight:700;">${items.length}</div>
      </div>
      <div style="padding:10px 12px;background:var(--cream);border-radius:8px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Avg Margin</div>
        <div style="font-size:22px;font-weight:700;">${avg.toFixed(1)}%</div>
      </div>
      <div style="padding:10px 12px;background:var(--cream);border-radius:8px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Best</div>
        <div style="font-size:14px;font-weight:600;color:var(--good);" title="${escHtml(best?.name||'')}">${best ? best.margin.toFixed(1)+'%' : '—'}</div>
        <div style="font-size:11px;color:var(--muted);" title="${escHtml(best?.name||'')}">${escHtml((best?.name||'').slice(0,24))}${(best?.name||'').length>24?'…':''}</div>
      </div>
      <div style="padding:10px 12px;background:var(--cream);border-radius:8px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Worst</div>
        <div style="font-size:14px;font-weight:600;color:var(--red);" title="${escHtml(worst?.name||'')}">${worst ? worst.margin.toFixed(1)+'%' : '—'}</div>
        <div style="font-size:11px;color:var(--muted);" title="${escHtml(worst?.name||'')}">${escHtml((worst?.name||'').slice(0,24))}${(worst?.name||'').length>24?'…':''}</div>
      </div>
    </div>
    <table style="width:100%;font-size:12px;border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:2px solid var(--border);color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em;">
          <th style="text-align:left;padding:6px 8px;">Category</th>
          <th style="text-align:right;padding:6px 8px;">Items</th>
          <th style="text-align:right;padding:6px 8px;">Avg Margin</th>
        </tr>
      </thead>
      <tbody>${typeRows}</tbody>
    </table>`;
}
