/* ================================================================
 * BSC Ops — cogs.js
 * Cost of Goods: menu COG recipes (Coffee Bar), inventory COG tabs
 * (Merch / Food / Grocery), snapshot history, overview + chart, and
 * all Square-driven price/cost sync flows.
 *
 * Depends on:
 *   - state.js     (cache)
 *   - constants.js (LISTS, INV_COG_CFG)
 *   - utils.js     (escHtml, toast, openModal, invItemLink)
 *   - graph.js     (graph, getSiteId, addListItem, updateListItem)
 *   - auth.js      (isManagerOrOwner)
 *   - settings.js  (saveSetting)
 *   - prepItems.js (buildPrepItemMap — still lives in index.html for now)
 *   - square.js    (squareAPI — still lives in index.html for now)
 * ================================================================ */

// Build a lookup map: { [menuItemId+':'+variationName]: [cogRecipeRows] }
function buildCogMap() {
  const map = {};
  for (const r of cache.cogsRecipes) {
    const key = (r.MenuItemId||'') + ':' + (r.VariationName||'');
    if (!map[key]) map[key] = [];
    map[key].push(r);
  }
  return map;
}

// Build inventory lookup by item name (Title or ItemName)
function buildInvMap() {
  const map = {};
  for (const i of cache.inventory) {
    const n = (i.ItemName || i.Title || '').toLowerCase().trim();
    if (n) map[n] = i;
  }
  return map;
}

// Build inventory lookup by SharePoint item ID
function buildInvIdMap() {
  const map = {};
  for (const i of cache.inventory) {
    if (i.id) map[String(i.id)] = i;
  }
  return map;
}

// Calculate COG for one variation
function calcCog(menuItemId, variationName, cogMap, invMap, prepMap, invIdMap) {
  const key = menuItemId + ':' + variationName;
  const ingredients = cogMap[key] || [];
  let cog = 0;
  let hasMissingCost = false;
  const lines = ingredients.map(ing => {
    const name = (ing.IngredientName||'').toLowerCase().trim();
    // Prefer ID-based lookup (immune to renames); fall back to name match for legacy rows
    const inv  = (invIdMap && ing.IngredientId) ? (invIdMap[String(ing.IngredientId)] || invMap[name]) : invMap[name];
    const prep = (!inv && prepMap) ? prepMap[name] : null;
    const source = inv || prep;
    const costPerServing = source ? (parseFloat(source.CostPerServing) || 0) : null;
    const isPrepItem = !inv && !!prep;
    const qty = parseFloat(ing.Quantity) || 0;
    const lineCost = costPerServing != null ? qty * costPerServing : null;
    if (lineCost == null || costPerServing == null) hasMissingCost = true;
    else cog += lineCost;
    return { ...ing, costPerServing, lineCost, isPrepItem, servingUnit: isPrepItem ? (source?.YieldUnit || '') : (source?.ServingUnit || '') };
  });
  return { cog, lines, hasMissingCost };
}

// Get selling price for a variation from cache.menu
// Parse variation names from a menu item's Variations string
function getVariationNames(menuItem) {
  const vars = (menuItem.Variations || '').split('\n').filter(Boolean);
  if (!vars.length) return [{ name: 'Regular', price: parseFloat(menuItem.Price)||null }];
  return vars.map(v => {
    const match = v.match(/^(.+):\s*\$?(\d+\.?\d*)$/);
    return match
      ? { name: match[1].trim(), price: parseFloat(match[2]) }
      : { name: v.trim(), price: null };
  });
}

// -- Snapshot ----------------------------------------------------------------

async function snapshotCogs() {
  if (!confirm('Save a cost snapshot of all current recipes? This records today\'s COG and margin per item/variation.')) return;
  try {
    const siteId = await getSiteId();
    const cogMap = buildCogMap();
    const invMap = buildInvMap();
    const invIdMap = buildInvIdMap();
    const prepMap = buildPrepItemMap();
    let count = 0;
    const now = new Date().toISOString();
    for (const item of cache.menu) {
      const itemId   = item.SquareId || item.id;
      if (_cogsHiddenIds.has(itemId)) continue; // skip hidden items
      const itemName = item.ItemName || item.Title || '';
      const variations = getVariationNames(item);
      for (const v of variations) {
        const { cog, hasMissingCost } = calcCog(itemId, v.name, cogMap, invMap, prepMap, invIdMap);
        if (hasMissingCost || !v.price) continue;
        const margin = ((v.price - cog) / v.price) * 100;
        const fields = {
          Title:          itemName + ' — ' + v.name + ' — ' + now.slice(0,10),
          MenuItemId:     itemId,
          MenuItemName:   itemName,
          VariationName:  v.name,
          SellingPrice:   v.price,
          COG:            Math.round(cog * 1000) / 1000,
          GrossMargin:    Math.round(margin * 10) / 10,
          SnapshotDate:   now
        };
        const saved = await addListItem(LISTS.cogHistory, fields);
        cache.cogSnapshots.push(saved);
        count++;
      }
    }
    toast('ok', `📸 Snapshot saved — ${count} variation records`);
    renderCogHistory();
    renderCogsOverview(); // chart reads latest snapshot per item — refresh it
  } catch(e) {
    toast('err', 'Snapshot failed: ' + e.message);
  }
}

// -- Rendering ---------------------------------------------------------------

let _cogsQuery = '';
let _cogsCatFilters = new Set();
const _cogsActiveVar = {}; // itemId → active variation index, persists across re-renders
let _cogsHiddenIds = new Set(JSON.parse(localStorage.getItem('bsc_cogs_hidden')||'[]'));
let _cogsMissingOnly = false;

function toggleCogsMissingFilter() {
  _cogsMissingOnly = !_cogsMissingOnly;
  const banner = document.getElementById('cogs-missing-costs');
  const label  = document.getElementById('cogs-missing-filter-label');
  if (_cogsMissingOnly) {
    banner.style.background   = '#fef3c7';
    banner.style.borderColor  = '#d97706';
    label.textContent = 'Show all items';
  } else {
    banner.style.background   = '#fff8e1';
    banner.style.borderColor  = '#f59e0b';
    label.textContent = 'Filter to affected items';
  }
  renderCogCards();
}

// ── Inventory COG tab state (INV_COG_CFG moved to js/constants.js) ──────────
const _invCogState = {
  merch:   { query:'', hiddenIds: new Set(JSON.parse(localStorage.getItem('bsc_merch_cogs_hidden')||'[]'))   },
  food:    { query:'', hiddenIds: new Set(JSON.parse(localStorage.getItem('bsc_food_cogs_hidden')||'[]'))    },
  grocery: { query:'', hiddenIds: new Set(JSON.parse(localStorage.getItem('bsc_grocery_cogs_hidden')||'[]')) },
};

// ── Multi-select category filter ─────────────────────────────────────────────

function onMultiCatAll(which) {
  const set = which === 'cogs' ? _cogsCatFilters : _cogsMerchCatFilters;
  set.clear();
  const panel = document.getElementById(`${which}-cat-panel`);
  if (panel) {
    panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
    const allCb = panel.querySelector(`#${which}-cat-all`);
    if (allCb) allCb.checked = true;
  }
  updateMultiCatBtn(which, set);
  which === 'cogs' ? renderCogCards() : renderMerchCogCards();
}

function onMultiCatChange(which, cat) {
  const set = which === 'cogs' ? _cogsCatFilters : _cogsMerchCatFilters;
  if (set.has(cat)) set.delete(cat);
  else set.add(cat);
  const panel = document.getElementById(`${which}-cat-panel`);
  if (panel) {
    const cb = panel.querySelector(`#${which}-cat-${CSS.escape(cat)}`);
    if (cb) cb.checked = set.has(cat);
    const allCb = panel.querySelector(`#${which}-cat-all`);
    if (allCb) allCb.checked = set.size === 0;
  }
  updateMultiCatBtn(which, set);
  which === 'cogs' ? renderCogCards() : renderMerchCogCards();
}

function updateMultiCatBtn(which, set) {
  const btn = document.getElementById(`${which}-cat-btn`);
  if (!btn) return;
  if (set.size === 0) {
    btn.textContent = 'All Categories ▾';
    btn.classList.remove('active');
  } else if (set.size === 1) {
    btn.textContent = `${[...set][0]} ▾`;
    btn.classList.add('active');
  } else {
    btn.textContent = `${set.size} Categories ▾`;
    btn.classList.add('active');
  }
}

// Close multi-cat panels when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.multi-cat-wrap')) {
    document.querySelectorAll('.multi-cat-panel.open').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.multi-cat-btn.open').forEach(b => b.classList.remove('open'));
  }
});

function cogTab(tab) {
  const tabs = ['overview','coffee-bar','merch','food','grocery','history'];
  const active   = 'color:var(--gold);border-bottom:2px solid var(--gold);margin-bottom:-2px;';
  const inactive = 'color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-2px;';
  tabs.forEach(t => {
    const panel = document.getElementById(`cogs-panel-${t}`);
    const btn   = document.getElementById(`cogs-tab-${t}`);
    if (panel) panel.style.display = t === tab ? '' : 'none';
    if (btn)   btn.style.cssText  += t === tab ? active : inactive;
  });
  if (tab === 'overview') renderCogsOverview();
  if (tab === 'history')  renderCogHistory();
  if (tab === 'merch')    renderInvCogCards('merch');
  if (tab === 'food')     renderInvCogCards('food');
  if (tab === 'grocery')  renderInvCogCards('grocery');
}

function filterCogs(q) {
  _cogsQuery = (q||'').toLowerCase();
  renderCogCards();
}

function renderCogs() {
  if (!isManagerOrOwner()) {
    document.getElementById('cogs-access-denied').style.display = '';
    document.getElementById('cogs-content').style.display = 'none';
    return;
  }
  document.getElementById('cogs-access-denied').style.display = 'none';
  document.getElementById('cogs-content').style.display = '';

  // Populate history item filter
  const histSel = document.getElementById('cogs-hist-item');
  if (histSel) {
    const names = [...new Set(cache.menu.filter(i=>!_cogsHiddenIds.has(i.SquareId||i.id)).map(i => i.ItemName||i.Title||'').filter(Boolean))].sort();
    histSel.innerHTML = '<option value="">All Items</option>'
      + names.map(n=>`<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
  }

  // Check for missing costs — mirrors calcCog logic exactly
  const invMap   = buildInvMap();
  const invIdMap = buildInvIdMap();
  const prepMap  = buildPrepItemMap();
  const cogMap   = buildCogMap();
  const visibleMenuIds = new Set(
    cache.menu
      .filter(i => (i.Category||'').toLowerCase() === 'coffee bar' && !_cogsHiddenIds.has(i.SquareId||i.id))
      .map(i => i.SquareId || i.id)
  );
  let missingCosts = false;
  outer: for (const r of cache.cogsRecipes) {
    if (!visibleMenuIds.has(r.MenuItemId)) continue;
    const name = (r.IngredientName||'').toLowerCase().trim();
    const inv  = (r.IngredientId ? (invIdMap[String(r.IngredientId)] || invMap[name]) : invMap[name]);
    // Skip archived inventory items — they don't count as "missing"
    if (inv?.Archived) continue;
    const prep = prepMap[name];
    const source = inv || prep;
    // Missing = ingredient not found at all (calcCog sets hasMissingCost when costPerServing is null)
    if (!source) { missingCosts = true; break outer; }
  }
  document.getElementById('cogs-missing-costs').style.display = missingCosts ? '' : 'none';

  // Re-render every sub-tab that has rendered DOM. SignalR refreshes pipe
  // through here, and prior to this we only repainted the Coffee Bar cards —
  // so the Overview chart, Merch/Food/Grocery COG views and History trend
  // would all sit stale until the user tabbed away and back.
  renderCogCards();
  renderCogsOverview();
  if (document.getElementById('cogs-panel-merch')?.style.display !== 'none')   renderInvCogCards('merch');
  if (document.getElementById('cogs-panel-food')?.style.display !== 'none')    renderInvCogCards('food');
  if (document.getElementById('cogs-panel-grocery')?.style.display !== 'none') renderInvCogCards('grocery');
  if (document.getElementById('cogs-panel-history')?.style.display !== 'none') renderCogHistory();
}

function toggleCogHidden(itemId) {
  if (_cogsHiddenIds.has(itemId)) _cogsHiddenIds.delete(itemId);
  else _cogsHiddenIds.add(itemId);
  const json = JSON.stringify([..._cogsHiddenIds]);
  localStorage.setItem('bsc_cogs_hidden', json);
  saveSetting('cogs_hidden', json).catch(() => {});
  renderCogCards();
  renderCogsOverview();
}

function toggleOverviewCogHidden(type, id) {
  if (type === 'coffee-bar') {
    if (_cogsHiddenIds.has(id)) _cogsHiddenIds.delete(id);
    else _cogsHiddenIds.add(id);
    const json = JSON.stringify([..._cogsHiddenIds]);
    localStorage.setItem('bsc_cogs_hidden', json);
    saveSetting('cogs_hidden', json).catch(() => {});
  } else {
    const state = _invCogState[type];
    const cfg   = INV_COG_CFG[type];
    if (!state || !cfg) return;
    if (state.hiddenIds.has(id)) state.hiddenIds.delete(id);
    else state.hiddenIds.add(id);
    const json = JSON.stringify([...state.hiddenIds]);
    localStorage.setItem(cfg.hiddenKey, json);
    saveSetting(cfg.hiddenKey, json).catch(() => {});
  }
  renderCogsOverview();
}

// ── Merch Costs ──────────────────────────────────────────────────────────────

async function syncGroceryCostFromInventory() {
  const btn   = document.getElementById('grocery-inv-sync-btn');
  const logEl = document.getElementById('grocery-inv-sync-log');
  btn.disabled = true; btn.textContent = 'Syncing…';
  logEl.style.display = ''; logEl.textContent = '';
  const log = msg => { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; };

  try {
    // Build name → CostPerServing map from consumable inventory
    const invCostMap = {};
    for (const item of (cache.inventory || [])) {
      const name = (item.ItemName || item.Title || '').toLowerCase().trim();
      const cost = parseFloat(item.CostPerServing);
      if (name && !isNaN(cost) && cost > 0) invCostMap[name] = { cost, raw: item.ItemName || item.Title };
    }
    log(`Found ${Object.keys(invCostMap).length} costed items in consumable inventory`);

    let updated = 0, unchanged = 0, notFound = 0;
    for (const item of (cache.groceryInventory || [])) {
      const itemName = (item.ItemName || item.Title || '').toLowerCase().trim();
      const match = invCostMap[itemName];
      if (!match) { notFound++; log(`  ⚠ Not in inventory: ${item.ItemName || item.Title}`); continue; }
      if (item.CostPerUnit === match.cost) { unchanged++; continue; }
      await updateListItem(LISTS.groceryInventory, item.id, { CostPerUnit: match.cost });
      item.CostPerUnit = match.cost;
      updated++;
      log(`  ✓ ${item.ItemName || item.Title}: $${match.cost.toFixed(4)}`);
    }

    log(`\n✅ Done — ${updated} updated, ${unchanged} unchanged, ${notFound} not found in inventory`);
    renderInvCogCards('grocery');
    renderCogsOverview();
    toast('ok', `✓ Grocery cost synced from inventory (${updated} updated)`);
  } catch(e) {
    log('Error: ' + e.message);
    toast('err', 'Sync failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '📦 Sync Cost from Inventory';
  }
}

async function syncFoodCostFromPars() {
  const btn   = document.getElementById('food-pars-sync-btn');
  const logEl = document.getElementById('food-pars-sync-log');
  btn.disabled = true; btn.textContent = 'Syncing…';
  logEl.style.display = ''; logEl.textContent = '';
  const log = msg => { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; };

  try {
    // Build name → cost map from pastry + sandwich par master items
    const parItems = (cache.foodPars || []).filter(p => {
      const cat = (p.Category || '').toLowerCase();
      return cat === 'pastries' || cat === 'sandwiches';
    });
    log(`Found ${parItems.length} pastry/sandwich par items`);

    // Build a normalised name map: lowercase + trim
    const parCostMap = {};
    for (const p of parItems) {
      const name = (p.Title || p.ItemName || '').toLowerCase().trim();
      const cost = parseFloat(p.Price);
      if (name && !isNaN(cost)) parCostMap[name] = { cost, raw: p.Title || p.ItemName || '' };
    }

    let updated = 0, unchanged = 0, notFound = 0;
    for (const item of (cache.foodInventory || [])) {
      const itemName = (item.ItemName || item.Title || '').toLowerCase().trim();
      const match = parCostMap[itemName];
      if (!match) { notFound++; log(`  ⚠ No par match: ${item.ItemName || item.Title}`); continue; }
      if (item.CostPerUnit === match.cost) { unchanged++; continue; }
      await updateListItem(LISTS.foodInventory, item.id, { CostPerUnit: match.cost });
      item.CostPerUnit = match.cost;
      updated++;
      log(`  ✓ ${item.ItemName || item.Title}: $${match.cost.toFixed(2)}`);
    }

    log(`\n✅ Done — ${updated} updated, ${unchanged} unchanged, ${notFound} not found in pars`);
    renderInvCogCards('food');
    renderCogsOverview();
    toast('ok', `✓ Cost synced from pars (${updated} updated)`);
  } catch(e) {
    log('Error: ' + e.message);
    toast('err', 'Sync failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '🥐 Sync Cost from Pars';
  }
}

async function syncInvPricesFromSquare(tabKey) {
  const cfg   = INV_COG_CFG[tabKey];
  const btn   = document.getElementById(`${tabKey}-sq-sync-btn`);
  const logEl = document.getElementById(`${tabKey}-sq-sync-log`);
  btn.disabled = true; btn.textContent = 'Syncing…';
  logEl.style.display = ''; logEl.textContent = '';
  const log = msg => { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; };

  try {
    log('Fetching Square catalog…');
    let objects = [], cursor = null;
    do {
      const params = `catalog/list?types=ITEM,CATEGORY${cursor ? '&cursor='+encodeURIComponent(cursor) : ''}`;
      const data = await squareAPI('GET', params);
      objects = objects.concat(data.objects || []);
      cursor = data.cursor || null;
    } while (cursor);

    const categories = {};
    objects.filter(o => o.type === 'CATEGORY' && !o.is_deleted)
      .forEach(c => { const n = c.category_data?.name || c.category_v1_data?.name; if (n) categories[c.id] = n; });

    const resolveCategory = d => {
      const catArr = d.categories || [];
      if (catArr.length) {
        const embedded = catArr[0]?.name || catArr[0]?.category_data?.name;
        if (embedded) return embedded;
        const id = catArr[0]?.id || catArr[0];
        if (id && categories[id]) return categories[id];
      }
      if (d.reporting_category?.id) return categories[d.reporting_category.id] || d.reporting_category?.name || null;
      if (d.category_id) return categories[d.category_id] || null;
      return null;
    };

    // Build a display name for a variation. If the variation's own name is
    // blank or generic ("Regular"/"Default"), fall back to the parent name —
    // otherwise render as "Parent - Variation".
    const combinedNameFor = (parentName, variationName) => {
      const v = (variationName || '').trim();
      if (!v || /^(regular|default)$/i.test(v)) return parentName;
      return `${parentName} - ${v}`;
    };

    const priceMap = {}, catMap = {}, nameMap = {}, nameToSqId = {}, archivedMap = {};
    for (const obj of objects) {
      if (obj.type !== 'ITEM' || obj.is_deleted) continue;
      const d = obj.item_data || {};
      archivedMap[obj.id] = !!d.is_archived;               // Square → SP archive propagation
      const vars = d.variations || [];
      const priced = vars.filter(v => v.item_variation_data?.price_money);
      const cat = resolveCategory(d);
      catMap[obj.id] = cat;
      const objName = (d.name || '').trim();
      if (objName) {
        nameMap[obj.id] = objName;                         // Square → SP name propagation
        nameToSqId[objName.toLowerCase()] = obj.id;        // name-based orphan linking
      }
      if (!priced.length) continue;
      priceMap[obj.id] = priced[0].item_variation_data.price_money.amount / 100;
      for (const v of priced) {
        priceMap[v.id] = v.item_variation_data.price_money.amount / 100;
        catMap[v.id] = cat;
        // Propagate parent archive flag to each variation, OR-ed with variation's own flag.
        archivedMap[v.id] = !!d.is_archived || !!v.item_variation_data?.is_archived;
        // Per-variation name indexing — only emitted when the parent has >1
        // priced variation (the "meaningful variations" case). Single-variation
        // items stay keyed by parent ID so their behavior is unchanged.
        if (priced.length > 1 && objName) {
          const combined = combinedNameFor(objName, v.item_variation_data?.name || '');
          nameMap[v.id] = combined;
          nameToSqId[combined.toLowerCase()] = v.id;
        }
      }
    }
    const archivedCount = Object.values(archivedMap).filter(Boolean).length;
    log(`Found ${Object.keys(priceMap).length} priced entries, ${Object.keys(categories).length} categories, ${archivedCount} archived items`);

    // Import any missing items from the matching Square category. For merch,
    // Square items with >1 priced variation are expanded — each variation
    // becomes its own row (see importTargets below). Archived-in-Square
    // items are NOT imported — user already hid them upstream.
    const squareCatItems = objects.filter(o => {
      if (o.type !== 'ITEM' || o.is_deleted) return false;
      if (o.item_data?.is_archived) return false;
      return (resolveCategory(o.item_data || {})||'').toLowerCase() === cfg.squareCat.toLowerCase();
    });
    log(`${squareCatItems.length} active items in "${cfg.squareCat}" Square category (archived items skipped)`);

    const siteId = await getSiteId();
    const currentList = cache[cfg.cacheKey];
    const existingNames = new Set(currentList.map(i => (i.ItemName||i.Title||'').toLowerCase().trim()));
    const existingIds   = new Set(currentList.map(i => (i.SquareCatalogItemId||'').trim()).filter(Boolean));

    // Flatten Square category items into a list of import targets.
    // For merch with >1 priced variation, we create one target per variation
    // (linked to the variation's Square ID). Otherwise we create one target
    // for the parent (current behavior — food & grocery always take this path).
    const importTargets = [];
    for (const obj of squareCatItems) {
      const d = obj.item_data || {};
      const parentName = (d.name || '').trim();
      if (!parentName) continue;
      const cat = resolveCategory(d);
      const priced = (d.variations || []).filter(v => v.item_variation_data?.price_money);
      if (tabKey === 'merch' && priced.length > 1) {
        for (const v of priced) {
          if (v.item_variation_data?.is_archived) continue;  // skip archived variation
          const vn = combinedNameFor(parentName, v.item_variation_data?.name || '');
          const vPrice = v.item_variation_data.price_money.amount / 100;
          importTargets.push({ sqId: v.id, name: vn, price: vPrice, cat });
        }
      } else {
        const price = priceMap[obj.id] ?? null;
        importTargets.push({ sqId: obj.id, name: parentName, price, cat });
      }
    }

    let imported = 0;
    for (const t of importTargets) {
      if (existingNames.has(t.name.toLowerCase()) || existingIds.has(t.sqId)) continue;
      const fields = { ItemName: t.name, Category: t.cat || cfg.squareCat, SquareCatalogItemId: t.sqId,
        ...(t.price != null ? { SellingPrice: t.price } : {}) };
      const newItem = await addListItem(LISTS[cfg.listKey], fields);
      cache[cfg.cacheKey].push(newItem);
      existingNames.add(t.name.toLowerCase()); existingIds.add(t.sqId);
      imported++; log(`  + ${t.name}${t.price != null ? ' $'+t.price.toFixed(2) : ''}`);
    }
    if (imported) log(`Imported ${imported} new items\n`);

    // Update prices + names for all existing items. Square is the source of
    // truth for linked rows: if the Square name differs from the cached
    // ItemName/Title, we overwrite so renames in Square propagate here.
    // Also mirrors Square's is_archived flag back to SP (one-way — unarchiving
    // in Square does NOT auto-unarchive here, since SP archived state may be
    // user-driven for reasons unrelated to Square).
    let updated = 0, autoLinked = 0, renamed = 0, autoArchived = 0, unchanged = 0, notFound = 0;
    for (const item of cache[cfg.cacheKey]) {
      const itemName = (item.ItemName || item.Title || '').trim();
      let sqId = (item.SquareCatalogItemId || '').trim();
      const wasLinked = !!sqId;
      if (!sqId) { sqId = nameToSqId[itemName.toLowerCase()] || ''; if (!sqId) { notFound++; continue; } }
      const sqArchived = !!archivedMap[sqId];
      const price = priceMap[sqId];
      const cat = catMap[sqId] || null;
      const sqName = (nameMap[sqId] || '').trim();
      const fields = {};
      // Archive propagation — do this before the price short-circuit so items
      // archived (and unpriced) in Square still get archived in SP.
      if (sqArchived && !item.Archived) fields.Archived = 'yes';
      // Price — only included when Square actually has one.
      if (price != null) fields.SellingPrice = price;
      if (!wasLinked) fields.SquareCatalogItemId = sqId;
      if (cat && cat !== item.Category) fields.Category = cat;
      if (sqName && sqName !== itemName) {
        fields.ItemName = sqName;
        fields.Title = sqName;
      }

      // If we have no price AND nothing else to write, log and skip.
      if (price == null && !fields.Archived && !fields.SquareCatalogItemId && !fields.Category && !fields.ItemName) {
        notFound++; log(`  ⚠ No price: ${itemName}`); continue;
      }
      // Nothing actually changed — skip the PATCH.
      if (!Object.keys(fields).length ||
          (item.SellingPrice === price && wasLinked && !fields.Category && !fields.ItemName && !fields.Archived)) {
        unchanged++; continue;
      }

      await updateListItem(LISTS[cfg.listKey], item.id, fields);
      Object.assign(item, fields);
      if (fields.Archived) { autoArchived++; log(`  📦 Archived (matches Square): ${sqName || itemName}`); }
      if (fields.ItemName) { renamed++; log(`  ✏️ Renamed "${itemName}" → "${sqName}"`); }
      if (!wasLinked) { autoLinked++; log(`  🔗 ${sqName || itemName}${price != null ? ': $'+price.toFixed(2) : ''}`); }
      else if (!fields.ItemName && !fields.Archived && price != null) { updated++; log(`  ✓ ${sqName || itemName}: $${price.toFixed(2)}`); }
    }

    log(`\n✅ Done — ${imported} imported, ${updated} updated, ${autoLinked} auto-linked, ${renamed} renamed, ${autoArchived} auto-archived, ${unchanged} unchanged, ${notFound} not found`);
    renderInvCogCards(tabKey);
    renderCogsOverview();
    toast('ok', `✓ ${cfg.squareCat} synced`);
  } catch(e) {
    log(`❌ Error: ${e.message}`);
    toast('err', 'Sync failed: ' + e.message);
  }
  btn.disabled = false; btn.textContent = tabKey === 'merch' ? '◼ Sync Prices from Square' : '◼ Sync from Square';
}

function filterInvCogs(q, tabKey) {
  _invCogState[tabKey].query = (q||'').toLowerCase();
  renderInvCogCards(tabKey);
}

function toggleInvCogHidden(itemId, tabKey) {
  const state = _invCogState[tabKey];
  const cfg   = INV_COG_CFG[tabKey];
  if (state.hiddenIds.has(itemId)) state.hiddenIds.delete(itemId);
  else state.hiddenIds.add(itemId);
  const json = JSON.stringify([...state.hiddenIds]);
  localStorage.setItem(cfg.hiddenKey, json);
  saveSetting(cfg.hiddenKey, json).catch(() => {});
  renderInvCogCards(tabKey);
  renderCogsOverview();
}

async function updateInvCogField(id, field, rawValue, tabKey) {
  const val = rawValue === '' ? null : parseFloat(rawValue);
  const cfg = INV_COG_CFG[tabKey];
  try {
    await updateListItem(LISTS[cfg.listKey], id, { [field]: isNaN(val) ? null : val });
    const item = cache[cfg.cacheKey].find(i => i.id === id);
    if (item) item[field] = isNaN(val) ? null : val;
    renderInvCogCards(tabKey);
    renderCogsOverview(); // chart reads live CostPerUnit/SellingPrice for inv types
  } catch(e) { toast('err', 'Save failed: ' + e.message); }
}

function renderInvCogCards(tabKey) {
  const cfg       = INV_COG_CFG[tabKey];
  const state     = _invCogState[tabKey];
  const container = document.getElementById(`${tabKey}-cogs-cards`);
  const empty     = document.getElementById(`${tabKey}-cogs-empty`);
  if (!container) return;

  const showHidden = document.getElementById(`${tabKey}-cogs-show-hidden`)?.checked;

  let items = cache[cfg.cacheKey] || [];
  if (!showHidden) items = items.filter(i => !state.hiddenIds.has(i.id));
  if (state.query) items = items.filter(i =>
    (i.ItemName||i.Title||'').toLowerCase().includes(state.query) ||
    (i.ItemNo||'').toLowerCase().includes(state.query));
  items = [...items].sort((a,b) => (a.ItemName||a.Title||'').localeCompare(b.ItemName||b.Title||''));

  if (!items.length) {
    container.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  container.innerHTML = items.map(item => renderInvCogCard(item, tabKey)).join('');
}

function renderInvCogCard(item, tabKey) {
  const state      = _invCogState[tabKey];
  const isHidden   = state.hiddenIds.has(item.id);
  const cost       = parseFloat(item.CostPerUnit) || null;
  const price      = parseFloat(item.SellingPrice) || null;
  const margin     = (cost != null && price != null && price > 0) ? ((price - cost) / price * 100) : null;
  const marginColor = margin == null ? '#999' : margin >= 65 ? '#16a34a' : margin >= 50 ? '#d97706' : '#dc2626';
  const marginLabel = margin != null ? margin.toFixed(1) + '% margin'
    : cost == null && price == null ? 'Enter cost & price'
    : cost == null ? 'Enter cost per unit' : 'Enter selling price';

  return `
    <div class="card" id="cogs-item-card-${escHtml(tabKey)}-${escHtml(item.id)}" data-cog-item-id="${escHtml(item.id)}" style="padding:0;overflow:hidden;transition:box-shadow .3s, transform .3s;${isHidden?'opacity:0.5;':''}">
      <div style="padding:14px 16px 10px;border-bottom:1.5px solid var(--border);">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(item.ItemName||item.Title||'Untitled')}</div>
            <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">
              ${item.Category?`<span class="text-hint">${escHtml(item.Category)}</span>`:''}
              ${item.ItemNo?`<span style="font-size:11px;color:var(--muted);">· ${escHtml(item.ItemNo)}</span>`:''}
            </div>
          </div>
          <button data-id="${escHtml(item.id)}" data-tab="${escHtml(tabKey)}"
            onclick="toggleInvCogHidden(this.dataset.id,this.dataset.tab)"
            title="${isHidden?'Show':'Hide'}"
            style="background:none;border:none;cursor:pointer;font-size:16px;padding:2px 4px;color:var(--muted);flex-shrink:0;">
            ${isHidden?'👁️':'🙈'}
          </button>
        </div>
      </div>
      <div style="padding:14px 16px;">
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span style="font-size:13px;color:var(--muted);white-space:nowrap;">Cost per unit</span>
            <div style="display:flex;align-items:center;gap:4px;">
              <span style="color:var(--muted);font-size:13px;">$</span>
              <input type="number" step="0.01" min="0" placeholder="0.00"
                value="${cost != null ? cost.toFixed(2) : ''}"
                data-id="${escHtml(item.id)}" data-tab="${escHtml(tabKey)}"
                onchange="updateInvCogField(this.dataset.id,'CostPerUnit',this.value,this.dataset.tab)"
                style="width:80px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;text-align:right;color:#1a1a1a;background:#fff;">
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span style="font-size:13px;color:var(--muted);white-space:nowrap;">Selling price
              ${item.SquareCatalogItemId?'<span style="font-size:10px;background:#1a1a1a;color:#fff;padding:1px 5px;border-radius:8px;vertical-align:middle;margin-left:4px;">◼ Square</span>':''}
            </span>
            <div style="display:flex;align-items:center;gap:4px;">
              <span style="color:var(--muted);font-size:13px;">$</span>
              <input type="number" step="0.01" min="0" placeholder="0.00"
                value="${price != null ? price.toFixed(2) : ''}"
                data-id="${escHtml(item.id)}" data-tab="${escHtml(tabKey)}"
                onchange="updateInvCogField(this.dataset.id,'SellingPrice',this.value,this.dataset.tab)"
                style="width:80px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;text-align:right;color:#1a1a1a;background:#fff;">
            </div>
          </div>
          <div style="border-top:1.5px solid var(--border);padding-top:10px;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:12px;color:var(--muted);">Gross margin</span>
            <span style="font-size:16px;font-weight:700;color:${marginColor};">${escHtml(marginLabel)}</span>
          </div>
          ${cost != null && price != null ? `
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);">
            <span>Profit per unit</span>
            <span style="font-weight:600;color:var(--text);">$${(price-cost).toFixed(2)}</span>
          </div>` : ''}
        </div>
      </div>
    </div>`;
}

function renderCogCards() {
  const container = document.getElementById('cogs-cards');
  const empty     = document.getElementById('cogs-empty');
  if (!container) return;

  const showHidden    = document.getElementById('cogs-show-hidden')?.checked;
  const groupByCat    = document.getElementById('cogs-group-by-cat')?.checked;

  const cogMap  = buildCogMap();
  const invMap  = buildInvMap();
  const invIdMap = buildInvIdMap();
  const prepMap = buildPrepItemMap();

  let items = cache.menu.filter(i => (i.Category||'').toLowerCase() === 'coffee bar');
  if (!showHidden) items = items.filter(i => !_cogsHiddenIds.has(i.id));
  if (_cogsQuery)  items = items.filter(i => (i.ItemName||i.Title||'').toLowerCase().includes(_cogsQuery));
  if (_cogsMissingOnly) items = items.filter(i => {
    const itemId = i.SquareId || i.id;
    const variations = getVariationNames(i);
    // Item is "missing info" if any variation has no ingredients or has missing costs
    return variations.some(v => {
      const { lines, hasMissingCost } = calcCog(itemId, v.name, cogMap, invMap, prepMap, invIdMap);
      return lines.length === 0 || hasMissingCost;
    });
  });
  items = [...items].sort((a,b) => (a.ItemName||a.Title||'').localeCompare(b.ItemName||b.Title||''));

  if (!items.length) {
    container.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  if (groupByCat) {
    const byCategory = {};
    for (const item of items) {
      const cat = item.Category || 'Uncategorized';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(item);
    }
    container.innerHTML = Object.entries(byCategory)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([cat, catItems]) => `
        <div style="grid-column:1/-1;">
          <div style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.08em;
            color:var(--muted);padding:6px 0 10px;border-bottom:1.5px solid var(--border);margin-bottom:4px;">
            ${escHtml(cat)} <span style="font-weight:400;">(${catItems.length})</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,380px),1fr));gap:20px;margin-top:12px;">
            ${catItems.map(item => renderCogCard(item, cogMap, invMap, prepMap, invIdMap)).join('')}
          </div>
        </div>`).join('');
  } else {
    container.innerHTML = items.map(item => renderCogCard(item, cogMap, invMap, prepMap, invIdMap)).join('');
  }
}

function renderCogCard(item, cogMap, invMap, prepMap, invIdMap) {
  const itemId   = item.SquareId || item.id;
  const itemName = item.ItemName || item.Title || '';
  const category = item.Category || 'Uncategorized';
  const variations = getVariationNames(item);
  // Restore whichever variation was active; clamp in case variations count changed
  const activeVi = Math.min(_cogsActiveVar[itemId] ?? 0, Math.max(0, variations.length - 1));

  const varTabs = variations.map((v, vi) =>
    `<button class="cog-var-tab" id="cog-tab-${itemId}-${vi}"
      onclick="cogVarTab('${itemId}',${vi},${variations.length})"
      style="padding:5px 12px;font-size:12px;font-weight:600;border:1.5px solid var(--border);
        border-radius:20px;cursor:pointer;background:${vi===activeVi?'var(--gold)':'transparent'};
        color:${vi===activeVi?'#fff':'var(--muted)'};transition:all .15s;white-space:nowrap;">
      ${escHtml(v.name)}
    </button>`
  ).join('');

  const varPanels = variations.map((v, vi) => {
    const { cog, lines, hasMissingCost } = calcCog(itemId, v.name, cogMap, invMap, prepMap, invIdMap);
    const price  = v.price;
    const margin = (price && !hasMissingCost) ? ((price - cog) / price * 100) : null;
    const marginColor = margin == null ? '#999' : margin >= 65 ? '#16a34a' : margin >= 50 ? '#d97706' : '#dc2626';

    const ingRows = lines.map(ing => `
      <tr>
        <td style="padding:6px 8px;font-size:12px;">${invItemLink(ing.IngredientName||'', ing.isPrepItem?' <span style="font-size:10px;color:var(--teal);background:rgba(0,128,128,.1);padding:1px 5px;border-radius:8px;vertical-align:middle;">prep</span>':'')}</td>
        <td style="padding:6px 8px;font-size:12px;">
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:5px;">
            <input type="number" step="1" min="0" value="${ing.Quantity||''}"
              style="width:60px;padding:3px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;text-align:right;flex-shrink:0;"
              onchange="updateCogIngredient(${ing.id},'Quantity',this.value)">
            <span style="font-size:11px;color:var(--muted);width:44px;text-align:left;">${escHtml(ing.servingUnit||'')}</span>
          </div>
        </td>
        <td style="padding:6px 8px;font-size:12px;text-align:right;color:var(--muted);">
          ${ing.costPerServing != null ? '$'+ing.costPerServing.toFixed(3) : '<span style="color:#f59e0b" title="Add Cost Per Serving in Inventory">—</span>'}
        </td>
        <td style="padding:6px 8px;font-size:12px;text-align:right;font-weight:600;">
          ${ing.lineCost != null ? '$'+ing.lineCost.toFixed(3) : '—'}
        </td>
        <td style="padding:6px 8px;text-align:center;">
          <button onclick="deleteCogIngredient(${ing.id},'${escHtml(itemId)}','${escHtml(v.name)}')"
            style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:15px;line-height:1;padding:2px 4px;" title="Remove">×</button>
        </td>
      </tr>`).join('');

    const addRow = `
      <tr id="cog-add-row-${itemId}-${vi}">
        <td colspan="5" style="padding:6px 8px;">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <div style="position:relative;flex:1;min-width:130px;">
              <input type="text" placeholder="Ingredient name…" id="cog-new-ing-${itemId}-${vi}"
                autocomplete="off"
                style="width:100%;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;color:#1a1a1a;background:#fff;box-sizing:border-box;"
                oninput="showCogIngDrop('${escHtml(itemId)}',${vi},this.value)"
                onkeydown="cogIngDropKey(event,'${escHtml(itemId)}',${vi})"
                onblur="setTimeout(()=>hideCogIngDrop('${escHtml(itemId)}',${vi}),180)">
              <input type="hidden" id="cog-new-ing-id-${itemId}-${vi}">
              <div id="cog-ing-drop-${itemId}-${vi}" style="display:none;position:fixed;background:var(--dark-blue);border-radius:8px;box-shadow:0 6px 20px rgba(2,61,74,.25);z-index:400;max-height:180px;overflow-y:auto;font-size:12px;"></div>
            </div>
            <input type="number" step="1" min="0" placeholder="Qty" id="cog-new-qty-${itemId}-${vi}"
              style="width:60px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;">
            <button onclick="addCogIngredient('${escHtml(itemId)}','${escHtml(itemName)}','${escHtml(v.name)}',${vi})"
              style="padding:4px 10px;background:var(--gold);color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap;">+ Add</button>
          </div>
        </td>
      </tr>`;

    const summaryRow = `
      <tr style="border-top:2px solid var(--border);">
        <td colspan="3" style="padding:8px;font-size:12px;font-weight:700;color:var(--muted);">TOTALS</td>
        <td style="padding:8px;font-size:13px;font-weight:700;text-align:right;">${!hasMissingCost ? '$'+cog.toFixed(2) : '—'}</td>
        <td></td>
      </tr>
      <tr>
        <td colspan="2" style="padding:6px 8px;font-size:12px;color:var(--muted);">
          Selling Price${price ? ': $'+price.toFixed(2) : ': unknown'}
        </td>
        <td colspan="2" style="padding:6px 8px;text-align:right;">
          ${margin != null
            ? `<span style="font-size:14px;font-weight:700;color:${marginColor};">${margin.toFixed(1)}% margin</span>`
            : `<span style="font-size:12px;color:var(--muted);">${hasMissingCost?'Add serving costs to inventory':!price?'Add price in Square':''}</span>`}
        </td>
        <td></td>
      </tr>`;

    return `
      <div id="cog-panel-${itemId}-${vi}" style="display:${vi===activeVi?'block':'none'}">
        ${hasMissingCost ? `<div style="font-size:11px;color:#f59e0b;padding:4px 0 6px;"><span>⚠️ Some ingredients missing Cost Per Serving</span></div>` : ''}
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;min-width:320px;">
          <thead>
            <tr style="border-bottom:1.5px solid var(--border);">
              <th style="padding:5px 8px;font-size:11px;text-align:left;color:var(--muted);">INGREDIENT</th>
              <th style="padding:5px 8px;font-size:11px;text-align:right;color:var(--muted);white-space:nowrap;padding-right:10px;width:60px;">QTY</th>
              <th style="padding:5px 8px;font-size:11px;text-align:right;color:var(--muted);white-space:nowrap;">$/UNIT</th>
              <th style="padding:5px 8px;font-size:11px;text-align:right;color:var(--muted);white-space:nowrap;">COST</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${ingRows}
            ${addRow}
            ${summaryRow}
          </tbody>
        </table>
        </div>
      </div>`;
  }).join('');

  const isHidden = _cogsHiddenIds.has(item.id);
  return `
    <div class="card" id="cogs-item-card-coffee-bar-${escHtml(itemId)}" data-cog-item-id="${escHtml(itemId)}" data-gs-id="${escHtml(item.id)}" style="padding:0;overflow:hidden;transition:box-shadow .3s, transform .3s;${isHidden?'opacity:0.5;':''}">
      <div style="padding:14px 16px 10px;border-bottom:1.5px solid var(--border);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <div>
            <div style="font-weight:700;font-size:14px;">${escHtml(itemName)}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">${escHtml(category)}</div>
          </div>
          <button data-id="${escHtml(item.id)}" onclick="toggleCogHidden(this.dataset.id)"
            title="${isHidden?'Show this item':'Hide this item'}"
            style="background:none;border:none;cursor:pointer;font-size:16px;padding:2px 4px;color:var(--muted);flex-shrink:0;">
            ${isHidden?'👁️':'🙈'}
          </button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
          ${varTabs}
        </div>
      </div>
      <div style="padding:12px 16px 14px;">
        ${varPanels}
      </div>
    </div>`;
}

function cogVarTab(itemId, activeIdx, total) {
  _cogsActiveVar[itemId] = activeIdx; // remember so re-renders restore this tab
  for (let i = 0; i < total; i++) {
    const tab   = document.getElementById(`cog-tab-${itemId}-${i}`);
    const panel = document.getElementById(`cog-panel-${itemId}-${i}`);
    if (!tab || !panel) continue;
    const isActive = i === activeIdx;
    panel.style.display = isActive ? 'block' : 'none';
    tab.style.background = isActive ? 'var(--gold)' : 'transparent';
    tab.style.color = isActive ? '#fff' : 'var(--muted)';
    tab.style.borderColor = isActive ? 'var(--gold)' : 'var(--border)';
  }
}

async function addCogIngredient(menuItemId, menuItemName, variationName, varIdx) {
  const ingEl  = document.getElementById(`cog-new-ing-${menuItemId}-${varIdx}`);
  const qtyEl  = document.getElementById(`cog-new-qty-${menuItemId}-${varIdx}`);
  const ingIdEl = document.getElementById(`cog-new-ing-id-${menuItemId}-${varIdx}`);
  const ingName = (ingEl?.value || '').trim();
  const ingId   = (ingIdEl?.value || '').trim();
  const qty     = parseFloat(qtyEl?.value) || 0;
  if (!ingName) { toast('warn', 'Enter an ingredient name'); return; }
  try {
    const fields = {
      Title:          menuItemName + ' — ' + variationName + ' — ' + ingName,
      MenuItemId:     menuItemId,
      MenuItemName:   menuItemName,
      VariationName:  variationName,
      IngredientName: ingName,
      IngredientId:   ingId || null,
      Quantity:       qty || null
    };
    const saved = await addListItem(LISTS.cogs, fields);
    cache.cogsRecipes.push(saved);
    if (ingEl) ingEl.value = '';
    if (ingIdEl) ingIdEl.value = '';
    if (qtyEl) qtyEl.value = '';
    renderCogCards();
    renderCogsOverview();
  } catch(e) {
    toast('err', 'Failed to add ingredient: ' + e.message);
  }
}

async function updateCogIngredient(rowId, field, value) {
  try {
    const fields = {};
    fields[field] = field === 'Quantity' ? (parseFloat(value)||null) : value;
    await updateListItem(LISTS.cogs, rowId, fields);
    const rec = cache.cogsRecipes.find(r => r.id == rowId);
    if (rec) rec[field] = fields[field];
    // Refresh just the summary portion — re-render cards to update totals
    renderCogCards();
    renderCogsOverview();
  } catch(e) {
    toast('err', 'Failed to update: ' + e.message);
  }
}

async function deleteCogIngredient(rowId, menuItemId, variationName) {
  try {
    const siteId = await getSiteId();
    await graph('DELETE', `/sites/${siteId}/lists/${LISTS.cogs}/items/${rowId}`);
    cache.cogsRecipes = cache.cogsRecipes.filter(r => r.id != rowId);
    renderCogCards();
    renderCogsOverview();
  } catch(e) {
    toast('err', 'Failed to delete ingredient: ' + e.message);
  }
}

// -- History -----------------------------------------------------------------

// ── COG ingredient autocomplete ───────────────────────────────────────────
function _cogIngOptions() {
  // Returns [{id, name}] — inventory items carry their SharePoint ID; prep items have no ID
  const opts = [];
  cache.inventory.forEach(i => { if (i.ItemName && !i.Archived) opts.push({ id: String(i.id), name: i.ItemName }); });
  (cache.prepItems||[]).forEach(p => { if (p.Title) opts.push({ id: '', name: p.Title }); });
  return opts.sort((a, b) => a.name.localeCompare(b.name));
}

function showCogIngDrop(itemId, vi, q) {
  // Clear the stored ingredient ID whenever the user types manually
  const idInput = document.getElementById(`cog-new-ing-id-${itemId}-${vi}`);
  if (idInput) idInput.value = '';

  const drop = document.getElementById(`cog-ing-drop-${itemId}-${vi}`);
  if (!drop) return;
  const query = (q||'').toLowerCase().trim();
  const opts = _cogIngOptions().filter(o => !query || o.name.toLowerCase().includes(query)).slice(0, 20);
  if (!opts.length) { drop.style.display = 'none'; return; }
  drop.innerHTML = opts.map(o => `
    <div data-val="${escHtml(o.name)}" data-id="${escHtml(o.id)}" data-item="${escHtml(itemId)}" data-vi="${vi}"
      style="padding:7px 12px;cursor:pointer;color:#fff;border-bottom:1px solid rgba(255,255,255,.08);"
      onmousedown="pickCogIngDrop(this.dataset.item,this.dataset.vi,this.dataset.val,this.dataset.id)"
      onmouseover="this.style.background='rgba(255,255,255,.12)'"
      onmouseout="this.style.background=''">
      ${escHtml(o.name)}
    </div>`).join('');
  // Position fixed relative to input
  const inp = document.getElementById(`cog-new-ing-${itemId}-${vi}`);
  if (inp) {
    const r = inp.getBoundingClientRect();
    drop.style.top   = (r.bottom + 2) + 'px';
    drop.style.left  = r.left + 'px';
    drop.style.width = r.width + 'px';
  }
  drop.style.display = '';
}

function hideCogIngDrop(itemId, vi) {
  const drop = document.getElementById(`cog-ing-drop-${itemId}-${vi}`);
  if (drop) drop.style.display = 'none';
}

function pickCogIngDrop(itemId, vi, val, id) {
  const inp = document.getElementById(`cog-new-ing-${itemId}-${vi}`);
  if (inp) inp.value = val;
  const idInput = document.getElementById(`cog-new-ing-id-${itemId}-${vi}`);
  if (idInput) idInput.value = id || '';
  hideCogIngDrop(itemId, vi);
}

function cogIngDropKey(e, itemId, vi) {
  const drop = document.getElementById(`cog-ing-drop-${itemId}-${vi}`);
  if (!drop || drop.style.display === 'none') return;
  const items = drop.querySelectorAll('[data-val]');
  const active = drop.querySelector('.cog-ing-active');
  let idx = active ? [...items].indexOf(active) : -1;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (active) active.classList.remove('cog-ing-active'), active.style.background = '';
    idx = Math.min(idx+1, items.length-1);
    items[idx].classList.add('cog-ing-active'); items[idx].style.background = 'rgba(255,255,255,.18)';
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (active) active.classList.remove('cog-ing-active'), active.style.background = '';
    idx = Math.max(idx-1, 0);
    items[idx].classList.add('cog-ing-active'); items[idx].style.background = 'rgba(255,255,255,.18)';
  } else if (e.key === 'Enter' && active) {
    e.preventDefault();
    pickCogIngDrop(itemId, vi, active.dataset.val, active.dataset.id);
  } else if (e.key === 'Escape') {
    hideCogIngDrop(itemId, vi);
  }
}

// Chart state — persists across renders so toggles & last-hovered work
let _cogChartHiddenTypes = new Set();
let _cogChartData        = [];   // last drawn points (for tooltip / click)
let _cogChartTarget      = 65;
// When true, the Selling Price axis uses log10 scaling — separates a crowd of
// $3–$8 coffee-bar drinks that get jammed into the left edge under linear
// scaling when a $250 merch item stretches the axis ceiling. Persisted in
// localStorage so the user's preference survives reloads.
let _cogChartLogScale    = (() => { try { return localStorage.getItem('bsc_cog_chart_log') === '1'; } catch { return false; } })();

function toggleCogChartLogScale() {
  _cogChartLogScale = !_cogChartLogScale;
  try { localStorage.setItem('bsc_cog_chart_log', _cogChartLogScale ? '1' : '0'); } catch {}
  renderCogsOverview();
}

// Marker config per inventory type. symbol is drawn as SVG path; color is the
// outer stroke/ring so a dot's fill still encodes margin vs. target.
const COG_TYPE_MARKERS = {
  'coffee-bar': { label: 'Coffee Bar', ring: '#c8a951', shape: 'circle' },
  'merch':      { label: 'Merch',     ring: '#7dd3fc', shape: 'triangle' },
  'food':       { label: 'Food',      ring: '#f472b6', shape: 'square' },
  'grocery':    { label: 'Grocery',   ring: '#a78bfa', shape: 'diamond' }
};

// Build an SVG marker path for a given shape + radius, centred at (cx, cy).
function cogMarkerPath(shape, cx, cy, r) {
  if (shape === 'triangle') {
    const h = r * 1.25;
    return `M ${cx} ${cy-h} L ${cx+h} ${cy+h*0.8} L ${cx-h} ${cy+h*0.8} Z`;
  }
  if (shape === 'square') {
    const s = r * 1.05;
    return `M ${cx-s} ${cy-s} L ${cx+s} ${cy-s} L ${cx+s} ${cy+s} L ${cx-s} ${cy+s} Z`;
  }
  if (shape === 'diamond') {
    const d = r * 1.25;
    return `M ${cx} ${cy-d} L ${cx+d} ${cy} L ${cx} ${cy+d} L ${cx-d} ${cy} Z`;
  }
  // circle fallback rendered via <circle>; shouldn't hit this path
  return '';
}

// Click handler for chart dots — drill down into item context.
//   coffee-bar → history modal (existing)
//   inventory  → jump to that COG tab
// Called from svg onclick via data-idx attribute.
function handleCogChartClick(idx) {
  const pt = _cogChartData[idx];
  if (!pt) return;
  // Route dot click → switch to the item's tab, then scroll to and flash-
  // highlight its card. Users previously had no way to "see the item" from a
  // dot: coffee-bar dots jumped straight to the history modal and inv-type
  // dots only opened the tab, leaving the user to hunt for the item.
  if (typeof cogTab === 'function') cogTab(pt.type);
  // Hide the tooltip so it doesn't linger as we re-render
  const tip = document.getElementById('cog-chart-tip');
  if (tip) tip.style.display = 'none';
  // Let the tab's panel finish painting before we locate the card.
  setTimeout(() => {
    const cardId = `cogs-item-card-${pt.type}-${pt.cardId}`;
    const card = document.getElementById(cardId);
    if (!card) return;
    card.scrollIntoView({ behavior:'smooth', block:'center' });
    // Flash highlight — gold ring pulses then fades.
    card.style.boxShadow = '0 0 0 3px var(--gold), var(--shadow)';
    card.style.transform = 'scale(1.01)';
    setTimeout(() => {
      card.style.boxShadow = '';
      card.style.transform = '';
    }, 1800);
  }, 60);
}

// Toggle a type's visibility from the legend chip.
function toggleCogChartType(type) {
  if (_cogChartHiddenTypes.has(type)) _cogChartHiddenTypes.delete(type);
  else _cogChartHiddenTypes.add(type);
  renderCogsOverview();
}

// Hover handlers — swap marker styles and position the floating tooltip.
function handleCogDotEnter(evt, idx) {
  const pt = _cogChartData[idx];
  if (!pt) return;
  const tip = document.getElementById('cog-chart-tip');
  const host = document.getElementById('cogs-overview-chart');
  if (!tip || !host) return;
  const mColor = pt.margin >= _cogChartTarget ? '#16a34a'
               : pt.margin >= _cogChartTarget * 0.8 ? '#d97706' : '#dc2626';
  const typeLbl = COG_TYPE_MARKERS[pt.type]?.label || pt.typeLabel || '';
  tip.innerHTML = `
    <div style="font-size:12px;font-weight:700;color:#fff;margin-bottom:2px;">${escHtml(pt.name)}${pt.variation ? ` <span style="font-weight:400;color:rgba(255,255,255,.7);">· ${escHtml(pt.variation)}</span>` : ''}</div>
    <div style="font-size:10px;color:rgba(255,255,255,.55);margin-bottom:6px;letter-spacing:.3px;text-transform:uppercase;">${escHtml(typeLbl)}${pt.category && pt.category !== typeLbl ? ' · '+escHtml(pt.category) : ''}</div>
    <div style="display:flex;gap:10px;align-items:baseline;margin-bottom:4px;">
      <div style="font-size:20px;font-weight:800;color:${mColor};line-height:1;">${pt.margin.toFixed(1)}%</div>
      <div style="font-size:10px;color:rgba(255,255,255,.5);">margin</div>
    </div>
    <div style="display:flex;gap:12px;font-size:11px;color:rgba(255,255,255,.75);">
      <span>Price <strong style="color:#fff;">$${pt.price.toFixed(2)}</strong></span>
      <span>Cost <strong style="color:#fff;">$${pt.cog.toFixed(3)}</strong></span>
    </div>
    <div style="font-size:10px;color:var(--gold);margin-top:6px;font-weight:600;">Click dot to open item →</div>
  `;
  const rect = host.getBoundingClientRect();
  const mx = evt.clientX - rect.left;
  const my = evt.clientY - rect.top;
  tip.style.display = 'block';
  // Clamp so tooltip stays inside host — measure after making it visible
  const tipW = tip.offsetWidth || 220;
  const tipH = tip.offsetHeight || 100;
  const left = Math.max(4, Math.min(rect.width - tipW - 4, mx + 14));
  const top  = Math.max(4, Math.min(rect.height - tipH - 4, my + 14));
  tip.style.left = left + 'px';
  tip.style.top  = top + 'px';
  // Highlight the hovered marker
  const g = document.getElementById('cog-dot-' + idx);
  if (g) g.setAttribute('data-hover', '1');
}
function handleCogDotMove(evt) {
  const tip = document.getElementById('cog-chart-tip');
  const host = document.getElementById('cogs-overview-chart');
  if (!tip || tip.style.display === 'none' || !host) return;
  const rect = host.getBoundingClientRect();
  const mx = evt.clientX - rect.left;
  const my = evt.clientY - rect.top;
  const tipW = tip.offsetWidth || 220;
  const tipH = tip.offsetHeight || 100;
  tip.style.left = Math.max(4, Math.min(rect.width - tipW - 4, mx + 14)) + 'px';
  tip.style.top  = Math.max(4, Math.min(rect.height - tipH - 4, my + 14)) + 'px';
}
function handleCogDotLeave(idx) {
  const tip = document.getElementById('cog-chart-tip');
  if (tip) tip.style.display = 'none';
  const g = document.getElementById('cog-dot-' + idx);
  if (g) g.removeAttribute('data-hover');
}

function renderCogsOverviewChart(items, target) {
  const el = document.getElementById('cogs-overview-chart');
  if (!el) return;

  _cogChartTarget = target;

  // Apply legend toggles
  const visibleItems = items.filter(i => !_cogChartHiddenTypes.has(i.type));
  _cogChartData = visibleItems;

  // Tooltip container — created once, reused. Light theme: dark-blue card on cream UI.
  let tip = document.getElementById('cog-chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'cog-chart-tip';
    tip.style.cssText = 'position:absolute;display:none;pointer-events:none;background:#023d4a;color:#fff;border:1px solid #b78b40;border-radius:10px;padding:10px 12px;min-width:180px;max-width:260px;box-shadow:0 8px 24px rgba(2,61,74,.25);z-index:30;';
  }
  tip.style.display = 'none'; // reset on re-render so stale tooltip doesn't linger

  if (!items.length) {
    el.innerHTML = `<div class="card" style="padding:32px 16px;text-align:center;color:var(--muted);font-size:13px;">No priced items yet — snapshot a Coffee Bar recipe or set Cost/Price on merch/food/grocery items.</div>`;
    return;
  }

  // Responsive SVG — fills container width, stays 300px tall visually.
  const VB_W = 680, VB_H = 320;
  // Right pad widened to fit the secondary $-profit axis ticks/label.
  const PAD_L = 52, PAD_R = 60, PAD_T = 20, PAD_B = 50;
  const plotW = VB_W - PAD_L - PAD_R;
  const plotH = VB_H - PAD_T - PAD_B;

  const maxPrice = Math.max(...visibleItems.map(i => i.price), 1);
  const minPricePos = Math.max(0.5, Math.min(...visibleItems.map(i => i.price).filter(p => p > 0).concat([maxPrice])));
  const xCeil = Math.max(5, Math.ceil(maxPrice * 1.12 / 5) * 5); // nearest $5

  // X scale — linear by default, log10 when _cogChartLogScale is on. Log mode
  // spreads out the dense $3–$8 cluster that dominates when a $200 merch item
  // stretches the linear ceiling. Min is floored at $0.50 so log(price) stays
  // finite even for unpriced items.
  const useLog = !!_cogChartLogScale;
  const LOG_FLOOR = 0.5;
  const logMin = Math.log10(Math.max(LOG_FLOOR, Math.min(LOG_FLOOR, minPricePos / 1.4)));
  const logMax = Math.log10(Math.max(LOG_FLOOR * 2, maxPrice * 1.15));
  const logRange = Math.max(logMax - logMin, 0.3);
  const xScale = useLog
    ? p => PAD_L + ((Math.log10(Math.max(LOG_FLOOR, p)) - logMin) / logRange) * plotW
    : p => PAD_L + (p / xCeil) * plotW;
  const yScale = m => PAD_T + plotH - (Math.min(100, Math.max(0, m)) / 100) * plotH;
  const dotColor = (m) => m >= target ? '#16a34a' : m >= target * 0.8 ? '#d97706' : '#dc2626';

  const svg = [];

  // Target band — subtle green wash above target line
  const tyTop = yScale(100);
  const tyTar = yScale(target);
  svg.push(`<rect x="${PAD_L}" y="${tyTop}" width="${plotW}" height="${tyTar - tyTop}" fill="#16a34a" opacity=".07"/>`);
  // Danger band — below 80% of target
  const dangerY = yScale(target * 0.8);
  svg.push(`<rect x="${PAD_L}" y="${dangerY}" width="${plotW}" height="${PAD_T + plotH - dangerY}" fill="#dc2626" opacity=".07"/>`);

  // Theme palette — light cream UI, dark teal text. Hardcoded so SVG fills work.
  const TEXT_DARK = '#023d4a';
  const TEXT_MUTED = '#4d8a98';
  const GRID_LINE = 'rgba(2,61,74,.10)';
  const AXIS_LINE = 'rgba(2,61,74,.30)';
  const TARGET_COL = '#b78b40';   // brand gold
  const AVG_COL    = '#0e7490';   // deep cyan — readable on cream

  // ── Right-side $-profit scale ─────────────────────────────────────
  // Independent secondary Y axis used by the horizontal "Avg profit"
  // line. We compute it once from the visible items (profit = price-cog),
  // then map gridline positions to round $ ticks on the right edge.
  const profitsArr = visibleItems.map(i => Math.max(0, (i.price||0) - (i.cog||0)));
  const avgProfit  = profitsArr.length ? profitsArr.reduce((s,p)=>s+p, 0) / profitsArr.length : 0;
  const maxProfit  = profitsArr.length ? Math.max(...profitsArr) : 0;
  // Round profit ceiling to a clean number so the right-axis ticks read
  // as $5/$10/$25 etc rather than weird fractions.
  const niceCeil = (v) => {
    if (v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n   = v / pow;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
  };
  const profitCeil = niceCeil(Math.max(maxProfit, avgProfit) * 1.1) || 1;
  const yScaleProfit = $ => PAD_T + plotH - (Math.max(0, $) / profitCeil) * plotH;
  const fmtProfit = (v) => v >= 1000 ? '$' + Math.round(v).toLocaleString()
                          : v >= 100  ? '$' + Math.round(v)
                          : v >= 10   ? '$' + v.toFixed(0)
                          :             '$' + v.toFixed(2).replace(/\.00$/,'');

  // Grid — Y (left = margin %, right = profit $; both share gridlines)
  [0, 25, 50, 75, 100].forEach(m => {
    const y = yScale(m);
    svg.push(`<line x1="${PAD_L}" y1="${y}" x2="${VB_W - PAD_R}" y2="${y}" stroke="${GRID_LINE}" stroke-width="1"/>`);
    svg.push(`<text x="${PAD_L - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="${TEXT_MUTED}">${m}%</text>`);
    // Right-edge $-profit tick label, aligned to the same gridline so the
    // user can read either scale at a glance.
    const dollarVal = (m / 100) * profitCeil;
    svg.push(`<text x="${VB_W - PAD_R + 8}" y="${y + 4}" text-anchor="start" font-size="10" fill="${AVG_COL}" opacity=".85">${fmtProfit(dollarVal)}</text>`);
  });

  // Format $ tick with thousands separator for big merch/equipment prices.
  const fmtTick = (p) => p >= 1000 ? '$' + p.toLocaleString() : '$' + p;

  // Grid — X (log or linear depending on toggle)
  if (useLog) {
    // Pick round decade + mid-decade ticks that fall inside the visible range.
    const candidates = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const lo = Math.pow(10, logMin) * 0.9;
    const hi = Math.pow(10, logMax) * 1.1;
    candidates.filter(v => v >= lo && v <= hi).forEach(p => {
      const x = xScale(p);
      svg.push(`<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${PAD_T + plotH}" stroke="${GRID_LINE}" stroke-width="1"/>`);
      svg.push(`<text x="${x}" y="${PAD_T + plotH + 16}" text-anchor="middle" font-size="10" fill="${TEXT_MUTED}">${fmtTick(p)}</text>`);
    });
  } else {
    const xStep = xCeil <= 10 ? 2 : xCeil <= 20 ? 5 : xCeil <= 50 ? 10 : xCeil <= 100 ? 20 : 25;
    for (let p = 0; p <= xCeil; p += xStep) {
      const x = xScale(p);
      svg.push(`<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${PAD_T + plotH}" stroke="${GRID_LINE}" stroke-width="1"/>`);
      svg.push(`<text x="${x}" y="${PAD_T + plotH + 16}" text-anchor="middle" font-size="10" fill="${TEXT_MUTED}">${fmtTick(p)}</text>`);
    }
  }

  // Axis borders
  svg.push(`<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + plotH}" stroke="${AXIS_LINE}" stroke-width="1"/>`);
  svg.push(`<line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${VB_W - PAD_R}" y2="${PAD_T + plotH}" stroke="${AXIS_LINE}" stroke-width="1"/>`);

  // Axis labels — dark teal, bold so they read clearly on cream
  svg.push(`<text x="${PAD_L + plotW / 2}" y="${VB_H - 6}" text-anchor="middle" font-size="12" font-weight="700" fill="${TEXT_DARK}" letter-spacing=".3">Selling Price ($)${useLog ? '  —  log scale' : ''}</text>`);
  svg.push(`<text transform="rotate(-90)" x="${-(PAD_T + plotH / 2)}" y="14" text-anchor="middle" font-size="12" font-weight="700" fill="${TEXT_DARK}" letter-spacing=".3">Gross Margin (%)</text>`);
  // Right-axis label — rotated 90° clockwise, sitting just outside the right edge
  svg.push(`<text transform="rotate(90)" x="${PAD_T + plotH / 2}" y="${-(VB_W - 14)}" text-anchor="middle" font-size="12" font-weight="700" fill="${AVG_COL}" letter-spacing=".3">Profit ($)</text>`);

  // Target line — horizontal, marks the target margin on the Y axis
  svg.push(`<line x1="${PAD_L}" y1="${tyTar}" x2="${VB_W - PAD_R}" y2="${tyTar}" stroke="${TARGET_COL}" stroke-width="1.6" stroke-dasharray="6,4" opacity=".95"/>`);
  svg.push(`<text x="${VB_W - PAD_R - 4}" y="${tyTar - 5}" text-anchor="end" font-size="10" fill="${TARGET_COL}" font-weight="700">Target ${target}%</text>`);

  // Average profit line — horizontal, plotted against the right-side $ axis
  // (independent of the left % scale). Shows the average gross-profit-per-unit
  // ($ price − $ cost) across all visible items so the user can read at a
  // glance "what does our typical item make us in dollars?"
  if (visibleItems.length && avgProfit > 0) {
    const ya = yScaleProfit(avgProfit);
    if (ya >= PAD_T && ya <= PAD_T + plotH) {
      svg.push(`<line x1="${PAD_L}" y1="${ya}" x2="${VB_W - PAD_R}" y2="${ya}" stroke="${AVG_COL}" stroke-width="1.6" stroke-dasharray="3,3" opacity=".95"/>`);
      const label = `Avg profit ${fmtProfit(avgProfit)}`;
      // Position the label just above the line, anchored to the left edge so
      // it sits inside the plot regardless of the line's height.
      svg.push(`<text x="${PAD_L + 6}" y="${ya - 5}" text-anchor="start" font-size="10" fill="${AVG_COL}" font-weight="700">${label}</text>`);
    }
  }

  // Collision-aware draw order — plot worst-first so at-target dots sit on top,
  // and tiny jitter (deterministic, based on name hash) separates exact overlaps.
  const hash = (s) => { let h=0; for (let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return h; };
  const sorted = [...visibleItems].sort((a, b) => a.margin - b.margin);
  sorted.forEach(item => {
    const origIdx = _cogChartData.indexOf(item);
    const j = hash((item.name||'')+'|'+(item.variation||''));
    const jx = ((j & 0xff) / 255 - 0.5) * 4;    // ±2 px
    const jy = (((j>>8) & 0xff) / 255 - 0.5) * 4;
    const cx = xScale(item.price) + jx;
    const cy = yScale(item.margin) + jy;
    const col = dotColor(item.margin);
    const marker = COG_TYPE_MARKERS[item.type] || COG_TYPE_MARKERS['coffee-bar'];
    const ringCol = marker.ring;
    const opa = item.isHidden ? '.25' : '.9';
    const r = 6;

    // Marker: circle uses <circle>, others use <path>
    let shapeEl;
    if (marker.shape === 'circle') {
      shapeEl = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${col}" stroke="${ringCol}" stroke-width="1.4"/>`;
    } else {
      shapeEl = `<path d="${cogMarkerPath(marker.shape, cx, cy, r)}" fill="${col}" stroke="${ringCol}" stroke-width="1.4" stroke-linejoin="round"/>`;
    }

    // Wrapper group handles hover/click & styling
    svg.push(`<g id="cog-dot-${origIdx}" class="cog-dot" data-idx="${origIdx}" style="cursor:pointer;opacity:${opa};transition:opacity .15s,transform .15s;transform-origin:${cx.toFixed(1)}px ${cy.toFixed(1)}px;" onclick="handleCogChartClick(${origIdx})" onmouseenter="handleCogDotEnter(event,${origIdx})" onmousemove="handleCogDotMove(event)" onmouseleave="handleCogDotLeave(${origIdx})">
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r+3}" fill="transparent"/>
      ${shapeEl}
    </g>`);
  });

  // Build clickable legend chips (type toggles + margin buckets info)
  const typeCounts = {};
  items.forEach(i => { typeCounts[i.type] = (typeCounts[i.type]||0) + 1; });
  const legendChips = Object.entries(COG_TYPE_MARKERS)
    .filter(([t]) => typeCounts[t])
    .map(([t, cfg]) => {
      const hidden = _cogChartHiddenTypes.has(t);
      const count = typeCounts[t] || 0;
      // Mini inline SVG preview (shape + ring) so legend matches the chart.
      const prev = cfg.shape === 'circle'
        ? `<circle cx="7" cy="7" r="4.5" fill="#888" stroke="${cfg.ring}" stroke-width="1.4"/>`
        : `<path d="${cogMarkerPath(cfg.shape, 7, 7, 4.5)}" fill="#888" stroke="${cfg.ring}" stroke-width="1.4" stroke-linejoin="round"/>`;
      return `<button type="button" onclick="toggleCogChartType('${t}')" title="${hidden?'Show':'Hide'} ${escHtml(cfg.label)}"
        style="display:inline-flex;align-items:center;gap:5px;background:${hidden?'transparent':'var(--milk)'};border:1px solid ${hidden?'var(--border)':cfg.ring};border-radius:14px;padding:4px 10px 4px 7px;font-size:11px;color:${hidden?'var(--muted)':'var(--text)'};cursor:pointer;line-height:1;font-weight:600;">
        <svg width="14" height="14" viewBox="0 0 14 14" style="flex-shrink:0;${hidden?'opacity:.4':''}">${prev}</svg>
        <span>${escHtml(cfg.label)}</span>
        <span style="color:var(--muted);font-variant-numeric:tabular-nums;font-weight:500;">${count}</span>
      </button>`;
    }).join('');

  const marginKey = `
    <div style="display:flex;gap:10px;align-items:center;font-size:11px;color:var(--text);flex-wrap:wrap;">
      <span style="color:var(--muted);font-weight:700;letter-spacing:.3px;text-transform:uppercase;font-size:10px;">Margin</span>
      <span style="display:inline-flex;align-items:center;gap:5px;" title="At or above target margin"><span style="width:10px;height:10px;border-radius:50%;background:#16a34a;border:1px solid rgba(0,0,0,.1);"></span>On target (≥${target}%)</span>
      <span style="display:inline-flex;align-items:center;gap:5px;" title="Below target but above 80% of target"><span style="width:10px;height:10px;border-radius:50%;background:#d97706;border:1px solid rgba(0,0,0,.1);"></span>Watch (${Math.round(target*0.8)}–${target-1}%)</span>
      <span style="display:inline-flex;align-items:center;gap:5px;" title="Below 80% of target"><span style="width:10px;height:10px;border-radius:50%;background:#dc2626;border:1px solid rgba(0,0,0,.1);"></span>Below (&lt;${Math.round(target*0.8)}%)</span>
    </div>`;

  const lineKey = `
    <div style="display:flex;gap:12px;align-items:center;font-size:11px;color:var(--text);flex-wrap:wrap;">
      <span style="color:var(--muted);font-weight:700;letter-spacing:.3px;text-transform:uppercase;font-size:10px;">Lines</span>
      <span style="display:inline-flex;align-items:center;gap:6px;" title="Horizontal line at your target margin %"><svg width="22" height="8" style="flex-shrink:0;"><line x1="0" y1="4" x2="22" y2="4" stroke="#b78b40" stroke-width="1.8" stroke-dasharray="5,3"/></svg>Target margin</span>
      <span style="display:inline-flex;align-items:center;gap:6px;" title="Average gross profit per item ($ price − $ cost). Read against the right-side dollar axis."><svg width="22" height="8" style="flex-shrink:0;"><line x1="0" y1="4" x2="22" y2="4" stroke="#0e7490" stroke-width="1.8" stroke-dasharray="3,3"/></svg>Avg profit ($)</span>
    </div>`;

  el.innerHTML = `
    <div class="card" style="padding:16px;position:relative;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--text);letter-spacing:.3px;">Margin vs. Selling Price</div>
          <div style="font-size:11px;color:var(--muted);margin-top:3px;">Each dot is a priced item. Click a dot to see details · click a type chip below to filter · ${useLog ? 'log' : 'linear'} scale on price.</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button type="button" onclick="toggleCogChartLogScale()" title="${useLog ? 'Switch back to linear price axis' : 'Switch to log scale — spreads out the $3–$8 cluster when a $200 item compresses the linear axis'}" style="display:inline-flex;align-items:center;gap:5px;background:${useLog?'var(--gold)':'var(--milk)'};border:1px solid ${useLog?'var(--gold)':'var(--border)'};border-radius:14px;padding:5px 14px;font-size:11px;color:${useLog?'#fff':'var(--text)'};cursor:pointer;line-height:1;font-weight:700;">${useLog ? '📐 Log scale' : '📏 Linear scale'}</button>
        </div>
      </div>
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:10px;padding:8px 12px;background:var(--milk);border:1px solid var(--border);border-radius:8px;">
        ${marginKey}
        <span style="width:1px;height:18px;background:var(--border);"></span>
        ${lineKey}
      </div>
      <div style="margin-bottom:8px;">
        <div style="font-size:10px;color:var(--muted);font-weight:700;letter-spacing:.4px;text-transform:uppercase;margin-bottom:5px;">Filter by type</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">${legendChips}</div>
      </div>
      <div style="position:relative;">
        <svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:auto;max-height:360px;font-family:inherit;">
          <style>.cog-dot:hover{opacity:1 !important;transform:scale(1.35);} .cog-dot[data-hover="1"]{opacity:1 !important;transform:scale(1.35);}</style>
          ${svg.join('\n')}
        </svg>
      </div>
    </div>`;

  // Attach tooltip inside the card so positioning is relative to it
  el.querySelector('.card')?.appendChild(tip);
}

function renderCogsOverview() {
  const statsEl = document.getElementById('cogs-overview-stats');
  const bodyEl  = document.getElementById('cogs-overview-body');
  if (!statsEl || !bodyEl) return;

  const target     = parseFloat(document.getElementById('cogs-target-margin')?.value) || 65;
  const sort       = document.getElementById('cogs-overview-sort')?.value || 'margin-asc';
  const typeFilter = document.getElementById('cogs-overview-type')?.value || '';

  // Build latest snapshot per coffee-bar item (MenuItemId:VariationName)
  const latestSnap = {};
  [...cache.cogSnapshots]
    .sort((a,b) => new Date(a.SnapshotDate) - new Date(b.SnapshotDate))
    .forEach(s => { latestSnap[`${s.MenuItemId}:${s.VariationName}`] = s; });

  const items = [];

  // Coffee Bar — from snapshots.
  // Display name prefers the LIVE BSC_Menu item (which syncSquareCatalog keeps
  // in lock-step with Square). The snapshot's MenuItemName is retained as
  // `itemName` because openCogHistoryModal filters history by that name —
  // changing it here would break the historical lookup for pre-rename rows.
  if (!typeFilter || typeFilter === 'coffee-bar') {
    Object.values(latestSnap).forEach(s => {
      const margin = parseFloat(s.GrossMargin);
      if (isNaN(margin)) return;
      const menuItem = cache.menu.find(m => (m.SquareId || m.id) === s.MenuItemId);
      // Drop stale snapshots: menu item was removed from Square/BSC_Menu, or is
      // no longer in the Coffee Bar category (e.g. reassigned), or explicitly
      // archived. Without this, the overview would keep showing ghost rows for
      // items that haven't been sellable in months.
      if (!menuItem) return;
      if ((menuItem.Category||'').toLowerCase() !== 'coffee bar') return;
      if (menuItem.Archived) return;
      const spId = menuItem.id || s.MenuItemId;
      const cardId = menuItem.SquareId || menuItem.id || s.MenuItemId;
      const isHidden = _cogsHiddenIds.has(spId) || _cogsHiddenIds.has(cardId);
      const liveName = menuItem.ItemName || menuItem.Title || s.MenuItemName;
      items.push({
        type: 'coffee-bar', typeLabel: 'Coffee Bar',
        name: liveName, variation: s.VariationName,
        category: menuItem.Category || 'Coffee Bar',
        margin, price: parseFloat(s.SellingPrice)||0, cog: parseFloat(s.COG)||0,
        snapshotDate: s.SnapshotDate,
        histKey: `${s.MenuItemId}:${s.VariationName}`,
        itemName: s.MenuItemName, varName: s.VariationName,
        spId, cardId, isHidden
      });
    });
  }

  // Inv types — from current items
  for (const [tabKey, cfg] of Object.entries(INV_COG_CFG)) {
    if (typeFilter && typeFilter !== tabKey) continue;
    const typeLabel = tabKey.charAt(0).toUpperCase() + tabKey.slice(1);
    const state = _invCogState[tabKey];
    (cache[cfg.cacheKey]||[]).forEach(i => {
      if (i.Archived) return;  // drop archived items from overview chart, stats, and list (truthy — matches 'yes', 'Yes', true, etc.)
      const cost  = parseFloat(i.CostPerUnit);
      const price = parseFloat(i.SellingPrice);
      if (!cost || !price) return;
      const margin = ((price - cost) / price) * 100;
      const isHidden = state?.hiddenIds?.has(i.id) || false;
      items.push({
        type: tabKey, typeLabel,
        name: i.ItemName, variation: '',
        category: i.Category || typeLabel,
        margin, price, cog: cost,
        snapshotDate: null, histKey: null,
        itemName: i.ItemName, varName: '',
        spId: i.id, cardId: i.id, isHidden
      });
    });
  }

  // Hidden items are fully excluded from the overview — stats, chart, and list.
  // Users unhide from each tab's COG view (Coffee Bar, Merch, Food, Grocery).
  const visibleItems = items.filter(i => !i.isHidden);

  const sortFn = sort === 'margin-asc' ? (a,b) => a.margin - b.margin
               : sort === 'margin-desc' ? (a,b) => b.margin - a.margin
               : (a,b) => a.name.localeCompare(b.name);
  visibleItems.sort(sortFn);
  const displayItems = visibleItems;

  // Stats — active items only
  const avg   = visibleItems.length ? visibleItems.reduce((s,i) => s+i.margin, 0) / visibleItems.length : 0;
  const below = visibleItems.filter(i => i.margin < target).length;
  const best  = visibleItems.reduce((b,i) => i.margin > (b?.margin??-Infinity) ? i : b, null);
  const worst = visibleItems.reduce((w,i) => i.margin < (w?.margin??Infinity)  ? i : w, null);

  statsEl.innerHTML = [
    ['Total Items', visibleItems.length],
    ['Avg Margin', avg.toFixed(1)+'%'],
    [`Below ${target}%`, `<span style="color:${below>0?'var(--red)':'var(--text)'}">${below}</span>`],
    ['Best', best ? `<span title="${escHtml(best.name)}" style="font-size:12px;color:#16a34a">${best.margin.toFixed(1)}%</span>` : '—'],
    ['Worst', worst ? `<span title="${escHtml(worst.name)}" style="font-size:12px;color:var(--red)">${worst.margin.toFixed(1)}%</span>` : '—']
  ].map(([label, val]) => `
    <div class="card" style="padding:12px 16px;">
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">${label}</div>
      <div style="font-size:20px;font-weight:700">${val}</div>
    </div>`).join('');

  // Chart — always based on visibleItems
  renderCogsOverviewChart(visibleItems, target);

  if (!displayItems.length) {
    bodyEl.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:32px 0">No active items with cost and price data. Snapshot Costs on the Coffee Bar tab, or set Cost/Price on Merch, Food, and Grocery items. Hidden items are excluded — unhide from the item\'s own tab to include it here.</div>';
    return;
  }

  bodyEl.innerHTML = displayItems.map(item => {
    const m = item.margin;
    const mColor = m >= target ? '#16a34a' : m >= target * 0.8 ? '#d97706' : '#dc2626';
    const barW   = Math.min(100, Math.max(0, m)).toFixed(1);
    const typePill = `<span style="font-size:10px;background:var(--opal);color:var(--dark-blue);padding:1px 6px;border-radius:8px;">${escHtml(item.typeLabel)}</span>`;
    const histBtn  = item.histKey
      ? `<button style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--gold);padding:0;" data-name="${escHtml(item.itemName)}" data-var="${escHtml(item.varName)}" onclick="openCogHistoryModal(this.dataset.name,this.dataset.var)">History →</button>`
      : '';
    const hideBtn = `<button style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--muted);padding:0;"
      data-id="${escHtml(item.spId)}" data-type="${escHtml(item.type)}"
      onclick="toggleOverviewCogHidden(this.dataset.type,this.dataset.id)"
      title="Hide from summary (unhide from the item's tab)">🙈 Hide</button>`;
    return `<div class="card" style="padding:14px 16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:6px;">
        <div>
          <div style="font-weight:600;font-size:13px;">${escHtml(item.name)}</div>
          ${item.variation ? `<div style="font-size:11px;color:var(--muted)">${escHtml(item.variation)}</div>` : ''}
        </div>
        <div style="font-size:18px;font-weight:700;color:${mColor};white-space:nowrap;">${m.toFixed(1)}%</div>
      </div>
      <div style="background:var(--border);border-radius:4px;height:5px;margin-bottom:10px;">
        <div style="background:${mColor};height:5px;border-radius:4px;width:${barW}%;transition:width .3s;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);">
        <span>Price: $${item.price.toFixed(2)}</span>
        <span>Cost: $${item.cog.toFixed(3)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
        <div style="display:flex;gap:8px;align-items:center;">${typePill}${histBtn}</div>
        ${hideBtn}
      </div>
    </div>`;
  }).join('');
}

function openCogHistoryModal(itemName, varName) {
  const snaps = [...cache.cogSnapshots]
    .filter(s => s.MenuItemName === itemName && s.VariationName === varName)
    .sort((a,b) => new Date(a.SnapshotDate) - new Date(b.SnapshotDate));

  document.getElementById('cog-hist-modal-title').textContent = itemName;
  document.getElementById('cog-hist-modal-sub').textContent   = varName;

  if (!snaps.length) {
    document.getElementById('cog-hist-modal-trend').innerHTML = '';
    document.getElementById('cog-hist-modal-table').innerHTML = '<div style="color:var(--muted);font-size:13px;">No snapshots yet.</div>';
    openModal('modal-cog-item-history');
    return;
  }

  // Mini trend bar chart
  const maxM = Math.max(...snaps.map(s => parseFloat(s.GrossMargin)||0), 100);
  const trendHTML = `
    <div style="display:flex;align-items:flex-end;gap:6px;height:60px;padding-bottom:4px;border-bottom:1px solid var(--border);">
      ${snaps.map(s => {
        const m = parseFloat(s.GrossMargin)||0;
        const h = Math.round((m / maxM) * 52);
        const col = m >= 65 ? '#16a34a' : m >= 50 ? '#d97706' : '#dc2626';
        const date = s.SnapshotDate ? new Date(s.SnapshotDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '';
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1;min-width:28px;" title="${date}: ${m.toFixed(1)}%">
          <div style="font-size:9px;color:var(--muted)">${m.toFixed(0)}%</div>
          <div style="background:${col};width:100%;height:${h}px;border-radius:3px 3px 0 0;"></div>
        </div>`;
      }).join('')}
    </div>`;
  document.getElementById('cog-hist-modal-trend').innerHTML = trendHTML;

  // Table newest first with delta
  const rows = [...snaps].reverse().map((s, i, arr) => {
    const m    = parseFloat(s.GrossMargin);
    const prev = arr[i+1] ? parseFloat(arr[i+1].GrossMargin) : null;
    const delta = (prev !== null && !isNaN(prev) && !isNaN(m)) ? m - prev : null;
    const mColor = isNaN(m) ? '#999' : m >= 65 ? '#16a34a' : m >= 50 ? '#d97706' : '#dc2626';
    const deltaHtml = delta === null ? '—'
      : `<span style="color:${delta>0?'#16a34a':delta<0?'#dc2626':'#999'}">${delta>0?'↑':'↓'} ${Math.abs(delta).toFixed(1)}%</span>`;
    const dateStr = s.SnapshotDate ? new Date(s.SnapshotDate).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
    return `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:7px 10px;">${dateStr}</td>
      <td style="padding:7px 10px;">${s.SellingPrice ? '$'+parseFloat(s.SellingPrice).toFixed(2) : '—'}</td>
      <td style="padding:7px 10px;">${s.COG ? '$'+parseFloat(s.COG).toFixed(3) : '—'}</td>
      <td style="padding:7px 10px;font-weight:700;color:${mColor}">${!isNaN(m) ? m.toFixed(1)+'%' : '—'}</td>
      <td style="padding:7px 10px;">${deltaHtml}</td>
    </tr>`;
  }).join('');

  document.getElementById('cog-hist-modal-table').innerHTML = `
    <table style="width:100%;font-size:13px;border-collapse:collapse;">
      <thead><tr style="border-bottom:2px solid var(--border);">
        <th style="text-align:left;padding:7px 10px;">Date</th>
        <th style="text-align:left;padding:7px 10px;">Price</th>
        <th style="text-align:left;padding:7px 10px;">COG</th>
        <th style="text-align:left;padding:7px 10px;">Margin</th>
        <th style="text-align:left;padding:7px 10px;">Change</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  openModal('modal-cog-item-history');
}

function renderCogHistory() {
  const tbody = document.getElementById('cogs-hist-body');
  const empty = document.getElementById('cogs-hist-empty');
  const count = document.getElementById('cogs-hist-count');
  if (!tbody) return;

  const filterItem = document.getElementById('cogs-hist-item')?.value || '';
  let snaps = [...cache.cogSnapshots].sort((a,b) => new Date(b.SnapshotDate||0) - new Date(a.SnapshotDate||0));
  // Exclude hidden items — match by MenuItemId against _cogsHiddenIds
  snaps = snaps.filter(s => !_cogsHiddenIds.has(s.MenuItemId));
  if (filterItem) snaps = snaps.filter(s => s.MenuItemName === filterItem);

  if (count) count.textContent = snaps.length ? `${snaps.length} records` : '';
  if (!snaps.length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    document.getElementById('cogs-hist-table').style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  document.getElementById('cogs-hist-table').style.display = '';

  // Build previous-snapshot map per item:variation for delta calc
  const prevMap = {}; // key → snapshot just before current in sorted order
  const byKey = {};
  [...snaps].reverse().forEach(s => {
    const k = `${s.MenuItemId}:${s.VariationName}`;
    if (!byKey[k]) byKey[k] = [];
    byKey[k].push(s);
  });

  tbody.innerHTML = snaps.map(s => {
    const margin = parseFloat(s.GrossMargin);
    const marginColor = isNaN(margin) ? '#999' : margin >= 65 ? '#16a34a' : margin >= 50 ? '#d97706' : '#dc2626';
    const dateStr = s.SnapshotDate
      ? new Date(s.SnapshotDate).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
      : '—';
    // Find previous snapshot for this item (next oldest)
    const k    = `${s.MenuItemId}:${s.VariationName}`;
    const arr  = byKey[k] || [];
    const idx  = arr.findIndex(x => x === s);
    const prev = arr[idx+1] ? parseFloat(arr[idx+1].GrossMargin) : null;
    const delta = (prev !== null && !isNaN(prev) && !isNaN(margin)) ? margin - prev : null;
    const deltaHtml = delta === null ? '<span style="color:var(--muted)">—</span>'
      : `<span style="color:${delta>0?'#16a34a':delta<0?'#dc2626':'#999'}">${delta>0?'↑':'↓'} ${Math.abs(delta).toFixed(1)}%</span>`;
    return `<tr>
      <td>${dateStr}</td>
      <td><button style="background:none;border:none;cursor:pointer;color:var(--gold);font-size:13px;padding:0;text-align:left;" data-name="${escHtml(s.MenuItemName||'')}" data-var="${escHtml(s.VariationName||'')}" onclick="openCogHistoryModal(this.dataset.name,this.dataset.var)">${escHtml(s.MenuItemName||'')}</button></td>
      <td><span style="font-size:11px;background:var(--opal);padding:2px 8px;border-radius:10px;">${escHtml(s.VariationName||'')}</span></td>
      <td>${s.SellingPrice ? '$'+parseFloat(s.SellingPrice).toFixed(2) : '—'}</td>
      <td>${s.COG ? '$'+parseFloat(s.COG).toFixed(3) : '—'}</td>
      <td><span style="font-weight:700;color:${marginColor};">${!isNaN(margin) ? margin.toFixed(1)+'%' : '—'}</span></td>
      <td>${deltaHtml}</td>
    </tr>`;
  }).join('');
}
