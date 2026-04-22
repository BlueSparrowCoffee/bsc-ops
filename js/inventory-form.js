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
  document.querySelector('#modal-add-item .modal-title').textContent = 'Add ' + cfg.label + ' Item';
  document.querySelector('#modal-add-item .btn-primary').textContent = 'Save Item';
  // clear form
  ['new-item-name','new-item-no','new-item-cost-unit','new-item-square-id',
   'new-item-order-size','new-item-unit','new-item-par','new-item-reorder-trigger',
   'new-item-cost','new-item-serving-unit','new-item-servings'
  ].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
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
  document.getElementById('inv-item-tags-editor').innerHTML = tagEditorHTML('inv-item');
  initTagEditor('inv-item', '');
  calcCostPerServing();
  // Hide archive/delete — add mode only
  ['inv-modal-archive-btn','inv-modal-delete-btn'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  openModal('modal-add-item');
}

function openEditInvItem(id) {
  const cfg = invCfg();
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
  if (cfg.isMerch) {
    document.getElementById('new-item-no').value          = item.ItemNo || '';
    document.getElementById('new-item-cost-unit').value   = item.CostPerUnit != null ? item.CostPerUnit : '';
    document.getElementById('new-item-square-id').value   = item.SquareCatalogItemId || '';
  } else {
    populateInvVendorSelect(item.Supplier || '');
    document.getElementById('new-item-order-size').value   = item.OrderSize != null ? item.OrderSize : '';
    document.getElementById('new-item-unit').value         = item.OrderUnit || item.Unit || '';
    document.getElementById('new-item-par').value          = item.ParLevel != null ? item.ParLevel : '';
    if (document.getElementById('new-item-reorder-trigger'))
      document.getElementById('new-item-reorder-trigger').value = item.ReorderTrigger != null ? item.ReorderTrigger : '';
    document.getElementById('new-item-cost').value         = item.CostPerCase != null ? item.CostPerCase : '';
    if (document.getElementById('new-item-serving-unit'))
      document.getElementById('new-item-serving-unit').value = item.ServingUnit || '';
    if (document.getElementById('new-item-servings'))
      document.getElementById('new-item-servings').value   = item.ServingsPerUnit != null ? item.ServingsPerUnit : '';
    calcCostPerServing();
  }
  document.getElementById('inv-item-tags-editor').innerHTML = tagEditorHTML('inv-item');
  initTagEditor('inv-item', item.Tags||'');
  // Show archive/delete buttons for edit mode (owner only)
  const archBtn = document.getElementById('inv-modal-archive-btn');
  const delBtn  = document.getElementById('inv-modal-delete-btn');
  if (archBtn) { archBtn.style.display = isOwner() ? '' : 'none'; archBtn.textContent = item.Archived ? '📤 Unarchive' : '📦 Archive'; }
  if (delBtn)  { delBtn.style.display  = isOwner() ? '' : 'none'; }
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
    toast('ok', isArchived ? '✓ Item unarchived' : '✓ Item archived');
  } catch(e) { toast('err', 'Failed: ' + e.message); }
  finally { setLoading(false); }
}

async function deleteInvItem(id) {
  if (!isOwner()) { toast('err', 'Owner access required'); return; }
  const cfg = invCfg();
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
    fields = {
      ItemName:            name,
      Title:               name,
      Category:            (() => { const s = document.getElementById('new-item-cat'); return s.value === '__new__' ? (document.getElementById('new-item-cat-custom')?.value?.trim()||'') : s.value; })(),
      ItemNo:              document.getElementById('new-item-no').value.trim()||null,
      CostPerUnit:         parseFloat(document.getElementById('new-item-cost-unit').value)||null,
      SquareCatalogItemId: document.getElementById('new-item-square-id').value.trim()||null,
      Tags:                getTagEditorValue('inv-item')||null,
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
      ParLevel:        parseFloat(document.getElementById('new-item-par').value)||0,
      ReorderTrigger:  parseFloat(document.getElementById('new-item-reorder-trigger')?.value)||null,
      CostPerCase:     parseFloat(document.getElementById('new-item-cost').value)||null,
      ServingUnit:     document.getElementById('new-item-serving-unit')?.value||null,
      ServingsPerUnit: parseFloat(document.getElementById('new-item-servings')?.value)||null,
      CostPerServing:  (() => { const c=parseFloat(document.getElementById('new-item-cost').value)||0; const s=parseFloat(document.getElementById('new-item-servings')?.value)||0; return (c>0&&s>0) ? +(c/s).toFixed(6) : null; })(),
    };
  }
  Object.keys(fields).forEach(k=>{ if(fields[k]===null||fields[k]==='') delete fields[k]; });
  setLoading(true,'Saving…');
  try {
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
      toast('ok','✓ Item added');
    }
    renderInventory(); renderDashboard(); populateSelects();
    if (typeof renderRecipes === 'function') renderRecipes();
    closeModal('modal-add-item');
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
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
