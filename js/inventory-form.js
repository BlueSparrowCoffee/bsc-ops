/* ================================================================
 * BSC Ops — inventory-form.js
 * Add/Edit inventory item modal plumbing, archive/delete flow,
 * vendor-select population with inline "new vendor" creation,
 * category select with inline "new category" entry, and the
 * rename-propagation helper that syncs recipes / prep items /
 * COG recipes when an inventory item is renamed.
 *
 * _editInvId is the module-level sentinel: null = add mode,
 * otherwise the SharePoint item ID being edited. ALWAYS capture it
 * into a local variable before calling closeModal('modal-add-item')
 * — closeModal clears it.
 *
 * Depends on:
 *   - state.js (cache, currentUser)
 *   - constants.js (LISTS)
 *   - graph.js (getSiteId, graph, addListItem, updateListItem)
 *   - utils.js (escHtml, toast, openModal, closeModal, setLoading)
 *   - tags.js (tagEditorHTML, initTagEditor, getTagEditorValue)
 *   - inventory.js (invCfg, invHasCategory, renderInventory)
 *   - dashboard.js (renderDashboard)
 *   - index.html globals resolved at call time:
 *     calcCostPerServing, isOwner, populateSelects, renderVendors,
 *     renderRecipes
 * ================================================================ */

let _editInvId = null;

function openAddInvForm() {
  _editInvId = null;
  const cfg = invCfg();
  if (!cfg) return;
  // Merch inventory is source-of-truthed in Square — block manual adds so
  // every row has a SquareCatalogItemId and prices/names stay in sync.
  if (cfg.isMerch) {
    toast('err', 'Merch items must be added in Square. Use "◼ Sync from Square".');
    return;
  }
  document.querySelector('#modal-add-item .modal-title').textContent = 'Add ' + cfg.label + ' Item';
  document.querySelector('#modal-add-item .btn-primary').textContent = 'Save Item';
  // clear form
  ['new-item-name','new-item-cost-unit',
   'new-item-order-size','new-item-unit',
   'new-item-cost','new-item-serving-unit','new-item-servings'
  ].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  renderInvParTable(null);
  populateInvVendorSelect('');
  // Reset category select to first option
  const catSel = document.getElementById('new-item-cat');
  if (catSel) {
    // Update options visibility to match current inv type
    const isMerch = !!(cfg?.isMerch);
    catSel.querySelectorAll('.inv-cons-only').forEach(o => o.style.display = isMerch ? 'none' : '');
    catSel.querySelectorAll('.inv-merch-only').forEach(o => o.style.display = isMerch ? '' : 'none');
    // Select first visible option
    const firstVisible = catSel.querySelector('option:not([style*="display: none"]):not([style*="display:none"])');
    if (firstVisible) catSel.value = firstVisible.value;
  }
  const catCustom = document.getElementById('new-item-cat-custom');
  if (catCustom) { catCustom.style.display = 'none'; catCustom.value = ''; }
  // Tags don't apply to merch (Square is source of truth) — hide the editor in merch mode.
  const tagsContainer = document.getElementById('inv-item-tags-editor');
  if (tagsContainer) {
    if (cfg?.isMerch) {
      tagsContainer.innerHTML = '';
      if (tagsContainer.parentElement) tagsContainer.parentElement.style.display = 'none';
    } else {
      if (tagsContainer.parentElement) tagsContainer.parentElement.style.display = '';
      tagsContainer.innerHTML = tagEditorHTML('inv-item');
      initTagEditor('inv-item', '');
    }
  }
  calcCostPerServing();
  // Hide archive/delete/hide/transfer — add mode only
  ['inv-modal-archive-btn','inv-modal-delete-btn','inv-modal-hide-btn','inv-modal-transfer-btn'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  openModal('modal-add-item');
}

function openEditInvItem(id) {
  const cfg = invCfg();
  if (!cfg) return;
  const item = cache[cfg.cacheKey].find(i => i.id === id);
  if (!item) return;
  _editInvId = id;
  document.querySelector('#modal-add-item .modal-title').textContent = 'Edit ' + cfg.label + ' Item';
  document.querySelector('#modal-add-item .btn-primary').textContent = 'Save Changes';
  document.getElementById('new-item-name').value = item.ItemName || '';
  // Update category option visibility, then set value
  const catSel = document.getElementById('new-item-cat');
  if (catSel) {
    const isMerch = !!(cfg?.isMerch);
    catSel.querySelectorAll('.inv-cons-only').forEach(o => o.style.display = isMerch ? 'none' : '');
    catSel.querySelectorAll('.inv-merch-only').forEach(o => o.style.display = isMerch ? '' : 'none');
    // If the stored category isn't in the list, inject it as a custom option
    const cat = item.Category || '';
    const catCustom = document.getElementById('new-item-cat-custom');
    if (catCustom) { catCustom.style.display = 'none'; catCustom.value = ''; }
    if (cat && !([...catSel.options].some(o => o.value === cat && o.value !== '__new__'))) {
      const opt = new Option(cat, cat);
      catSel.insertBefore(opt, catSel.querySelector('option[value="__new__"]'));
    }
    catSel.value = cat;
  }
  // Vendor select shows for both merch and consumable now.
  populateInvVendorSelect(item.Supplier || '');
  if (cfg.isMerch) {
    document.getElementById('new-item-cost-unit').value   = item.CostPerUnit != null ? item.CostPerUnit : '';
  } else {
    document.getElementById('new-item-order-size').value   = item.OrderSize != null ? item.OrderSize : '';
    document.getElementById('new-item-unit').value         = item.OrderUnit || item.Unit || '';
    // Per-location par + reorder trigger table (reads existing BSC_InventoryPars rows)
    renderInvParTable(item);
    document.getElementById('new-item-cost').value         = item.CostPerCase != null ? item.CostPerCase : '';
    if (document.getElementById('new-item-serving-unit'))
      document.getElementById('new-item-serving-unit').value = item.ServingUnit || '';
    if (document.getElementById('new-item-servings'))
      document.getElementById('new-item-servings').value   = item.ServingsPerUnit != null ? item.ServingsPerUnit : '';
    calcCostPerServing();
  }
  // Tags don't apply to merch (Square is source of truth) — hide the editor in merch mode.
  const tagsContainer2 = document.getElementById('inv-item-tags-editor');
  if (tagsContainer2) {
    if (cfg?.isMerch) {
      tagsContainer2.innerHTML = '';
      if (tagsContainer2.parentElement) tagsContainer2.parentElement.style.display = 'none';
    } else {
      if (tagsContainer2.parentElement) tagsContainer2.parentElement.style.display = '';
      tagsContainer2.innerHTML = tagEditorHTML('inv-item');
      initTagEditor('inv-item', item.Tags||'');
    }
  }
  // Show archive/delete/transfer buttons for edit mode (owner only on archive/delete)
  const archBtn  = document.getElementById('inv-modal-archive-btn');
  const delBtn   = document.getElementById('inv-modal-delete-btn');
  const hideBtn  = document.getElementById('inv-modal-hide-btn');
  const xferBtn  = document.getElementById('inv-modal-transfer-btn');
  if (archBtn) { archBtn.style.display = isOwner() ? '' : 'none'; archBtn.textContent = item.Archived ? '📤 Unarchive' : '📦 Archive'; }
  if (delBtn)  { delBtn.style.display  = isOwner() ? '' : 'none'; }
  // Transfer is available in edit mode for any inventory type
  if (xferBtn) { xferBtn.style.display = ''; }
  // Hide/show toggle — merch only. Anyone can toggle (it's a per-tenant view
  // preference, not a destructive action).
  if (hideBtn) {
    if (cfg.isMerch) {
      hideBtn.style.display = '';
      const isHidden = (typeof _merchInvHidden !== 'undefined') && _merchInvHidden.has(String(id));
      hideBtn.textContent = isHidden ? '👁️ Show in list' : '🙈 Hide from list';
    } else {
      hideBtn.style.display = 'none';
    }
  }
  openModal('modal-add-item');
}

function modalArchiveInvItem() {
  const id = _editInvId;
  if (!id) return;
  const cfg = invCfg();
  const item = cfg && cache[cfg.cacheKey]?.find(i => i.id === id);
  if (!item) return;
  const isArchived = !!item.Archived;
  closeModal('modal-add-item');
  toggleArchiveInvItem(id, isArchived);
}
function modalDeleteInvItem() {
  const id = _editInvId;
  if (!id) return;
  closeModal('modal-add-item');
  deleteInvItem(id);
}
// Toggle hide state for the currently-edited merch item. Capture the id
// BEFORE closeModal — closeModal('modal-add-item') sets _editInvId = null.
function modalToggleMerchInvHidden() {
  const id = _editInvId;
  if (!id) return;
  closeModal('modal-add-item');
  if (typeof toggleMerchInvHidden === 'function') toggleMerchInvHidden(id);
}

// Jump from the inventory edit modal to the Transfers tab with the transfer
// modal pre-filled. invType is mapped from the current inventory tab config
// to match the picker's `{type}|{id}` value format.
function modalTransferInvItem() {
  const id  = _editInvId;
  const cfg = invCfg();
  if (!id || !cfg) return;
  // Map cacheKey → transfer picker invType key
  const typeMap = { inventory:'consumable', merchInventory:'merch', equipInventory:'equipment' };
  const invType = typeMap[cfg.cacheKey] || 'consumable';
  closeModal('modal-add-item');
  if (typeof switchInvType === 'function') switchInvType('transfers');
  setTimeout(() => {
    if (typeof populateTransferItemSelect === 'function') populateTransferItemSelect();
    if (typeof openModal === 'function') openModal('modal-transfer');
    setTimeout(() => {
      const sel = document.getElementById('xfer-item');
      if (sel) sel.value = invType + '|' + id;
      const qty = document.getElementById('xfer-qty');
      if (qty) { qty.value = ''; qty.focus(); }
    }, MODAL_FOCUS_DELAY_MS);
  }, NAV_SETTLE_MS);
}
async function toggleArchiveInvItem(id, isArchived) {
  if (!isOwner()) { toast('err', 'Owner access required'); return; }
  const cfg = invCfg();
  if (!cfg) return;
  const item = cache[cfg.cacheKey].find(i => i.id === id);
  if (!item) return;
  const newVal = isArchived ? '' : 'yes';
  setLoading(true, isArchived ? 'Unarchiving…' : 'Archiving…');
  try {
    const siteId = await getSiteId();
    await graph('PATCH', `/sites/${siteId}/lists/${LISTS[cfg.listKey]}/items/${id}/fields`, { Archived: newVal });
    item.Archived = newVal;
    renderInventory();
    // Merch/food/grocery inventory lists double as the COGs overview source.
    // Without this call the COGs overview kept showing archived rows until the
    // user navigated away and back.
    if (typeof renderCogsOverview === 'function') renderCogsOverview();
    toast('ok', isArchived ? '✓ Item unarchived' : '✓ Item archived');
  } catch(e) { toast('err', 'Failed: ' + e.message); }
  finally { setLoading(false); }
}

async function deleteInvItem(id) {
  if (!isOwner()) { toast('err', 'Owner access required'); return; }
  const cfg = invCfg();
  if (!cfg) return;
  const item = cache[cfg.cacheKey].find(i => i.id === id);
  if (!item) return;
  if (!confirm(`Delete "${item.ItemName}" from inventory? This cannot be undone.`)) return;
  setLoading(true, 'Deleting…');
  try {
    const siteId = await getSiteId();
    await graph('DELETE', `/sites/${siteId}/lists/${LISTS[cfg.listKey]}/items/${id}`);
    cache[cfg.cacheKey] = cache[cfg.cacheKey].filter(i => i.id !== id);
    renderInventory(); renderDashboard(); populateSelects();
    toast('ok', '✓ Item deleted');
  } catch(e) { toast('err', 'Delete failed: ' + e.message); }
  finally { setLoading(false); }
}

// Propagate an inventory item rename to recipes, prep item ingredients, and COG recipes.
// Recipe ingredients are stored as a JSON blob keyed only by name (no ID), so they match by old name.
// Prep items and COG recipes have IngredientId, so they match reliably by ID.
// COG history snapshots are intentionally NOT touched — they're historical records.
async function propagateInventoryNameChange(itemId, oldName, newName) {
  if (!oldName || !newName || oldName.trim() === newName.trim()) return 0;
  const oldLower = oldName.toLowerCase().trim();
  const patches = [];

  // 1. Recipes — parse Ingredients JSON, match by name
  for (const r of (cache.recipes || [])) {
    if (!r.Ingredients) continue;
    let ings;
    try { ings = JSON.parse(r.Ingredients); } catch(e) { continue; }
    if (!Array.isArray(ings) || !ings.length) continue;
    let changed = false;
    ings.forEach(ing => {
      if (ing && ing.name && ing.name.toLowerCase().trim() === oldLower) {
        ing.name = newName;
        changed = true;
      }
    });
    if (changed) {
      const newJson = JSON.stringify(ings);
      patches.push(
        updateListItem(LISTS.recipes, r.id, { Ingredients: newJson })
          .then(() => { r.Ingredients = newJson; })
      );
    }
  }

  // 2. Prep item ingredients — match by IngredientId
  for (const pi of (cache.prepItemIngredients || [])) {
    if (String(pi.IngredientId) === String(itemId) && pi.IngredientName !== newName) {
      const prefix = (pi.Title || '').split(' — ')[0] || '';
      const newTitle = prefix ? `${prefix} — ${newName}` : newName;
      patches.push(
        updateListItem(LISTS.prepItemIngredients, pi.id, { IngredientName: newName, Title: newTitle })
          .then(() => { pi.IngredientName = newName; pi.Title = newTitle; })
      );
    }
  }

  // 3. COG recipes — match by IngredientId
  for (const cog of (cache.cogsRecipes || [])) {
    if (String(cog.IngredientId) === String(itemId) && cog.IngredientName !== newName) {
      const newTitle = `${cog.MenuItemName || ''} — ${cog.VariationName || ''} — ${newName}`;
      patches.push(
        updateListItem(LISTS.cogs, cog.id, { IngredientName: newName, Title: newTitle })
          .then(() => { cog.IngredientName = newName; cog.Title = newTitle; })
      );
    }
  }

  if (!patches.length) return 0;
  const results = await Promise.allSettled(patches);
  return results.filter(r => r.status === 'fulfilled').length;
}

async function saveInventoryItem() {
  const name = document.getElementById('new-item-name').value.trim();
  if (!name) { toast('err','Item name is required'); return; }

  // Flush pending category custom input if user typed but didn't blur
  const catNewInp = document.getElementById('new-item-cat-custom');
  if (catNewInp && catNewInp.style.display !== 'none') finishInvCatNew(catNewInp);

  // Auto-create vendor if user typed a new name but didn't click Add
  const supSel = document.getElementById('new-item-supplier');
  if (supSel && supSel.value === '__new__') {
    const newVendorName = document.getElementById('new-item-supplier-name')?.value?.trim() || '';
    if (newVendorName) {
      try {
        const vItem = await addListItem(LISTS.vendors, { Title: newVendorName, Active: 'Yes' });
        const norm = { ...vItem, Title: vItem.Title || newVendorName, Active: 'Yes' };
        cache.vendors.push(norm);
        populateInvVendorSelect(newVendorName);
        renderVendors();
      } catch(e) { toast('err', 'Could not create vendor: ' + e.message); return; }
    } else {
      supSel.value = ''; // nothing typed, clear the __new__ sentinel
    }
  }

  const cfg = invCfg();
  let fields;
  if (cfg.isMerch) {
    // Tags / Category / ItemNo dropped from BSC_MerchInventory: Square is the
    // identity source for merch; no per-row tagging or categorization here.
    // SquareCatalogItemId is intentionally NOT in this payload — it's set by
    // Square sync only and the field was removed from the edit form. The
    // null-drop below preserves the existing stored value untouched.
    fields = {
      ItemName:            name,
      Title:               name,
      Supplier:            (() => { const s = document.getElementById('new-item-supplier'); return s.value === '__new__' ? (document.getElementById('new-item-supplier-name')?.value?.trim()||'') : s.value; })(),
      CostPerUnit:         parseFloat(document.getElementById('new-item-cost-unit').value)||null,
    };
  } else {
    fields = {
      ItemName:        name,
      Title:           name,
      ...(invHasCategory() ? { Category: (() => { const s = document.getElementById('new-item-cat'); return s.value === '__new__' ? (document.getElementById('new-item-cat-custom')?.value?.trim()||'') : s.value; })() } : {}),
      Tags:            getTagEditorValue('inv-item')||null,
      Supplier:        (() => { const s = document.getElementById('new-item-supplier'); return s.value === '__new__' ? (document.getElementById('new-item-supplier-name')?.value?.trim()||'') : s.value; })(),
      OrderSize:       parseFloat(document.getElementById('new-item-order-size').value)||null,
      OrderUnit:       document.getElementById('new-item-unit').value,
      Unit:            document.getElementById('new-item-unit').value,
      // NOTE: ParLevel + ReorderTrigger are now per-location (BSC_InventoryPars),
      // written separately after the master item save below.
      CostPerCase:     parseFloat(document.getElementById('new-item-cost').value)||null,
      ServingUnit:     document.getElementById('new-item-serving-unit')?.value||null,
      ServingsPerUnit: parseFloat(document.getElementById('new-item-servings')?.value)||null,
      CostPerServing:  (() => { const c=parseFloat(document.getElementById('new-item-cost').value)||0; const s=parseFloat(document.getElementById('new-item-servings')?.value)||0; return (c>0&&s>0) ? +(c/s).toFixed(6) : null; })(),
    };
  }
  Object.keys(fields).forEach(k=>{ if(fields[k]===null||fields[k]==='') delete fields[k]; });
  setLoading(true,'Saving…');
  try {
    let savedItemId = _editInvId;
    if (_editInvId) {
      // Edit mode — capture old name BEFORE updating cache, for rename propagation
      const existing = cache[cfg.cacheKey].find(i => i.id === _editInvId);
      const oldName = existing ? (existing.ItemName || existing.Title || '') : '';
      await updateListItem(LISTS[cfg.listKey], _editInvId, fields);
      const idx = cache[cfg.cacheKey].findIndex(i => i.id === _editInvId);
      if (idx !== -1) cache[cfg.cacheKey][idx] = { ...cache[cfg.cacheKey][idx], ...fields };
      let propagated = 0;
      if (oldName && oldName.trim() !== name.trim()) {
        try { propagated = await propagateInventoryNameChange(_editInvId, oldName, name); }
        catch(e) { console.warn('Name propagation failed:', e); }
      }
      toast('ok', propagated ? `✓ Item updated (${propagated} reference${propagated===1?'':'s'} renamed)` : '✓ Item updated');
    } else {
      // Add mode
      const item = await addListItem(LISTS[cfg.listKey], fields);
      cache[cfg.cacheKey].push(item);
      savedItemId = item.id;
      toast('ok','✓ Item added');
    }
    // Per-location par + reorder trigger: upsert BSC_InventoryPars rows for
    // any location whose input changed. Blank inputs are treated as "clear"
    // → null (doesn't delete the SP row, just empties both numeric fields).
    if (!cfg.isMerch && savedItemId) {
      try { await saveInvParTable(savedItemId); }
      catch (e) { console.warn('[par save] failed:', e.message); toast('err', 'Par/trigger save failed: ' + e.message); }
    }
    renderInventory(); renderDashboard(); populateSelects();
    if (typeof renderRecipes === 'function') renderRecipes();
    closeModal('modal-add-item');
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}

// ── Per-location par/trigger table ────────────────────────────────
// Injects one row per location into #inv-par-table-wrap. When editing
// an item, pre-fills each row from cache.inventoryPars (falling back to
// the legacy item.ParLevel / item.ReorderTrigger for locations that
// haven't been migrated yet). Safe to call with null for "add" mode.
function renderInvParTable(item) {
  const wrap = document.getElementById('inv-par-table-wrap');
  if (!wrap) return;
  const locs = (typeof getLocations === 'function' ? getLocations() : []) || [];
  if (!locs.length) {
    wrap.innerHTML = '<div style="padding:10px;font-size:12px;color:var(--muted);">No locations configured. Add locations in Settings before setting pars.</div>';
    return;
  }
  const legacyPar  = item ? (+item.ParLevel        || 0) : 0;
  const legacyTrig = item ? (+item.ReorderTrigger  || 0) : 0;
  const rowsHtml = locs.map(loc => {
    // Pre-populate inputs with the current effective threshold so users see
    // the truth for this location. Precedence: per-location row → legacy
    // master → blank. data-initial lets saveInvParTable detect untouched
    // rows and skip their writes (no churn for unrelated edits).
    let par = '', trig = '';
    if (item) {
      const row = (typeof getInvParRow === 'function') ? getInvParRow(item.id, loc) : null;
      if (row) {
        if (row.ParLevel       != null && row.ParLevel       !== '') par  = row.ParLevel;
        if (row.ReorderTrigger != null && row.ReorderTrigger !== '') trig = row.ReorderTrigger;
      } else {
        // No per-location row yet — fall back to the legacy master so the
        // user can see and edit (including clearing) the effective value.
        if (legacyPar  > 0) par  = legacyPar;
        if (legacyTrig > 0) trig = legacyTrig;
      }
    }
    const locSafe = escHtml(loc);
    const parStr  = par  === '' ? '' : escHtml(String(par));
    const trigStr = trig === '' ? '' : escHtml(String(trig));
    return `<tr data-loc="${locSafe}">
      <td style="padding:6px 10px;font-size:13px;font-weight:600;white-space:nowrap;">${locSafe}</td>
      <td style="padding:4px 6px;"><input class="inv-par-inp" data-loc="${locSafe}" data-initial="${parStr}" type="number" step="0.1" placeholder="—" value="${parStr}" style="width:100%;padding:5px 8px;font-size:13px;"></td>
      <td style="padding:4px 6px;"><input class="inv-trigger-inp" data-loc="${locSafe}" data-initial="${trigStr}" type="number" step="0.1" placeholder="—" value="${trigStr}" style="width:100%;padding:5px 8px;font-size:13px;"></td>
    </tr>`;
  }).join('');
  const hint = (legacyPar > 0 || legacyTrig > 0)
    ? `<div style="padding:6px 10px;font-size:11px;color:var(--muted);border-top:1px solid var(--border);background:var(--cream);">Legacy master — Par: ${legacyPar}, Trigger: ${legacyTrig}. Per-location values above override this. Clear a field to mean "no threshold for that location".</div>`
    : '';
  wrap.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:var(--opal);">
          <th style="padding:6px 10px;text-align:left;font-size:12px;">Location</th>
          <th style="padding:6px 10px;text-align:left;font-size:12px;">Par</th>
          <th style="padding:6px 10px;text-align:left;font-size:12px;">Reorder Trigger</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>${hint}`;
}

// Reads every row in the par table and upserts the matching
// BSC_InventoryPars record. Serial writes — small N (≤ ~6 locations)
// so throttling isn't a concern.
async function saveInvParTable(itemId) {
  if (!itemId) return;
  const rows = document.querySelectorAll('#inv-par-table-wrap tbody tr');
  if (!rows.length) return;
  for (const tr of rows) {
    const loc = tr.dataset.loc;
    if (!loc) continue;
    const parInp  = tr.querySelector('.inv-par-inp');
    const trigInp = tr.querySelector('.inv-trigger-inp');
    const parStr  = parInp?.value.trim()  || '';
    const trigStr = trigInp?.value.trim() || '';
    const parVal  = parStr  === '' ? null : (parseFloat(parStr)  || 0);
    const trigVal = trigStr === '' ? null : (parseFloat(trigStr) || 0);
    const existing = (typeof getInvParRow === 'function') ? getInvParRow(itemId, loc) : null;
    // Initial-value tracking: inputs are rendered with their current
    // effective value (row → legacy → blank). If the user didn't touch a
    // field, skip the write — prevents unrelated item edits from churning
    // par rows. If they did edit, always upsert (blank = explicit clear).
    const initPar  = parInp?.dataset.initial  ?? '';
    const initTrig = trigInp?.dataset.initial ?? '';
    const parChanged  = parStr  !== initPar;
    const trigChanged = trigStr !== initTrig;
    if (!parChanged && !trigChanged) continue;
    try {
      if (existing) {
        const patch = { ParLevel: parVal, ReorderTrigger: trigVal };
        await updateListItem(LISTS.inventoryPars, existing.id, patch);
        existing.ParLevel = parVal; existing.ReorderTrigger = trigVal;
      } else {
        const rec = await addListItem(LISTS.inventoryPars, {
          Title:    invParKey(itemId, loc),
          ItemId:   String(itemId),
          Location: loc,
          ParLevel: parVal,
          ReorderTrigger: trigVal
        });
        cache.inventoryPars.push(rec);
      }
    } catch (e) {
      console.warn('[par save] row failed:', loc, e.message);
    }
  }
}

// ── Vendor select / inline vendor creation ────────────────────────
function getActiveVendorNames() {
  return [...new Set(
    cache.vendors
      .filter(v => { const val=(v.Active||'').toString().toLowerCase(); return val===''||val==='yes'||val==='true'||val==='1'; })
      .map(v => v.VendorName || v.Title || '')
      .filter(Boolean)
  )].sort();
}

function populateInvVendorSelect(currentVal) {
  const sel = document.getElementById('new-item-supplier');
  if (!sel) return;
  const names = getActiveVendorNames();
  // If editing and the saved supplier isn't in the active list, include it
  if (currentVal && currentVal !== '__new__' && !names.includes(currentVal)) names.push(currentVal);
  sel.innerHTML = '<option value="">— Select vendor —</option>' +
    names.map(n=>`<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('') +
    '<option value="__new__">＋ New vendor…</option>';
  if (currentVal && currentVal !== '__new__') sel.value = currentVal;
  const inline = document.getElementById('new-vendor-inline');
  if (inline) inline.style.display = 'none';
  const nameInput = document.getElementById('new-item-supplier-name');
  if (nameInput) nameInput.value = '';
}

function onInvVendorChange(sel) {
  const inline = document.getElementById('new-vendor-inline');
  if (!inline) return;
  if (sel.value === '__new__') {
    inline.style.display = '';
    document.getElementById('new-item-supplier-name')?.focus();
  } else {
    inline.style.display = 'none';
    const ni = document.getElementById('new-item-supplier-name');
    if (ni) ni.value = '';
  }
}

async function createVendorQuick() {
  const nameInput = document.getElementById('new-item-supplier-name');
  const name = (nameInput?.value || '').trim();
  if (!name) { nameInput?.focus(); return; }
  setLoading(true, 'Creating vendor…');
  try {
    const item = await addListItem(LISTS.vendors, { Title: name, Active: 'Yes' });
    cache.vendors.push(item);
    populateSelects();
    populateInvVendorSelect(name);
    toast('ok', `✓ Vendor "${name}" added`);
  } catch(e) { toast('err', 'Failed to create vendor: ' + e.message); }
  finally { setLoading(false); }
}

// ── Inventory category select ─────────────────────────────────────
function onInvCatChange(sel) {
  const inp = document.getElementById('new-item-cat-custom');
  if (!inp) return;
  if (sel.value === '__new__') {
    inp.style.display = '';
    inp.focus();
  } else {
    inp.style.display = 'none';
    inp.value = '';
  }
}

function finishInvCatNew(inp) {
  const val = inp.value.trim();
  const sel = document.getElementById('new-item-cat');
  if (!sel) return;
  if (!val) {
    // revert to first visible option
    const firstVisible = [...sel.options].find(o => o.value !== '__new__' && o.style.display !== 'none');
    sel.value = firstVisible ? firstVisible.value : '';
  } else {
    let opt = [...sel.options].find(o => o.value === val);
    if (!opt) {
      opt = new Option(val, val);
      sel.insertBefore(opt, sel.querySelector('option[value="__new__"]'));
    }
    sel.value = val;
  }
  inp.style.display = 'none';
}
