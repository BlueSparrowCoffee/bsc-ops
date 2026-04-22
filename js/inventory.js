/* ================================================================
 * BSC Ops — inventory.js (core)
 * Inventory page: type/tab switching, main item rendering, filter,
 * sort, latest-counts map, and nav-into-inventory helpers.
 *
 * Step 11a of a multi-step inventory extraction. The add/edit form,
 * counts submission, food pars, bag labels, and pastries/sandwiches
 * sync remain in index.html for now and will move in later steps:
 *   - js/inventory-form.js  (openAddInvForm, openEditInvItem,
 *                            saveInventoryItem, toggleArchiveInvItem,
 *                            populateInvVendorSelect, etc.)
 *   - js/inventory-counts.js (submitWeeklyCount, submitMerchCount,
 *                             renderCountSheet, renderMerchCountSheet)
 *   - js/food-pars.js
 *   - js/bag-labels.js
 *   - js/pastries-sync.js
 *
 * Three inventory types share this file:
 *   consumable → BSC_Inventory        (cache.inventory)
 *   merch      → BSC_MerchInventory   (cache.merchInventory)
 *   equipment  → BSC_EquipInventory   (cache.equipInventory)
 *
 * Plus five special non-inventory-type tabs accessed via
 * switchInvType() but routed to their own panels: labels, transfers,
 * pastries, sandwiches, and the food-pars panels for pastries/sandwiches.
 * invCfg() returns null for those — every render path must guard.
 *
 * Depends on:
 *   - state.js (cache, currentLocation)
 *   - constants.js (INV_TYPE_CFG, LISTS)
 *   - utils.js (escHtml, toast)
 *   - nav.js (nav)
 *   - tags.js (renderTagPills)
 *   - index.html globals resolved at call time:
 *     isOwnerOrAccounting, isOwner, renderMerchCountSheet,
 *     renderCountSheet, renderInventoryAnalytics, initImportTab,
 *     renderMerchMonthlyCost, populateTransferItemSelect,
 *     renderTransfers, renderLabelsInTab, renderFoodParsInTab,
 *     filterVendors, saveMerchReceivedItem, editMerchReceivedNotes,
 *     openEditInvItem, toggleArchiveInvItem, deleteInvItem
 * ================================================================ */

// ── Module-level state ───────────────────────────────────────────
let _invActiveTab = 'items';
let _invType      = 'consumable'; // 'consumable' | 'merch' | 'equipment'
let _invSort      = { col: null, dir: 1 };

// ── Type / config helpers ────────────────────────────────────────
function invCfg()         { return INV_TYPE_CFG[_invType]; }
function invHasCategory() { return invCfg()?.hasCategory !== false; }

function applyInvCategoryVisibility() {
  const cfg = invCfg();
  const isMerch = !!(cfg?.isMerch);
  const show = invHasCategory();
  const th = document.getElementById('inv-th-category');
  const filter = document.getElementById('inv-cat-filter');
  const catGroup = document.getElementById('new-item-cat-group');
  if (th)       th.style.display       = show ? '' : 'none';
  if (filter)   filter.style.display   = show ? '' : 'none';
  if (catGroup) catGroup.style.display = show ? '' : 'none';

  // Show/hide supplier filter (not relevant for merch)
  const supFilter = document.getElementById('inv-supplier-filter');
  if (supFilter) supFilter.style.display = isMerch ? 'none' : '';
  const statusFilter = document.getElementById('inv-status-filter');
  if (statusFilter) statusFilter.style.display = isMerch ? 'none' : '';

  // Show/hide consumable vs merch modal fields
  document.querySelectorAll('.inv-cons-only').forEach(el => el.style.display = isMerch ? 'none' : '');
  document.querySelectorAll('.inv-merch-only').forEach(el => el.style.display = isMerch ? '' : 'none');

  renderInvTableHeader();
}

function renderInvTableHeader() {
  const tr = document.getElementById('inv-thead-row');
  if (!tr) return;
  const cfg = invCfg();
  const isMerch = !!(cfg?.isMerch);
  if (isMerch) {
    tr.innerHTML = `
      <th onclick="sortInvBy('ItemNo')" style="width:80px">Item #</th>
      <th onclick="sortInvBy('ItemName')">Name</th>
      <th id="inv-th-category" onclick="sortInvBy('Category')">Category</th>
      <th onclick="sortInvBy('CostPerUnit')">Cost/Unit</th>
      <th onclick="sortInvBy('StoreCount')">Store</th>
      <th onclick="sortInvBy('StorageCount')">Storage</th>
      <th onclick="sortInvBy('TotalCount')">Total</th>
      <th onclick="sortInvBy('TotalValue')">Value</th>
      <th style="min-width:90px">Received</th>
      <th style="width:72px"></th>`;
  } else {
    tr.innerHTML = `
      <th onclick="sortInvBy('ItemName')">Item</th>
      <th id="inv-th-category" onclick="sortInvBy('Category')">Category</th>
      <th onclick="sortInvBy('Supplier')">Vendor</th>
      <th onclick="sortInvBy('ParLevel')">Par</th>
      <th onclick="sortInvBy('StoreCount')">Store</th>
      <th onclick="sortInvBy('StorageCount')">Storage</th>
      <th onclick="sortInvBy('CurrentStock')">Total</th>
      <th>Status</th>
      <th onclick="sortInvBy('CostPerCase')">Cost/Case</th>
      <th onclick="sortInvBy('CostPerServing')">Cost/Serving</th>
      <th onclick="sortInvBy('ServingsPerUnit')">Servings/Unit</th>
      <th style="width:72px"></th>`;
    // re-apply category column visibility for non-merch
    const th = document.getElementById('inv-th-category');
    if (th) th.style.display = invHasCategory() ? '' : 'none';
  }
}

// ── Top-level type switch (consumable/merch/equipment/special) ──
function switchInvType(type) {
  _invType = type;
  document.querySelectorAll('#inv-type-tabs .inv-type-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });

  const tabBar    = document.querySelector('#page-inventory .tab-bar');
  const labelsEl  = document.getElementById('inv-tab-labels');
  const foodParsEl = document.getElementById('inv-tab-foodpars');
  const titleEl   = document.querySelector('#page-inventory .page-title');

  const transfersEl    = document.getElementById('inv-tab-transfers');
  const monthlyTabBtn  = document.getElementById('inv-monthly-tab-btn');
  const hideAllSpecial = () => {
    if (labelsEl)    labelsEl.style.display    = 'none';
    if (foodParsEl)  foodParsEl.style.display  = 'none';
    if (transfersEl) transfersEl.style.display = 'none';
  };

  // Monthly Cost tab only visible on Merch
  if (monthlyTabBtn) monthlyTabBtn.style.display = (type === 'merch') ? '' : 'none';

  if (type === 'labels') {
    if (!isOwnerOrAccounting()) { toast('err','Access restricted to owner and accounting roles'); return; }
    if (tabBar) tabBar.style.display = 'none';
    ['items','count','analytics','import','monthly'].forEach(t => {
      const el = document.getElementById('inv-tab-'+t);
      if (el) el.style.display = 'none';
    });
    hideAllSpecial();
    if (labelsEl) labelsEl.style.display = '';
    if (titleEl) titleEl.textContent = '🏷️ Bag Labels';
    renderLabelsInTab();
  } else if (type === 'transfers') {
    if (tabBar) tabBar.style.display = 'none';
    ['items','count','analytics','import','monthly'].forEach(t => {
      const el = document.getElementById('inv-tab-'+t);
      if (el) el.style.display = 'none';
    });
    hideAllSpecial();
    document.getElementById('inv-tab-transfers').style.display = '';
    if (titleEl) titleEl.textContent = '🔄 Transfers';
    populateTransferItemSelect();
    renderTransfers();
  } else if (type === 'pastries' || type === 'sandwiches') {
    if (tabBar) tabBar.style.display = 'none';
    ['items','count','analytics','import','monthly'].forEach(t => {
      const el = document.getElementById('inv-tab-'+t);
      if (el) el.style.display = 'none';
    });
    hideAllSpecial();
    if (foodParsEl) foodParsEl.style.display = '';
    if (titleEl) titleEl.textContent = type === 'pastries' ? '🥐 Pastry Pars' : '🥪 Sandwich Pars';
    renderFoodParsInTab(type);
  } else {
    // Standard inventory type — show tab bar, hide special panels
    if (tabBar) tabBar.style.display = '';
    hideAllSpecial();
    const cfg = INV_TYPE_CFG[type];
    if (titleEl && cfg) titleEl.textContent = cfg.icon + ' ' + cfg.label;
    // Remove analytics tab for merch; restore it for other types
    const tabBarEl = document.querySelector('#page-inventory .tab-bar');
    const analyticsBtn = tabBarEl?.querySelector('.tab-btn[onclick*="analytics"]');
    if (type === 'merch') {
      if (analyticsBtn) analyticsBtn.remove();
    } else if (tabBarEl && !tabBarEl.querySelector('.tab-btn[onclick*="analytics"]')) {
      const importBtn = tabBarEl.querySelector('.tab-btn[onclick*="import"]');
      const btn = document.createElement('button');
      btn.className = 'tab-btn';
      btn.setAttribute('onclick', "switchInvTab('analytics',this)");
      btn.textContent = '📊 Analytics';
      if (importBtn) tabBarEl.insertBefore(btn, importBtn);
      else tabBarEl.appendChild(btn);
    }
    // Reset to items tab
    _invActiveTab = 'items';
    document.querySelectorAll('#page-inventory .tab-bar .tab-btn').forEach(b => b.classList.toggle('active', b.textContent.trim() === '📋 Items'));
    ['items','count','analytics','import','monthly'].forEach(t => {
      const el = document.getElementById('inv-tab-'+t);
      if (el) el.style.display = t==='items' ? '' : 'none';
    });
    applyInvCategoryVisibility();
    renderInventory();
  }
}

// ── Sub-tab switch within the items/count/analytics/import/monthly bar ─
function switchInvTab(tab, btn) {
  if (tab === 'monthly' && !isOwnerOrAccounting()) {
    toast('err','Access restricted to owner and accounting roles'); return;
  }
  _invActiveTab = tab;
  document.querySelectorAll('#page-inventory .tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  ['items','count','analytics','import','monthly'].forEach(t => {
    const el = document.getElementById('inv-tab-'+t);
    if (el) el.style.display = t===tab ? '' : 'none';
  });
  if (tab==='count')     { if (invCfg()?.isMerch) renderMerchCountSheet(); else renderCountSheet(); }
  if (tab==='analytics') renderInventoryAnalytics();
  if (tab==='import')    initImportTab();
  if (tab==='monthly')   renderMerchMonthlyCost();
}

// ── Main render + sort + filter ─────────────────────────────────
function renderInventory() {
  renderInventoryItems(
    document.getElementById('inv-search-input')?.value||'',
    document.getElementById('inv-cat-filter')?.value||'',
    document.getElementById('inv-status-filter')?.value||'',
    document.getElementById('inv-supplier-filter')?.value||''
  );
  // Also refresh count sheet if that tab is currently open
  if (_invActiveTab === 'count') { if (invCfg()?.isMerch) renderMerchCountSheet(); else renderCountSheet(); }
}

function sortInvBy(col) {
  if (_invSort.col === col) { _invSort.dir *= -1; }
  else { _invSort.col = col; _invSort.dir = 1; }
  // update header indicators
  document.querySelectorAll('#inv-tab-items thead th').forEach(th => {
    th.classList.remove('sort-asc','sort-desc');
    if (th.getAttribute('onclick') === `sortInvBy('${col}')`) {
      th.classList.add(_invSort.dir === 1 ? 'sort-asc' : 'sort-desc');
    }
  });
  renderInventoryItems(
    document.getElementById('inv-search-input')?.value||'',
    document.getElementById('inv-cat-filter')?.value||'',
    document.getElementById('inv-status-filter')?.value||''
  );
}

function renderInventoryItems(query='', catFilter='', statusFilter='', supplierFilter='') {
  const cfg = invCfg();
  if (!cfg) return; // non-inventory type (food pars, labels, transfers)

  if (cfg.isMerch) {
    renderMerchInventoryItems(query, catFilter);
    return;
  }

  const countsMap = getLatestCountsMap(currentLocation);
  const showArchived = document.getElementById('inv-show-archived')?.checked || false;
  let items = cache[cfg.cacheKey] || [];
  if (!showArchived) items = items.filter(i => !i.Archived);
  if (query) items = items.filter(i=>(i.ItemName||'').toLowerCase().includes(query.toLowerCase())||
    (i.Category||'').toLowerCase().includes(query.toLowerCase())||
    (i.Supplier||'').toLowerCase().includes(query.toLowerCase()));
  if (catFilter)      items = items.filter(i=>i.Category===catFilter);
  if (supplierFilter) items = items.filter(i=>(i.Supplier||'')===supplierFilter);
  if (statusFilter==='low') items = items.filter(i=>(countsMap[i.ItemName||'']?.total??0)<(i.ParLevel||0)*0.7);
  if (statusFilter==='ok')  items = items.filter(i=>(countsMap[i.ItemName||'']?.total??0)>=(i.ParLevel||0)*0.7);

  if (_invSort.col) {
    items = [...items].sort((a,b) => {
      const av = a[_invSort.col], bv = b[_invSort.col];
      if (av==null && bv==null) return 0;
      if (av==null) return 1; if (bv==null) return -1;
      return (typeof av==='string' ? av.localeCompare(bv) : av-bv) * _invSort.dir;
    });
  } else {
    items = [...items].sort((a,b) => (a.ItemName||'').localeCompare(b.ItemName||''));
  }

  const tbody = document.getElementById('inv-body');
  tbody.innerHTML = items.map(i => {
    const store   = (countsMap[i.ItemName||'']?.store??'—');
    const storage = (countsMap[i.ItemName||'']?.storage??'—');
    const total   = (countsMap[i.ItemName||'']?.total??'—');
    const totalNum = (countsMap[i.ItemName||'']?.total??null);
    const par     = i.ParLevel||0;
    const badge   = totalNum===null?'badge-gray':totalNum===0?'badge-red':totalNum<par*0.7?'badge-orange':'badge-green';
    const status  = totalNum===null?'—':totalNum===0?'Out':totalNum<par*0.7?'Low':'OK';
    const unit    = escHtml(i.OrderUnit||i.Unit||'');
    const costCase    = i.CostPerCase    != null ? '$'+Number(i.CostPerCase).toFixed(2)    : '—';
    const costServing = i.CostPerServing != null ? '$'+Number(i.CostPerServing).toFixed(4) : '—';
    const servings    = i.ServingsPerUnit!= null ? Number(i.ServingsPerUnit).toLocaleString()+' '+escHtml(i.ServingUnit||'')  : '—';
    return `<tr data-inv-id="${escHtml(i.id)}" onclick="openEditInvItem('${escHtml(i.id)}')" style="cursor:pointer;${i.Archived?'opacity:.45;':''}">
      <td class="fw">${escHtml(i.ItemName||'—')}${i.SquareId?'<span class="sq-badge" title="Synced with Square">SQ</span>':''}${i.Archived?'<span style="font-size:10px;background:var(--muted);color:#fff;padding:1px 5px;border-radius:8px;margin-left:4px;">archived</span>':''}${i.Tags?renderTagPills(i.Tags):''}</td>
      ${invHasCategory() ? `<td><span class="badge badge-teal">${escHtml(i.Category||'—')}</span></td>` : ''}
      <td style="font-size:12px">${i.Supplier ? `<a href="#" data-supplier="${escHtml(i.Supplier||'')}" onclick="event.stopPropagation();nav('vendors');setTimeout(()=>{const s=document.querySelector('#page-vendors .search-input');if(s){s.value=this.dataset.supplier;filterVendors(s.value);}},300);return false;" style="color:var(--gold);text-decoration:none;">${escHtml(i.Supplier)}</a>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td><div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;"><span style="text-align:right;">${par}</span><span style="font-size:11px;color:var(--muted);width:44px;text-align:left;">${unit}</span></div></td>
      <td>${store}</td>
      <td>${storage}</td>
      <td style="font-weight:600">${total}</td>
      <td><span class="badge ${badge}">${status}</span></td>
      <td>${costCase}</td>
      <td style="font-size:12px">${costServing}</td>
      <td style="font-size:12px;color:var(--muted)">${servings}</td>
    </tr>`;
  }).join('');

  document.getElementById('inv-empty').style.display = items.length?'none':'block';
  document.getElementById('inv-count').textContent = `${items.length} items`;

  const allItems = cache[cfg.cacheKey] || [];
  const catSel = document.getElementById('inv-cat-filter');
  if (invHasCategory()) {
    const cats = [...new Set(allItems.map(i=>i.Category).filter(Boolean))].sort();
    const curCat = catSel.value;
    catSel.innerHTML = '<option value="">All Categories</option>' +
      cats.map(c=>`<option value="${escHtml(c)}" ${c===curCat?'selected':''}>${escHtml(c)}</option>`).join('');
  }

  const suppliers = [...new Set(allItems.map(i=>i.Supplier).filter(Boolean))].sort();
  const supSel = document.getElementById('inv-supplier-filter');
  const curSup = supSel?.value || '';
  if (supSel) supSel.innerHTML = '<option value="">All Vendors</option>' +
    suppliers.map(s=>`<option value="${escHtml(s)}" ${s===curSup?'selected':''}>${escHtml(s)}</option>`).join('');
}

function renderMerchInventoryItems(query='', catFilter='') {
  const cfg = invCfg();
  const countsMap = getLatestCountsMap(currentLocation);
  const showArchived = document.getElementById('inv-show-archived')?.checked || false;
  let items = cache[cfg.cacheKey] || [];
  if (!showArchived) items = items.filter(i => !i.Archived);
  if (query) items = items.filter(i=>(i.ItemName||'').toLowerCase().includes(query.toLowerCase())||
    (i.ItemNo||'').toLowerCase().includes(query.toLowerCase())||
    (i.Category||'').toLowerCase().includes(query.toLowerCase()));
  if (catFilter) items = items.filter(i=>i.Category===catFilter);

  if (_invSort.col) {
    items = [...items].sort((a,b) => {
      const av = _invSort.col==='TotalValue' ? (a.CostPerUnit||0)*(countsMap[a.ItemName||'']?.total||0)
               : _invSort.col==='TotalCount' ? (countsMap[a.ItemName||'']?.total||0)
               : a[_invSort.col];
      const bv = _invSort.col==='TotalValue' ? (b.CostPerUnit||0)*(countsMap[b.ItemName||'']?.total||0)
               : _invSort.col==='TotalCount' ? (countsMap[b.ItemName||'']?.total||0)
               : b[_invSort.col];
      if (av==null && bv==null) return 0;
      if (av==null) return 1; if (bv==null) return -1;
      return (typeof av==='string' ? av.localeCompare(bv) : av-bv) * _invSort.dir;
    });
  } else {
    items = [...items].sort((a,b) => (a.ItemName||'').localeCompare(b.ItemName||''));
  }

  const tbody = document.getElementById('inv-body');
  tbody.innerHTML = items.map(i => {
    const counts  = countsMap[i.ItemName||''] || {};
    const store   = counts.store   != null ? counts.store   : '—';
    const storage = counts.storage != null ? counts.storage : '—';
    const total   = counts.total   != null ? counts.total   : '—';
    const totalNum = counts.total  != null ? counts.total   : null;
    const cost    = i.CostPerUnit  != null ? i.CostPerUnit  : null;
    const value   = (cost != null && totalNum != null) ? '$'+(cost*totalNum).toFixed(2) : '—';
    const canEditRcv = isOwnerOrAccounting();
    const rcvQty = i.Received != null ? i.Received : 0;
    return `<tr${i.Archived?' style="opacity:.45;"':''}>
      <td style="font-size:12px;color:var(--muted)">${escHtml(i.ItemNo||'—')}</td>
      <td class="fw">${escHtml(i.ItemName||'—')}${i.SquareId?'<span class="sq-badge" title="Synced with Square">SQ</span>':''}${i.Archived?'<span style="font-size:10px;background:var(--muted);color:#fff;padding:1px 5px;border-radius:8px;margin-left:4px;">archived</span>':''}</td>
      <td><span class="badge badge-teal">${escHtml(i.Category||'—')}</span></td>
      <td>${cost != null ? '$'+Number(cost).toFixed(2) : '—'}</td>
      <td>${store}</td>
      <td>${storage}</td>
      <td style="font-weight:600">${total}</td>
      <td style="font-size:12px;color:var(--muted)">${value}</td>
      <td style="padding:4px 8px;">
        ${canEditRcv
          ? `<div style="display:flex;align-items:center;gap:4px;">
               <input type="number" value="${rcvQty}" step="1"
                 style="width:56px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;text-align:right;"
                 data-id="${escHtml(i.id)}" data-name="${escHtml(i.ItemName||'')}"
                 onchange="saveMerchReceivedItem(this.dataset.id,this.dataset.name,this.value,this)">
               <button title="${escHtml(i.ReceivedNotes||'Add notes…')}"
                 data-id="${escHtml(i.id)}" data-name="${escHtml(i.ItemName||'')}" data-notes="${escHtml(i.ReceivedNotes||'')}"
                 onclick="editMerchReceivedNotes(this.dataset.id,this.dataset.name,this.dataset.notes)"
                 style="background:none;border:none;cursor:pointer;font-size:13px;color:${i.ReceivedNotes?'var(--gold)':'var(--muted)'}">📝</button>
             </div>`
          : `<span style="font-size:13px">${rcvQty||'—'}</span>`}
      </td>
      <td style="white-space:nowrap;">
        <button onclick="openEditInvItem('${i.id}')" title="Edit"
          style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:15px;padding:2px 4px;">✏️</button>
        ${isOwner() ? `<button data-id="${escHtml(i.id)}" data-archived="${i.Archived?'1':''}" onclick="toggleArchiveInvItem(this.dataset.id,this.dataset.archived==='1')" title="${i.Archived?'Unarchive':'Archive'}"
          style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:15px;padding:2px 4px;">${i.Archived?'📤':'📦'}</button>
        <button onclick="deleteInvItem('${i.id}')" title="Delete"
          style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:15px;padding:2px 4px;">🗑️</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  document.getElementById('inv-empty').style.display = items.length?'none':'block';
  document.getElementById('inv-count').textContent = `${items.length} items`;

  const allItems = cache[cfg.cacheKey] || [];
  const catSel = document.getElementById('inv-cat-filter');
  const cats = [...new Set(allItems.map(i=>i.Category).filter(Boolean))].sort();
  const curCat = catSel?.value || '';
  if (catSel) catSel.innerHTML = '<option value="">All Categories</option>' +
    cats.map(c=>`<option value="${escHtml(c)}" ${c===curCat?'selected':''}>${escHtml(c)}</option>`).join('');
}

function filterInventory(query) {
  renderInventoryItems(query,
    document.getElementById('inv-cat-filter')?.value || '',
    document.getElementById('inv-status-filter')?.value || '',
    document.getElementById('inv-supplier-filter')?.value || ''
  );
}

// ── Latest-counts map ────────────────────────────────────────────
// Returns itemName → most recent count { store, storage, total, weekOf, location }
function getLatestCountsMap(loc) {
  const cfg = invCfg();
  if (!cfg) return {};
  const countData = cache[cfg.countKey] || cache.countHistory;
  const filtered = (!loc || loc === 'all')
    ? countData
    : countData.filter(r => r.Location === loc);
  const map = {};
  // sort ascending so later dates overwrite earlier ones
  [...filtered].sort((a,b)=>(a.WeekOf||'')>(b.WeekOf||'')?1:-1).forEach(r=>{
    const name = (r.Title||r.ItemName||'').trim();
    if (name) map[name] = {
      store:   r.StoreCount||0,
      storage: r.StorageCount||0,
      total:   r.TotalCount||0,
      weekOf:  r.WeekOf?.split('T')[0],
      location: r.Location
    };
  });
  return map;
}

// ── Nav-into-inventory helpers ──────────────────────────────────
function navLowStock() {
  nav('inventory');
  const sel = document.getElementById('inv-status-filter');
  if (sel) { sel.value = 'low'; filterInventory(''); }
}

// Smoothly scroll an element into view and briefly flash a gold highlight.
function highlightAndScroll(el) {
  if (!el) return;
  el.scrollIntoView({behavior:'smooth',block:'center'});
  el.style.transition='background .2s';
  el.style.background='rgba(200,169,81,.25)';
  setTimeout(()=>el.style.background='',1800);
}

// Navigate to the inventory page and highlight the row matching the given ingredient name.
// Prep items live on their own Prep Items page, not in Inventory — check there first.
// Otherwise searches consumable → merch → equipment and switches to the right type.
function navToInventoryItem(name) {
  if (!name) return;
  const prep = (cache.prepItems || []).find(p => (p.Title||'').toLowerCase() === name.toLowerCase());
  if (prep) {
    nav('prep-items');
    setTimeout(() => {
      highlightAndScroll(document.querySelector(`#pi-cards [data-gs-id="${prep.id}"]`));
    }, 150);
    return;
  }
  const typeMap = [
    { type: 'consumable', arr: cache.inventory         || [] },
    { type: 'merch',      arr: cache.merchInventory    || [] },
    { type: 'equipment',  arr: cache.equipInventory    || [] },
  ];
  let foundType = 'consumable';
  let foundId   = null;
  for (const { type, arr } of typeMap) {
    const match = arr.find(i => (i.ItemName||i.Title||'').toLowerCase() === name.toLowerCase());
    if (match) { foundType = type; foundId = match.id; break; }
  }
  switchInvType(foundType);
  nav('inventory');
  setTimeout(() => {
    const input = document.getElementById('inv-search-input');
    if (input) { input.value = name; filterInventory(name); }
    if (foundId) {
      setTimeout(() => {
        highlightAndScroll(document.querySelector(`#inv-body tr[data-inv-id="${foundId}"]`));
      }, 150);
    }
  }, 50);
}

// Returns a clickable span that navigates to the matching inventory item.
// suffix = optional HTML appended inside the span (e.g. a badge).
function invItemLink(name, suffix='') {
  if (!name) return '';
  return `<span class="inv-item-link" data-inv-name="${escHtml(name)}" onclick="event.stopPropagation();navToInventoryItem(this.dataset.invName)" title="View in Inventory">${escHtml(name)}${suffix}</span>`;
}
