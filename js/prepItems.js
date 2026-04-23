/* ================================================================
 * BSC Ops — prepItems.js
 * Prep Items: composite recipes used as ingredients in COGs. Backed
 * by BSC_PrepItems + BSC_PrepItemIngredients. The map returned by
 * buildPrepItemMap is consumed by calcCog in cogs.js (keyed by
 * lowercase name).
 *
 * Contents:
 *   - buildPrepItemMap() — {name: {CostPerServing, _isPrepItem, YieldUnit}}
 *   - calcPrepItemCost(itemId)
 *   - renderPrepItems / renderPrepItemCard
 *   - openPrepItemModal (Add/Edit)
 *   - Ingredient row helpers: addPrepIngRow, updatePiNoIngsMsg,
 *     onPiTypeChange, onPiInvChange, removePiIngRow,
 *     updatePiCostPreview, getPiIngRows
 *   - savePrepItemForm / deletePrepItem
 *   - loadPrepItemHistory / restorePrepItemVersion (SharePoint
 *     version history; master fields only — ingredient rows live
 *     in BSC_PrepItemIngredients and are not versioned here)
 *
 * Depends on:
 *   state.js     — cache
 *   constants.js — LISTS
 *   utils.js     — escHtml, toast, openModal, closeModal, setLoading
 *   graph.js     — graph, getSiteId, addListItem, updateListItem, deleteListItem
 *   inventory.js — invItemLink
 * ================================================================ */

function buildPrepItemMap() {
  const map = {};
  for (const item of (cache.prepItems || [])) {
    const name = (item.Title || '').toLowerCase().trim();
    if (!name) continue;
    const yieldQty = parseFloat(item.YieldQty) || 1;
    const ings = (cache.prepItemIngredients || []).filter(i => i.PrepItemId === item.id);
    let totalCost = 0;
    for (const ing of ings) {
      const qty = parseFloat(ing.Qty) || 0;
      let costPer = 0;
      if (ing.IngredientType === 'inventory') {
        const invItem = cache.inventory.find(i => i.id === ing.IngredientId);
        costPer = invItem ? (parseFloat(invItem.CostPerServing) || 0) : 0;
      } else {
        costPer = parseFloat(ing.CostPerUnit) || 0;
      }
      totalCost += qty * costPer;
    }
    map[name] = { CostPerServing: yieldQty > 0 ? totalCost / yieldQty : 0, _isPrepItem: true, YieldUnit: item.YieldUnit || '' };
  }
  return map;
}

function calcPrepItemCost(itemId) {
  const item = (cache.prepItems || []).find(p => p.id === itemId);
  if (!item) return { totalCost: 0, costPerUnit: 0, yieldQty: 0, yieldUnit: '' };
  const yieldQty = parseFloat(item.YieldQty) || 1;
  const ings = (cache.prepItemIngredients || []).filter(i => i.PrepItemId === itemId);
  let totalCost = 0;
  for (const ing of ings) {
    const qty = parseFloat(ing.Qty) || 0;
    let costPer = 0;
    if (ing.IngredientType === 'inventory') {
      const invItem = cache.inventory.find(i => i.id === ing.IngredientId);
      costPer = invItem ? (parseFloat(invItem.CostPerServing) || 0) : 0;
    } else {
      costPer = parseFloat(ing.CostPerUnit) || 0;
    }
    totalCost += qty * costPer;
  }
  return { totalCost, costPerUnit: yieldQty > 0 ? totalCost / yieldQty : 0, yieldQty, yieldUnit: item.YieldUnit || '' };
}

function renderPrepItems() {
  const container = document.getElementById('pi-cards');
  const empty = document.getElementById('pi-empty');
  if (!container) return;
  const items = [...(cache.prepItems || [])].sort((a,b) => (a.Title||'').localeCompare(b.Title||''));
  if (!items.length) {
    container.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  container.innerHTML = items.map(item => renderPrepItemCard(item)).join('');
}

function renderPrepItemCard(item) {
  const ings = (cache.prepItemIngredients || []).filter(i => i.PrepItemId === item.id)
    .sort((a,b) => (a.IngredientName||'').localeCompare(b.IngredientName||''));
  const { totalCost, costPerUnit, yieldQty, yieldUnit } = calcPrepItemCost(item.id);

  const ingRows = ings.map(ing => {
    let costLabel = '';
    let nameHtml = '';
    let lineCost = null;
    const qty = parseFloat(ing.Qty) || 0;
    if (ing.IngredientType === 'inventory') {
      const invItem = cache.inventory.find(i => i.id === ing.IngredientId);
      const cp = invItem ? parseFloat(invItem.CostPerServing) : null;
      const badge = ' <span style="font-size:10px;color:var(--teal);background:rgba(0,128,128,.1);padding:1px 5px;border-radius:8px;">inv</span>';
      nameHtml = invItemLink(ing.IngredientName || '', badge);
      costLabel = cp != null ? '$'+cp.toFixed(4) : '<span style="color:#f59e0b">no cost</span>';
      lineCost = cp != null ? qty * cp : null;
    } else {
      nameHtml = escHtml(ing.IngredientName || '');
      const cp = parseFloat(ing.CostPerUnit);
      costLabel = !isNaN(cp) ? '$'+cp.toFixed(4) : '—';
      lineCost = !isNaN(cp) ? qty * cp : null;
    }
    return `<tr>
      <td style="padding:5px 8px;font-size:12px;">${nameHtml}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right;white-space:nowrap;">${escHtml(String(ing.Qty||''))} ${escHtml(ing.Unit||'')}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right;color:var(--muted);">${costLabel}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right;font-weight:600;">${lineCost!=null?'$'+lineCost.toFixed(3):'—'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="card" data-gs-id="${escHtml(item.id)}" style="padding:0;overflow:hidden;">
      <div style="padding:14px 16px 10px;border-bottom:1.5px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-weight:700;font-size:15px;">${escHtml(item.Title||'Untitled')}</div>
          ${item.Category?`<div style="font-size:11px;color:var(--muted);margin-top:2px;">${escHtml(item.Category)}</div>`:''}
          ${item.Notes?`<div style="font-size:11px;color:var(--muted);margin-top:4px;">${escHtml(item.Notes)}</div>`:''}
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:20px;font-weight:700;color:var(--gold);">$${costPerUnit.toFixed(4)}<span style="font-size:11px;font-weight:400;color:var(--muted);">/${escHtml(yieldUnit||'unit')}</span></div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;">$${totalCost.toFixed(2)} total · ${yieldQty} ${escHtml(yieldUnit||'unit')} batch</div>
        </div>
      </div>
      ${ings.length ? `
      <div style="padding:4px 16px 0;">
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;min-width:280px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border);">
              <th style="padding:4px 8px;font-size:10px;text-align:left;color:var(--muted);font-weight:600;">INGREDIENT</th>
              <th style="padding:4px 8px;font-size:10px;text-align:right;color:var(--muted);font-weight:600;">QTY</th>
              <th style="padding:4px 8px;font-size:10px;text-align:right;color:var(--muted);font-weight:600;">$/UNIT</th>
              <th style="padding:4px 8px;font-size:10px;text-align:right;color:var(--muted);font-weight:600;">LINE COST</th>
            </tr>
          </thead>
          <tbody>${ingRows}</tbody>
        </table>
        </div>
      </div>` : `<div style="padding:10px 16px;font-size:12px;color:var(--muted);">No ingredients added.</div>`}
      <div style="padding:10px 16px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--border);margin-top:8px;">
        <button class="btn" style="font-size:12px;padding:4px 12px;" data-id="${escHtml(item.id)}" onclick="openPrepItemModal(this.dataset.id)">✏️ Edit</button>
        <button class="btn" style="font-size:12px;padding:4px 12px;color:var(--red);border-color:var(--red);" data-id="${escHtml(item.id)}" onclick="deletePrepItem(this.dataset.id)">🗑 Delete</button>
      </div>
    </div>`;
}

let _piIngRowCount = 0;

function openPrepItemModal(id) {
  const item = id ? (cache.prepItems || []).find(p => p.id === id) : null;
  const ings = id ? (cache.prepItemIngredients || []).filter(i => i.PrepItemId === id) : [];
  _piIngRowCount = 0;
  document.getElementById('pi-modal-title').textContent = item ? 'Edit Prep Item' : 'Add Prep Item';
  document.getElementById('pi-edit-id').value = id || '';
  document.getElementById('pi-name').value = item?.Title || '';
  document.getElementById('pi-category').value = item?.Category || '';
  document.getElementById('pi-yield-qty').value = item?.YieldQty ?? '';
  document.getElementById('pi-yield-unit').value = item?.YieldUnit || '';
  document.getElementById('pi-notes').value = item?.Notes || '';
  document.getElementById('pi-ing-rows').innerHTML = '';
  const sortedIngs = [...ings].sort((a,b) => (a.IngredientName||'').localeCompare(b.IngredientName||''));
  for (const ing of sortedIngs) addPrepIngRow(ing);
  updatePiNoIngsMsg();
  updatePiCostPreview();
  // History button only meaningful when editing an existing item
  const histBtn = document.getElementById('pi-history-btn');
  if (histBtn) histBtn.style.display = id ? 'inline-flex' : 'none';
  openModal('modal-prep-item');
}

// Fetch SharePoint's built-in version history for this prep item. Only tracks
// master fields (Title, Category, YieldQty, YieldUnit, Notes) — ingredient
// rows live in BSC_PrepItemIngredients and are not versioned here.
async function loadPrepItemHistory(id) {
  if (!id) return;
  const item = cache.prepItems.find(p => p.id === id);
  document.getElementById('pi-history-title').textContent = `History — ${item?.Title || 'Prep Item'}`;
  setLoading(true, 'Loading history…');
  try {
    const siteId = await getSiteId();
    const res = await graph('GET', `/sites/${siteId}/lists/${LISTS.prepItems}/items/${id}/versions`);
    const versions = res.value || [];
    const el = document.getElementById('pi-history-list');
    if (!versions.length) {
      el.innerHTML = '<div style="padding:20px;color:var(--muted);font-size:13px;text-align:center;">No edit history found.<br><span style="font-size:11px;">History saves after each edit.</span></div>';
    } else {
      el.innerHTML = '<div style="padding:8px 16px 14px;font-size:11px;color:var(--muted);font-style:italic;">Tracks master fields only (name, category, yield, notes). Ingredient rows are not versioned.</div>' +
        versions.map((v, i) => {
          const d = new Date(v.lastModifiedDateTime);
          const date = d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
          const time = d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
          const by = v.lastModifiedBy?.user?.displayName || 'Unknown';
          const f = v.fields || {};
          const title    = f.Title || '';
          const category = f.Category || '';
          const yieldQty = f.YieldQty;
          const yieldUnit = f.YieldUnit || '';
          const notes    = f.Notes || '';
          const yieldStr = (yieldQty != null && yieldQty !== '') ? `${yieldQty} ${escHtml(yieldUnit || 'unit')}` : '—';
          const isCurrent = i === 0;
          return `<div style="padding:16px 0;border-bottom:1px solid var(--border);">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
              <div>
                <span style="font-weight:600;font-size:13px;">${escHtml(by)}</span>
                <span style="font-size:11px;color:var(--muted);margin-left:8px;">${date} at ${time}</span>
              </div>
              ${isCurrent
                ? '<span style="font-size:10px;padding:2px 8px;background:rgba(183,139,64,.15);color:var(--gold);border-radius:10px;font-weight:700;letter-spacing:.04em;">CURRENT</span>'
                : `<button data-id="${escHtml(id)}" data-vid="${escHtml(v.id)}" onclick="restorePrepItemVersion(this.dataset.id,this.dataset.vid)" style="font-size:11px;color:var(--gold);border:1.5px solid var(--gold);border-radius:6px;padding:3px 10px;background:none;cursor:pointer;font-weight:600;">↩ Restore</button>`
              }
            </div>
            <div style="font-size:12px;color:var(--ink);background:var(--cream);border-radius:6px;padding:10px 12px;line-height:1.6;">
              <div><span style="color:var(--muted);">Name:</span> ${escHtml(title) || '<span style="color:var(--muted);font-style:italic;">—</span>'}</div>
              <div><span style="color:var(--muted);">Category:</span> ${escHtml(category) || '<span style="color:var(--muted);font-style:italic;">—</span>'}</div>
              <div><span style="color:var(--muted);">Yield:</span> ${yieldStr}</div>
              ${notes ? `<div style="margin-top:4px;"><span style="color:var(--muted);">Notes:</span> ${escHtml(notes)}</div>` : ''}
            </div>
          </div>`;
        }).join('');
    }
    closeModal('modal-prep-item');
    openModal('modal-prep-item-history');
  } catch(e) { toast('err', 'Could not load history: ' + e.message); }
  finally { setLoading(false); }
}

async function restorePrepItemVersion(itemId, versionId) {
  if (!confirm('Restore this version? Master fields (name, category, yield, notes) will be overwritten. Ingredient rows are not affected.')) return;
  setLoading(true, 'Restoring version…');
  try {
    const siteId = await getSiteId();
    const ver = await graph('GET', `/sites/${siteId}/lists/${LISTS.prepItems}/items/${itemId}/versions/${versionId}`);
    const f = ver.fields || {};
    const data = {
      Title:     f.Title || '',
      Category:  f.Category || '',
      YieldQty:  f.YieldQty != null && f.YieldQty !== '' ? parseFloat(f.YieldQty) : null,
      YieldUnit: f.YieldUnit || '',
      Notes:     f.Notes || ''
    };
    await updateListItem(LISTS.prepItems, itemId, data);
    const i = cache.prepItems.findIndex(p => p.id === itemId);
    if (i !== -1) Object.assign(cache.prepItems[i], data);
    renderPrepItems();
    closeModal('modal-prep-item-history');
    toast('ok', '✓ Version restored');
  } catch(e) { toast('err', 'Restore failed: ' + e.message); }
  finally { setLoading(false); }
}

function updatePiNoIngsMsg() {
  const rows = document.querySelectorAll('#pi-ing-rows .pi-ing-row');
  const el = document.getElementById('pi-no-ings');
  if (el) el.style.display = rows.length ? 'none' : '';
}

function addPrepIngRow(prefill) {
  const rowsEl = document.getElementById('pi-ing-rows');
  const rowId = ++_piIngRowCount;
  const type = prefill?.IngredientType || 'custom';
  const invOptions = [...cache.inventory]
    .sort((a,b) => (a.ItemName||a.Title||'').localeCompare(b.ItemName||b.Title||''))
    .map(i => {
      const nm = escHtml(i.ItemName || i.Title || '');
      const selected = prefill?.IngredientId === i.id ? ' selected' : '';
      return `<option value="${escHtml(i.id)}" data-cost="${escHtml(String(i.CostPerServing||0))}" data-name="${nm}"${selected}>${nm}</option>`;
    }).join('');

  const row = document.createElement('div');
  row.className = 'pi-ing-row';
  row.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:7px 0;border-bottom:1px solid var(--border);';
  row.innerHTML = `
    <select class="pi-type-sel" onchange="onPiTypeChange(this)"
      style="padding:5px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;flex-shrink:0;">
      <option value="custom"${type==='custom'?' selected':''}>Custom</option>
      <option value="inventory"${type==='inventory'?' selected':''}>Inventory</option>
    </select>
    <div class="pi-inv-wrap" style="display:${type==='inventory'?'flex':'none'};gap:4px;align-items:center;flex:2;min-width:130px;">
      <select class="pi-inv-sel" onchange="onPiInvChange(this)"
        style="padding:5px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;width:100%;">
        <option value="">Select item…</option>${invOptions}
      </select>
    </div>
    <div class="pi-custom-wrap" style="display:${type==='custom'?'flex':'none'};gap:4px;align-items:center;flex:2;min-width:130px;">
      <input type="text" class="pi-cust-name" placeholder="Ingredient name"
        value="${escHtml(prefill?.IngredientName||'')}"
        style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;flex:1;min-width:90px;" oninput="updatePiCostPreview()">
      <input type="number" step="0.0001" min="0" class="pi-cust-cost" placeholder="$/unit"
        value="${prefill?.CostPerUnit!=null?prefill.CostPerUnit:''}"
        style="width:72px;padding:5px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;" oninput="updatePiCostPreview()">
    </div>
    <input type="number" step="0.001" min="0" class="pi-qty" placeholder="Qty"
      value="${prefill?.Qty!=null?prefill.Qty:''}"
      style="width:60px;padding:5px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;flex-shrink:0;" oninput="updatePiCostPreview()">
    <input type="text" class="pi-unit" placeholder="Unit"
      value="${escHtml(prefill?.Unit||'')}"
      style="width:52px;padding:5px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;flex-shrink:0;">
    <button onclick="removePiIngRow(this)"
      style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:17px;padding:2px 4px;flex-shrink:0;line-height:1;">✕</button>
    <input type="hidden" class="pi-ing-id" value="${escHtml(String(prefill?.id||''))}">
    <input type="hidden" class="pi-ing-inv-id" value="${escHtml(String(prefill?.IngredientId||''))}">
    <input type="hidden" class="pi-ing-inv-name" value="${escHtml(type==='inventory'?String(prefill?.IngredientName||''):'')}">`;
  rowsEl.appendChild(row);
  updatePiNoIngsMsg();
  updatePiCostPreview();
}

function onPiTypeChange(sel) {
  const row = sel.closest('.pi-ing-row');
  row.querySelector('.pi-inv-wrap').style.display = sel.value === 'inventory' ? 'flex' : 'none';
  row.querySelector('.pi-custom-wrap').style.display = sel.value === 'custom' ? 'flex' : 'none';
  updatePiCostPreview();
}

function onPiInvChange(sel) {
  const opt = sel.selectedOptions[0];
  const row = sel.closest('.pi-ing-row');
  row.querySelector('.pi-ing-inv-id').value = opt?.value || '';
  row.querySelector('.pi-ing-inv-name').value = opt?.dataset.name || '';
  updatePiCostPreview();
}

function removePiIngRow(btn) {
  btn.closest('.pi-ing-row').remove();
  updatePiNoIngsMsg();
  updatePiCostPreview();
}

function updatePiCostPreview() {
  const yieldQty = parseFloat(document.getElementById('pi-yield-qty')?.value) || 0;
  const yieldUnit = document.getElementById('pi-yield-unit')?.value?.trim() || 'unit';
  let total = 0;
  let hasGap = false;
  document.querySelectorAll('#pi-ing-rows .pi-ing-row').forEach(row => {
    const type = row.querySelector('.pi-type-sel')?.value;
    const qty = parseFloat(row.querySelector('.pi-qty')?.value) || 0;
    let costPer = 0;
    if (type === 'inventory') {
      const opt = row.querySelector('.pi-inv-sel')?.selectedOptions[0];
      if (opt?.value) {
        const invItem = cache.inventory.find(i => i.id === opt.value);
        costPer = invItem ? (parseFloat(invItem.CostPerServing) || 0) : 0;
        if (!invItem || !invItem.CostPerServing) hasGap = true;
      } else {
        hasGap = true;
      }
    } else {
      const raw = parseFloat(row.querySelector('.pi-cust-cost')?.value);
      costPer = isNaN(raw) ? 0 : raw;
    }
    total += qty * costPer;
  });
  const cpu = yieldQty > 0 ? total / yieldQty : 0;
  const el = document.getElementById('pi-cost-preview');
  if (!el) return;
  el.innerHTML = `<div style="margin-top:10px;padding:10px 14px;background:var(--cream);border-radius:8px;font-size:13px;">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <span style="color:var(--muted);">Batch total</span>
      <span style="font-weight:600;">$${total.toFixed(2)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
      <span style="color:var(--muted);">Cost per ${escHtml(yieldUnit)}</span>
      <span style="font-weight:700;color:var(--gold);font-size:17px;">$${cpu.toFixed(4)}</span>
    </div>
    ${hasGap?'<div style="font-size:11px;color:#f59e0b;margin-top:6px;">⚠️ Some inventory items are missing Cost Per Serving — set it in Inventory to get accurate costs.</div>':''}
  </div>`;
}

function getPiIngRows() {
  const rows = [];
  document.querySelectorAll('#pi-ing-rows .pi-ing-row').forEach(row => {
    const type = row.querySelector('.pi-type-sel')?.value || 'custom';
    const qty = parseFloat(row.querySelector('.pi-qty')?.value);
    const unit = (row.querySelector('.pi-unit')?.value || '').trim();
    const existingId = row.querySelector('.pi-ing-id')?.value || '';
    if (type === 'inventory') {
      const opt = row.querySelector('.pi-inv-sel')?.selectedOptions[0];
      const invId = opt?.value || '';
      const invName = opt?.dataset.name || row.querySelector('.pi-ing-inv-name')?.value || '';
      if (!invId) return;
      rows.push({ id: existingId, type: 'inventory', invId, name: invName, qty: isNaN(qty)?null:qty, unit, costPerUnit: null });
    } else {
      const name = (row.querySelector('.pi-cust-name')?.value || '').trim();
      const cost = parseFloat(row.querySelector('.pi-cust-cost')?.value);
      if (!name) return;
      rows.push({ id: existingId, type: 'custom', invId: '', name, qty: isNaN(qty)?null:qty, unit, costPerUnit: isNaN(cost)?null:cost });
    }
  });
  return rows;
}

async function savePrepItemForm() {
  const name = document.getElementById('pi-name').value.trim();
  if (!name) { toast('err', 'Item name is required'); return; }
  const editId   = document.getElementById('pi-edit-id').value;
  const yieldQty = parseFloat(document.getElementById('pi-yield-qty').value) || null;
  const yieldUnit = document.getElementById('pi-yield-unit').value.trim();
  const category = document.getElementById('pi-category').value.trim();
  const notes    = document.getElementById('pi-notes').value.trim();
  const ingRows  = getPiIngRows();

  setLoading(true, editId ? 'Saving…' : 'Creating…');
  try {
    const masterFields = { Title: name, Category: category, YieldQty: yieldQty, YieldUnit: yieldUnit, Notes: notes };
    let itemId;
    if (editId) {
      await updateListItem(LISTS.prepItems, editId, masterFields);
      itemId = editId;
      const existing = cache.prepItems.find(p => p.id === editId);
      if (existing) Object.assign(existing, masterFields);
    } else {
      const saved = await addListItem(LISTS.prepItems, masterFields);
      cache.prepItems.push(saved);
      itemId = saved.id;
    }
    // Reconcile ingredients
    const existingIngs = (cache.prepItemIngredients || []).filter(i => i.PrepItemId === itemId);
    const keptIds = new Set(ingRows.filter(r => r.id).map(r => r.id));
    for (const old of existingIngs) {
      if (!keptIds.has(String(old.id))) {
        await deleteListItem(LISTS.prepItemIngredients, old.id);
        cache.prepItemIngredients = cache.prepItemIngredients.filter(i => i.id !== old.id);
      }
    }
    for (const row of ingRows) {
      const fields = {
        Title:          name + ' — ' + row.name,
        PrepItemId:     itemId,
        IngredientType: row.type,
        IngredientId:   row.invId || '',
        IngredientName: row.name,
        Qty:            row.qty,
        Unit:           row.unit,
        CostPerUnit:    row.costPerUnit
      };
      if (row.id) {
        await updateListItem(LISTS.prepItemIngredients, row.id, fields);
        const ci = cache.prepItemIngredients.find(i => String(i.id) === row.id);
        if (ci) Object.assign(ci, fields);
      } else {
        const saved = await addListItem(LISTS.prepItemIngredients, fields);
        cache.prepItemIngredients.push(saved);
      }
    }
    closeModal('modal-prep-item');
    renderPrepItems();
    toast('ok', editId ? '✓ Prep item updated' : '✓ Prep item created');
  } catch(e) {
    toast('err', 'Save failed: ' + e.message);
  } finally {
    setLoading(false);
  }
}

async function deletePrepItem(id) {
  if (!confirm('Delete this prep item? It will no longer be available as an ingredient in cost calculations.')) return;
  setLoading(true, 'Deleting…');
  try {
    await deleteListItem(LISTS.prepItems, id);
    cache.prepItems = cache.prepItems.filter(p => p.id !== id);
    const ingsToDelete = (cache.prepItemIngredients || []).filter(i => i.PrepItemId === id);
    for (const ing of ingsToDelete) {
      await deleteListItem(LISTS.prepItemIngredients, ing.id);
    }
    cache.prepItemIngredients = (cache.prepItemIngredients || []).filter(i => i.PrepItemId !== id);
    renderPrepItems();
    toast('ok', '🗑 Prep item deleted');
  } catch(e) {
    toast('err', 'Delete failed: ' + e.message);
  } finally {
    setLoading(false);
  }
}
