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
  // ── Accounting-only view: financial cards only, operational hidden ──
  // Owner/admin always sees the full dashboard. Pure accounting role gets
  // the inventory-value table + merch / bags / cogs summary cards.
  const acctOnly = (typeof isAccountingOnly === 'function') && isAccountingOnly();
  _applyAcctDashboardLayout(acctOnly);
  if (acctOnly) {
    renderInventoryValueByLocation();
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

  // ── Per-location section renderer (used by alerts + orders cards) ──
  const _locHeader = (loc, count) => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0 6px;margin-top:6px;border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;">
      <span>${escHtml(loc)}</span>
      <span style="margin-left:auto;font-weight:600;color:var(--muted);">${count}</span>
    </div>`;

  // alerts
  const alertsEl = document.getElementById('dash-alerts');
  const _lowItemHtml = (i, stock, par, locLabel) => `
    <div class="alert-item">
      <div class="alert-dot ${stock===0?'red':'orange'}"></div>
      <span>${escHtml(i.ItemName||'Unknown')}</span>
      ${locLabel ? `<span style="margin-left:auto;font-size:11px;color:var(--muted)">${escHtml(locLabel)}</span>` : ''}
      <span class="badge ${stock===0?'badge-red':'badge-orange'}" style="margin-left:${locLabel?'8px':'auto'}">
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
        return _locHeader(loc, list.length) + items + more;
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
      <div class="alert-dot gold"></div>
      <span>${escHtml(o.Vendor||'Unknown')}</span>
      <span style="margin-left:auto"><span class="badge badge-gold">${escHtml(o.Status)}</span></span>
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

  updateMaintDashboard();
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
  if (!isOwnerOrAccounting()) { card.style.display = 'none'; return; }
  card.style.display = '';

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

// ── Accounting-only dashboard layout ─────────────────────────────
// Hides the operational stats row + cards (Low Stock, Pending Orders,
// Today's Checklist, Maintenance, Recent Orders) when an accounting-role
// user is on the dashboard, and reveals the three accounting summary
// cards. Owner/admin always sees the full layout.
function _applyAcctDashboardLayout(acctOnly) {
  const opsIds = [
    'dash-alerts', 'dash-checklist-preview', 'dash-orders',
    'dash-maint-alerts'
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

// ── Accounting card: Merch Inventory total only ──────────────────
function renderAcctMerchCard() {
  const body = document.getElementById('dash-acct-merch-body');
  if (!body) return;
  const locations = getLocations();
  const total = locations.reduce((s, loc) => s + _merchValue(loc), 0);
  const skuCount = (cache.merchInventory || []).filter(i => !i.Archived).length;
  body.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:10px;">
      <div style="font-size:28px;font-weight:700;color:var(--dark-blue);">${_fmtMoney(total)}</div>
      <div style="font-size:12px;color:var(--muted);">total inventory value across ${locations.length} location${locations.length===1?'':'s'}</div>
    </div>
    <div style="margin-top:8px;font-size:12px;color:var(--muted);">${skuCount} active SKU${skuCount===1?'':'s'}</div>`;
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
          <td style="padding:6px 8px;text-align:right;font-weight:600;color:${a>=50?'#16a34a':a>=30?'#d97706':'var(--red)'};">${a.toFixed(1)}%</td>
        </tr>`;
    }).join('');

  body.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px;">
      <div style="padding:10px 12px;background:var(--cream);border-radius:8px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Total Items</div>
        <div style="font-size:20px;font-weight:700;">${items.length}</div>
      </div>
      <div style="padding:10px 12px;background:var(--cream);border-radius:8px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Avg Margin</div>
        <div style="font-size:20px;font-weight:700;">${avg.toFixed(1)}%</div>
      </div>
      <div style="padding:10px 12px;background:var(--cream);border-radius:8px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Best</div>
        <div style="font-size:14px;font-weight:600;color:#16a34a;" title="${escHtml(best?.name||'')}">${best ? best.margin.toFixed(1)+'%' : '—'}</div>
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
