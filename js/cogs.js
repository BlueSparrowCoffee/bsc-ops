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

  renderCogCards();
}

function toggleCogHidden(itemId) {
  if (_cogsHiddenIds.has(itemId)) _cogsHiddenIds.delete(itemId);
  else _cogsHiddenIds.add(itemId);
  const json = JSON.stringify([..._cogsHiddenIds]);
  localStorage.setItem('bsc_cogs_hidden', json);
  saveSetting('cogs_hidden', json).catch(() => {});
  renderCogCards();
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

    const priceMap = {}, catMap = {}, nameToSqId = {};
    for (const obj of objects) {
      if (obj.type !== 'ITEM' || obj.is_deleted) continue;
      const d = obj.item_data || {};
      const vars = d.variations || [];
      const priced = vars.filter(v => v.item_variation_data?.price_money);
      const cat = resolveCategory(d);
      catMap[obj.id] = cat;
      const objName = (d.name || '').toLowerCase().trim();
      if (objName) nameToSqId[objName] = obj.id;
      if (!priced.length) continue;
      priceMap[obj.id] = priced[0].item_variation_data.price_money.amount / 100;
      for (const v of priced) { priceMap[v.id] = v.item_variation_data.price_money.amount / 100; catMap[v.id] = cat; }
    }
    log(`Found ${Object.keys(priceMap).length} priced entries, ${Object.keys(categories).length} categories`);

    // For Food & Grocery: import any missing items from the matching Square category
    const squareCatItems = objects.filter(o => {
      if (o.type !== 'ITEM' || o.is_deleted) return false;
      return (resolveCategory(o.item_data || {})||'').toLowerCase() === cfg.squareCat.toLowerCase();
    });
    log(`${squareCatItems.length} items in "${cfg.squareCat}" Square category`);

    const siteId = await getSiteId();
    const currentList = cache[cfg.cacheKey];
    const existingNames = new Set(currentList.map(i => (i.ItemName||i.Title||'').toLowerCase().trim()));
    const existingIds   = new Set(currentList.map(i => (i.SquareCatalogItemId||'').trim()).filter(Boolean));

    let imported = 0;
    for (const obj of squareCatItems) {
      const d = obj.item_data || {};
      const name = (d.name || '').trim();
      if (!name || existingNames.has(name.toLowerCase()) || existingIds.has(obj.id)) continue;
      const price = priceMap[obj.id] ?? null;
      const cat   = resolveCategory(d);
      const fields = { ItemName: name, Category: cat || cfg.squareCat, SquareCatalogItemId: obj.id,
        ...(price != null ? { SellingPrice: price } : {}) };
      const newItem = await addListItem(LISTS[cfg.listKey], fields);
      cache[cfg.cacheKey].push(newItem);
      existingNames.add(name.toLowerCase()); existingIds.add(obj.id);
      imported++; log(`  + ${name}${price != null ? ' $'+price.toFixed(2) : ''}`);
    }
    if (imported) log(`Imported ${imported} new items\n`);

    // Update prices for all existing items
    let updated = 0, autoLinked = 0, unchanged = 0, notFound = 0;
    for (const item of cache[cfg.cacheKey]) {
      const itemName = (item.ItemName || item.Title || '').trim();
      let sqId = (item.SquareCatalogItemId || '').trim();
      if (!sqId) { sqId = nameToSqId[itemName.toLowerCase()] || ''; if (!sqId) { notFound++; continue; } }
      const price = priceMap[sqId];
      if (price == null) { notFound++; log(`  ⚠ No price: ${itemName}`); continue; }
      const cat = catMap[sqId] || null;
      const fields = { SellingPrice: price };
      if (!item.SquareCatalogItemId) fields.SquareCatalogItemId = sqId;
      if (cat && cat !== item.Category) fields.Category = cat;
      if (item.SellingPrice === price && item.SquareCatalogItemId && !fields.Category) { unchanged++; continue; }
      await updateListItem(LISTS[cfg.listKey], item.id, fields);
      Object.assign(item, fields);
      if (!item.SquareCatalogItemId || fields.SquareCatalogItemId) { autoLinked++; log(`  🔗 ${itemName}: $${price.toFixed(2)}`); }
      else { updated++; log(`  ✓ ${itemName}: $${price.toFixed(2)}`); }
    }

    log(`\n✅ Done — ${imported} imported, ${updated} updated, ${autoLinked} auto-linked, ${unchanged} unchanged, ${notFound} not found`);
    renderInvCogCards(tabKey);
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
}

async function updateInvCogField(id, field, rawValue, tabKey) {
  const val = rawValue === '' ? null : parseFloat(rawValue);
  const cfg = INV_COG_CFG[tabKey];
  try {
    await updateListItem(LISTS[cfg.listKey], id, { [field]: isNaN(val) ? null : val });
    const item = cache[cfg.cacheKey].find(i => i.id === id);
    if (item) item[field] = isNaN(val) ? null : val;
    renderInvCogCards(tabKey);
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
    <div class="card" style="padding:0;overflow:hidden;${isHidden?'opacity:0.5;':''}">
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
    <div class="card" data-gs-id="${escHtml(item.id)}" style="padding:0;overflow:hidden;${isHidden?'opacity:0.5;':''}">
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
  if (pt.type === 'coffee-bar') {
    openCogHistoryModal(pt.itemName, pt.varName);
    return;
  }
  if (typeof cogTab === 'function' && _cogChartData[idx].type) cogTab(_cogChartData[idx].type);
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
    ${pt.type === 'coffee-bar' ? '<div style="font-size:10px;color:var(--gold);margin-top:6px;">Click for history →</div>' : '<div style="font-size:10px;color:var(--gold);margin-top:6px;">Click to open tab →</div>'}
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

  // Tooltip container — created once, reused
  let tip = document.getElementById('cog-chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'cog-chart-tip';
    tip.style.cssText = 'position:absolute;display:none;pointer-events:none;background:rgba(12,15,22,.96);border:1px solid rgba(200,169,81,.35);border-radius:10px;padding:10px 12px;min-width:180px;max-width:260px;box-shadow:0 8px 24px rgba(0,0,0,.5);z-index:30;backdrop-filter:blur(6px);';
  }
  tip.style.display = 'none'; // reset on re-render so stale tooltip doesn't linger

  if (!items.length) {
    el.innerHTML = `<div class="card" style="padding:32px 16px;text-align:center;color:var(--muted);font-size:13px;">No priced items yet — snapshot a Coffee Bar recipe or set Cost/Price on merch/food/grocery items.</div>`;
    return;
  }

  // Responsive SVG — fills container width, stays 300px tall visually.
  const VB_W = 680, VB_H = 320;
  const PAD_L = 52, PAD_R = 20, PAD_T = 20, PAD_B = 50;
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
  svg.push(`<rect x="${PAD_L}" y="${tyTop}" width="${plotW}" height="${tyTar - tyTop}" fill="#16a34a" opacity=".04"/>`);
  // Danger band — below 80% of target
  const dangerY = yScale(target * 0.8);
  svg.push(`<rect x="${PAD_L}" y="${dangerY}" width="${plotW}" height="${PAD_T + plotH - dangerY}" fill="#dc2626" opacity=".05"/>`);

  // Grid — Y
  [0, 25, 50, 75, 100].forEach(m => {
    const y = yScale(m);
    svg.push(`<line x1="${PAD_L}" y1="${y}" x2="${VB_W - PAD_R}" y2="${y}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>`);
    svg.push(`<text x="${PAD_L - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="rgba(255,255,255,.45)">${m}%</text>`);
  });

  // Grid — X (log or linear depending on toggle)
  if (useLog) {
    // Pick round decade + mid-decade ticks that fall inside the visible range.
    const candidates = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const lo = Math.pow(10, logMin) * 0.9;
    const hi = Math.pow(10, logMax) * 1.1;
    candidates.filter(v => v >= lo && v <= hi).forEach(p => {
      const x = xScale(p);
      svg.push(`<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${PAD_T + plotH}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>`);
      svg.push(`<text x="${x}" y="${PAD_T + plotH + 16}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.45)">$${p < 1 ? p : p}</text>`);
    });
  } else {
    const xStep = xCeil <= 10 ? 2 : xCeil <= 20 ? 5 : xCeil <= 50 ? 10 : xCeil <= 100 ? 20 : 25;
    for (let p = 0; p <= xCeil; p += xStep) {
      const x = xScale(p);
      svg.push(`<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${PAD_T + plotH}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>`);
      svg.push(`<text x="${x}" y="${PAD_T + plotH + 16}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.45)">$${p}</text>`);
    }
  }

  // Axis borders
  svg.push(`<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + plotH}" stroke="rgba(255,255,255,.18)" stroke-width="1"/>`);
  svg.push(`<line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${VB_W - PAD_R}" y2="${PAD_T + plotH}" stroke="rgba(255,255,255,.18)" stroke-width="1"/>`);

  // Axis labels
  svg.push(`<text x="${PAD_L + plotW / 2}" y="${VB_H - 8}" text-anchor="middle" font-size="11" fill="rgba(255,255,255,.55)">Selling Price ($)${useLog ? ' · log scale' : ''}</text>`);
  svg.push(`<text transform="rotate(-90)" x="${-(PAD_T + plotH / 2)}" y="14" text-anchor="middle" font-size="11" fill="rgba(255,255,255,.55)">Margin %</text>`);

  // Target line
  svg.push(`<line x1="${PAD_L}" y1="${tyTar}" x2="${VB_W - PAD_R}" y2="${tyTar}" stroke="#c8a951" stroke-width="1.5" stroke-dasharray="6,4" opacity=".85"/>`);
  svg.push(`<text x="${VB_W - PAD_R - 4}" y="${tyTar - 5}" text-anchor="end" font-size="10" fill="#c8a951" opacity=".95" font-weight="600">Target ${target}%</text>`);

  // Avg line (visible items, not hidden)
  if (visibleItems.length) {
    const avg = visibleItems.reduce((s, i) => s + i.margin, 0) / visibleItems.length;
    const ya = yScale(avg);
    svg.push(`<line x1="${PAD_L}" y1="${ya}" x2="${VB_W - PAD_R}" y2="${ya}" stroke="#7dd3fc" stroke-width="1" stroke-dasharray="2,3" opacity=".55"/>`);
    svg.push(`<text x="${PAD_L + 6}" y="${ya - 4}" font-size="10" fill="#7dd3fc" opacity=".85">Avg ${avg.toFixed(1)}%</text>`);
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
        style="display:inline-flex;align-items:center;gap:5px;background:${hidden?'transparent':'rgba(255,255,255,.05)'};border:1px solid ${hidden?'rgba(255,255,255,.1)':cfg.ring+'66'};border-radius:14px;padding:3px 9px 3px 6px;font-size:11px;color:${hidden?'rgba(255,255,255,.35)':'rgba(255,255,255,.85)'};cursor:pointer;line-height:1;">
        <svg width="14" height="14" viewBox="0 0 14 14" style="flex-shrink:0;${hidden?'opacity:.4':''}">${prev}</svg>
        <span>${escHtml(cfg.label)}</span>
        <span style="color:rgba(255,255,255,.45);font-variant-numeric:tabular-nums;">${count}</span>
      </button>`;
    }).join('');

  const marginKey = `
    <div style="display:flex;gap:10px;align-items:center;font-size:10px;color:rgba(255,255,255,.55);">
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:#16a34a;"></span>≥${target}%</span>
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:#d97706;"></span>≥${Math.round(target*0.8)}%</span>
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:#dc2626;"></span>&lt;${Math.round(target*0.8)}%</span>
    </div>`;

  el.innerHTML = `
    <div class="card" style="padding:16px;position:relative;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <div>
          <div style="font-size:12px;font-weight:700;color:rgba(255,255,255,.75);letter-spacing:.6px;">MARGIN VS. PRICE</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;">Click a dot to drill in · click the chips to filter types</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button type="button" onclick="toggleCogChartLogScale()" title="${useLog ? 'Switch to linear $ axis' : 'Switch to log₁₀ $ axis — spreads out dense low-price clusters'}" style="display:inline-flex;align-items:center;gap:5px;background:${useLog?'rgba(200,169,81,.18)':'rgba(255,255,255,.05)'};border:1px solid ${useLog?'rgba(200,169,81,.55)':'rgba(255,255,255,.15)'};border-radius:14px;padding:3px 10px;font-size:11px;color:${useLog?'#c8a951':'rgba(255,255,255,.75)'};cursor:pointer;line-height:1;font-weight:600;">${useLog ? '📐 Log $' : '📏 Linear $'}</button>
          ${marginKey}
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">${legendChips}</div>
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
  const showHidden = document.getElementById('cogs-overview-show-hidden')?.checked || false;

  // Build latest snapshot per coffee-bar item (MenuItemId:VariationName)
  const latestSnap = {};
  [...cache.cogSnapshots]
    .sort((a,b) => new Date(a.SnapshotDate) - new Date(b.SnapshotDate))
    .forEach(s => { latestSnap[`${s.MenuItemId}:${s.VariationName}`] = s; });

  const items = [];

  // Coffee Bar — from snapshots
  if (!typeFilter || typeFilter === 'coffee-bar') {
    Object.values(latestSnap).forEach(s => {
      const margin = parseFloat(s.GrossMargin);
      if (isNaN(margin)) return;
      const menuItem = cache.menu.find(m => (m.SquareId || m.id) === s.MenuItemId);
      const spId = menuItem?.id || s.MenuItemId;
      const isHidden = _cogsHiddenIds.has(spId);
      items.push({
        type: 'coffee-bar', typeLabel: 'Coffee Bar',
        name: s.MenuItemName, variation: s.VariationName,
        category: menuItem?.Category || 'Coffee Bar',
        margin, price: parseFloat(s.SellingPrice)||0, cog: parseFloat(s.COG)||0,
        snapshotDate: s.SnapshotDate,
        histKey: `${s.MenuItemId}:${s.VariationName}`,
        itemName: s.MenuItemName, varName: s.VariationName,
        spId, isHidden
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
        spId: i.id, isHidden
      });
    });
  }

  // Filter hidden for stats (always exclude hidden from numbers)
  const visibleItems = items.filter(i => !i.isHidden);

  // Sort all items (hidden ones shown dimmed at end if showHidden)
  const sortFn = sort === 'margin-asc' ? (a,b) => a.margin - b.margin
               : sort === 'margin-desc' ? (a,b) => b.margin - a.margin
               : (a,b) => a.name.localeCompare(b.name);
  visibleItems.sort(sortFn);
  const hiddenItems = items.filter(i => i.isHidden).sort(sortFn);
  const displayItems = showHidden ? [...visibleItems, ...hiddenItems] : visibleItems;

  // Stats — visible items only
  const avg   = visibleItems.length ? visibleItems.reduce((s,i) => s+i.margin, 0) / visibleItems.length : 0;
  const below = visibleItems.filter(i => i.margin < target).length;
  const best  = visibleItems.reduce((b,i) => i.margin > (b?.margin??-Infinity) ? i : b, null);
  const worst = visibleItems.reduce((w,i) => i.margin < (w?.margin??Infinity)  ? i : w, null);

  statsEl.innerHTML = [
    ['Total Items', items.length],
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
    bodyEl.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:32px 0">No items with cost and price data yet. Snapshot Costs on the Coffee Bar tab, or set Cost/Price on Merch, Food, and Grocery items.</div>';
    return;
  }

  bodyEl.innerHTML = displayItems.map(item => {
    const m = item.margin;
    const mColor = item.isHidden ? '#aaa' : m >= target ? '#16a34a' : m >= target * 0.8 ? '#d97706' : '#dc2626';
    const barW   = Math.min(100, Math.max(0, m)).toFixed(1);
    const typePill = `<span style="font-size:10px;background:var(--opal);color:var(--dark-blue);padding:1px 6px;border-radius:8px;">${escHtml(item.typeLabel)}</span>`;
    const histBtn  = item.histKey
      ? `<button style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--gold);padding:0;" data-name="${escHtml(item.itemName)}" data-var="${escHtml(item.varName)}" onclick="openCogHistoryModal(this.dataset.name,this.dataset.var)">History →</button>`
      : '';
    const hideBtn = `<button style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--muted);padding:0;"
      data-id="${escHtml(item.spId)}" data-type="${escHtml(item.type)}"
      onclick="toggleOverviewCogHidden(this.dataset.type,this.dataset.id)"
      title="${item.isHidden ? 'Show in summary' : 'Hide from summary'}">${item.isHidden ? '👁 Show' : '🙈 Hide'}</button>`;
    return `<div class="card" style="padding:14px 16px;${item.isHidden ? 'opacity:0.45;' : ''}">
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

// ── Merch duplicate finder (Step 1 — diagnostic only, read-only) ──────────
// Aggressive name normalization: lowercase, trim, collapse whitespace, strip
// smart quotes + apostrophes, collapse " and " / " & ", and normalize common
// size descriptors like "12oz"/"12 oz"/"12 ounces" → "12oz". Intentionally
// loose so e.g. "Platte Blend 12 oz" and "Platte Blend 12oz" collapse into
// one bucket even though the case-insensitive raw compare misses them.
function normalizeMerchName(raw) {
  if (!raw) return '';
  let s = String(raw).toLowerCase().trim();
  s = s.normalize('NFKD').replace(/[\u2018\u2019\u201C\u201D]/g, "'");
  s = s.replace(/\s+and\s+/g, ' & ');         // "Cups and Lids" → "Cups & Lids"
  s = s.replace(/\s*&\s*/g, ' & ');            // normalize spacing around &
  s = s.replace(/(\d+)\s*(oz|ounce|ounces|lb|lbs|pound|pounds|ml|g|gram|grams)\b/g, (_, n, u) => {
    const norm = { oz:'oz', ounce:'oz', ounces:'oz', lb:'lb', lbs:'lb', pound:'lb', pounds:'lb', ml:'ml', g:'g', gram:'g', grams:'g' }[u] || u;
    return n + norm;
  });
  s = s.replace(/[^a-z0-9 &']+/g, ' ');        // strip punctuation (keep & and ')
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Module-level storage for dedup-merge UI state. Each group rendered in the
// dedup modal gets a unique id so its button onclicks can look up the right
// rows + user-picked keeper. Populated by renderDedupGroup, read by
// previewDedupMerge / confirmDedupMerge.
const _dedupGroups = {};
let _dedupGroupCounter = 0;
// Manual-merge picker state — ids of rows the user has checked in the full
// merch list below the auto-groups. Reset every scan.
const _manualSelectedIds = new Set();

// Token Jaccard similarity — splits on whitespace after normalization, strips
// tokens shorter than 2 chars, then returns |A∩B| / |A∪B|.
//
// DISTINGUISHING TOKENS: words that, if present in one name but not the other,
// mean the two rows are DIFFERENT products even when the rest overlaps. Examples
// caught by this rule:
//   "Sweatshirt, Platte st. Crewneck"  vs  "Sweatshirt, Blake st. Crewneck"
//     → location differs (platte vs blake) → not a dupe
//   "Free Dog Toys"  vs  "Dog Toys"
//     → "free" is a modifier word on only one side → not a dupe (giveaway vs. retail)
// We return 0 similarity whenever a distinguishing-token disagreement is found.
const MERCH_DISTINGUISHING_TOKENS = new Set([
  // Location words — a sweatshirt for Blake is a different SKU than one for Platte
  'blake', 'platte', 'sherman', '17th',
  // Modifier words — change the pricing/usage category, not the product
  'free', 'sample', 'staff', 'promo', 'demo', 'test', 'damaged', 'refund', 'comp',
]);
function merchNameTokens(raw) {
  const n = normalizeMerchName(raw);
  return new Set(n.split(' ').filter(t => t.length >= 2));
}
function merchNameSimilarity(a, b) {
  const A = merchNameTokens(a), B = merchNameTokens(b);
  if (!A.size || !B.size) return 0;
  // Hard disqualifier: any distinguishing token that appears in one set but not
  // the other → these are different products, no matter how much else overlaps.
  for (const tok of MERCH_DISTINGUISHING_TOKENS) {
    if (A.has(tok) !== B.has(tok)) return 0;
  }
  let inter = 0;
  A.forEach(t => { if (B.has(t)) inter++; });
  return inter / (A.size + B.size - inter);
}

// Force a fresh pull of BSC_MerchInventory from SharePoint before re-scanning.
// Use this when you suspect cache is stale (e.g. merged dupes "still showing"
// — a SignalR reload race, another tab writing, or manual edits in SP UI).
async function reloadMerchAndRescan() {
  const statusEl = document.getElementById('merch-dedup-status');
  if (statusEl) statusEl.textContent = 'Reloading BSC_MerchInventory from SharePoint…';
  try {
    const siteId = await getSiteId();
    const fresh = await getListItems(siteId, LISTS.merchInventory);
    cache.merchInventory = fresh || [];
    console.log('[dedup] reloaded merch inventory, rows =', cache.merchInventory.length);
    if (typeof toast === 'function') toast('ok', `✓ Reloaded ${cache.merchInventory.length} merch rows`);
  } catch (e) {
    console.error('[dedup] reload failed:', e);
    if (typeof toast === 'function') toast('err', 'Reload failed: ' + (e.message || e));
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">Reload failed: ${escHtml(e.message||e)}</span>`;
    return;
  }
  findMerchDuplicates();
}

async function findMerchDuplicates() {
  console.log('[dedup] findMerchDuplicates fired; cache.merchInventory rows =', (cache.merchInventory||[]).length);
  const btn = document.getElementById('merch-dedup-btn');
  const statusEl = document.getElementById('merch-dedup-status');
  const resultsEl = document.getElementById('merch-dedup-results');

  // If the modal isn't in the DOM, the deploy is partial — surface it loudly.
  const modal = document.getElementById('modal-merch-dedup');
  if (!modal || !resultsEl || !statusEl) {
    const msg = '[dedup] Modal elements missing — the HTML portion of the deploy is not live yet. Fully quit the PWA / browser tab and reopen to pick up the latest index.html.';
    console.error(msg, { modal, resultsEl, statusEl });
    if (typeof toast === 'function') toast('err', 'Dedup UI not loaded — close and reopen the app');
    else alert(msg);
    return;
  }

  if (typeof openModal === 'function') openModal('modal-merch-dedup');
  else modal.style.display = 'flex';
  resultsEl.innerHTML = '';
  statusEl.textContent = 'Scanning merch inventory…';
  if (btn) btn.disabled = true;

  try {
    // Reset group state — previous scan's merge buttons are now dead DOM refs.
    Object.keys(_dedupGroups).forEach(k => delete _dedupGroups[k]);
    _dedupGroupCounter = 0;
    _manualSelectedIds.clear();

    // Exclude archived rows — they're already soft-deleted and shouldn't surface
    // as duplicates. Same truthy convention as counts.js / vendors.js.
    const merch = (cache.merchInventory || []).filter(i => !i.Archived);

    // Group A — duplicate SquareCatalogItemId (strongest signal)
    const bySqId = {};
    merch.forEach(i => {
      const sq = (i.SquareCatalogItemId || '').trim();
      if (!sq) return;
      (bySqId[sq] = bySqId[sq] || []).push(i);
    });
    const groupA = Object.entries(bySqId)
      .filter(([, rows]) => rows.length > 1)
      .map(([sqId, rows]) => ({ sqId, rows }));

    // Group B — duplicate normalized name
    const byName = {};
    merch.forEach(i => {
      const n = normalizeMerchName(i.ItemName || i.Title || '');
      if (!n) return;
      (byName[n] = byName[n] || []).push(i);
    });
    const groupB = Object.entries(byName)
      .filter(([, rows]) => rows.length > 1)
      // Hide rows that are already captured by Group A to avoid double-listing
      .map(([n, rows]) => ({ normName: n, rows }))
      .filter(g => {
        const sqIds = g.rows.map(r => (r.SquareCatalogItemId||'').trim()).filter(Boolean);
        if (sqIds.length < 2) return true;
        return new Set(sqIds).size > 1; // still interesting if SqIds differ
      });

    // Group C — orphans (no SquareCatalogItemId) whose normalized name
    // matches a Square catalog item. Fetch Square catalog once.
    statusEl.textContent = 'Fetching Square catalog for orphan match…';
    let squareItems = [];
    let squareFetchError = null;
    try {
      let cursor = null;
      do {
        const params = `catalog/list?types=ITEM${cursor ? '&cursor='+encodeURIComponent(cursor) : ''}`;
        const data = await squareAPI('GET', params);
        squareItems = squareItems.concat(data.objects || []);
        cursor = data.cursor || null;
      } while (cursor);
    } catch (e) {
      squareFetchError = e.message || 'Square fetch failed';
    }

    // Map normalized Square name → Square item (first match wins)
    const sqNameMap = {};
    squareItems.forEach(o => {
      if (o.is_deleted) return;
      const name = o.item_data?.name;
      if (!name) return;
      const n = normalizeMerchName(name);
      if (n && !sqNameMap[n]) sqNameMap[n] = { id: o.id, name };
    });

    const orphanRows = merch.filter(i => !(i.SquareCatalogItemId || '').trim());
    const groupC = orphanRows
      .map(row => {
        const n = normalizeMerchName(row.ItemName || row.Title || '');
        const sq = sqNameMap[n];
        return sq ? { row, sq } : null;
      })
      .filter(Boolean)
      // Exclude orphans that are already in Group B with a Square-linked sibling
      // (those will get handled as part of the dupe merge).
      .filter(({ row }) => {
        const n = normalizeMerchName(row.ItemName || row.Title || '');
        const group = byName[n] || [];
        return !group.some(r => r !== row && (r.SquareCatalogItemId||'').trim());
      });

    // Group D — fuzzy token-overlap matches (catches dupes whose names differ
    // enough to escape Group B, e.g. one has extra descriptor words). Uses
    // union-find to merge transitively-similar rows into the same bucket.
    statusEl.textContent = 'Running fuzzy name match…';
    // Raised from 0.6 → 0.75 to cut false positives like "Sweatshirt, Platte" vs
    // "Sweatshirt, Blake" (which also hits the distinguishing-token guard above,
    // but the tighter threshold is a second line of defense for unseen cases).
    const SIM_THRESHOLD = 0.75;
    const parent = merch.map((_, i) => i);
    const find = (x) => parent[x] === x ? x : (parent[x] = find(parent[x]));
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    // Rows already exact-matched in Group A/B — skip so we don't re-list them
    const alreadyGrouped = new Set();
    groupA.forEach(g => g.rows.forEach(r => alreadyGrouped.add(r.id)));
    groupB.forEach(g => g.rows.forEach(r => alreadyGrouped.add(r.id)));
    for (let i = 0; i < merch.length; i++) {
      for (let j = i + 1; j < merch.length; j++) {
        const a = merch[i], b = merch[j];
        const sim = merchNameSimilarity(a.ItemName||a.Title||'', b.ItemName||b.Title||'');
        if (sim >= SIM_THRESHOLD) union(i, j);
      }
    }
    const fuzzyBuckets = {};
    merch.forEach((row, idx) => {
      const r = find(idx);
      (fuzzyBuckets[r] = fuzzyBuckets[r] || []).push(row);
    });
    const groupD = Object.values(fuzzyBuckets)
      .filter(rows => rows.length > 1)
      // Drop buckets where every row was already captured by Group A/B
      .filter(rows => rows.some(r => !alreadyGrouped.has(r.id)));

    // Group E — complementary data pairs. Catches the dominant real-world
    // duplicate pattern in this app: one row from Square sync (has Square ID +
    // SellingPrice, usually no cost — Square's API doesn't return cost) and
    // one row from a manual/spreadsheet import (has CostPerUnit, no Square ID,
    // usually no price). The names diverge enough that Groups B/D miss them:
    //   "Beanie" ↔ "BSC Logo Beanie"  (Jaccard 0.33 — far below threshold)
    //   "Candle" ↔ "Chai Candle"       (Jaccard 0.50)
    //   "Dog Toys" ↔ "Free Dog Toys"  (Jaccard 0.67 but killed by the
    //                                  "free" distinguishing-token guard)
    // Matching strategy: score every (cost-only × price-only) pair by
    // token overlap count (NOT Jaccard — we want raw overlap because very
    // short names like "Beanie" would otherwise drown in denominator). Break
    // ties with a +1 category match bonus. Then greedy-assign best-first with
    // no double-pairing. One shared token is the minimum signal.
    //
    // Requires ≥2 shared tokens (tightened from 1 after real-world testing
    // showed 1-token matches on generic category words like "mug", "matcha",
    // "dog", "crewneck" produced unrelated pairs across distinct products).
    // Also applies the MERCH_DISTINGUISHING_TOKENS guard symmetrically — an
    // asymmetric "free" / "blake" / "platte" / etc. token kills the pair even
    // if the 2-shared-token floor is met. Real 1-token pairs (e.g. "Beanie"
    // ↔ "BSC Logo Beanie") still drop into the unmatched-cost-only info
    // block below — visible for manual cleanup but no merge button fires.
    statusEl.textContent = 'Pairing cost-only rows with price-only rows…';
    const priceOnlyRows = merch.filter(r => (r.SquareCatalogItemId||'').trim());
    const costOnlyRows  = merch.filter(r => !(r.SquareCatalogItemId||'').trim());
    const pairCandidates = [];
    for (const cr of costOnlyRows) {
      const ct = merchNameTokens(cr.ItemName || cr.Title || '');
      if (!ct.size) continue;
      for (const pr of priceOnlyRows) {
        const pt = merchNameTokens(pr.ItemName || pr.Title || '');
        if (!pt.size) continue;
        // Distinguishing-token guard: if a known disqualifying token appears in
        // one name but not the other, skip. Catches "Free Dog Toys" ↔ "Dog
        // Toys" even though they share 2 tokens (dog, toys).
        let distinguishBroken = false;
        for (const tok of MERCH_DISTINGUISHING_TOKENS) {
          if (ct.has(tok) !== pt.has(tok)) { distinguishBroken = true; break; }
        }
        if (distinguishBroken) continue;
        let shared = 0;
        ct.forEach(t => { if (pt.has(t)) shared++; });
        if (shared < 2) continue;  // require ≥2 shared tokens — 1 is too loose on category-generic words
        const catMatch = (cr.Category||'').toLowerCase() === (pr.Category||'').toLowerCase() ? 1 : 0;
        pairCandidates.push({ costRow: cr, priceRow: pr, shared, catMatch, score: shared * 10 + catMatch });
      }
    }
    pairCandidates.sort((a, b) => b.score - a.score);
    const usedCostE = new Set();
    const usedPriceE = new Set();
    const groupE = [];
    for (const c of pairCandidates) {
      if (usedCostE.has(c.costRow.id) || usedPriceE.has(c.priceRow.id)) continue;
      usedCostE.add(c.costRow.id);
      usedPriceE.add(c.priceRow.id);
      groupE.push(c);
    }
    const unmatchedCostOnly = costOnlyRows.filter(r => !usedCostE.has(r.id));

    // Render
    const lines = [
      `<strong>${merch.length}</strong> merch rows scanned.`,
      groupA.length ? `<span style="color:var(--red)">${groupA.length}</span> Square-ID collision${groupA.length!==1?'s':''}` : '',
      groupB.length ? `<span style="color:var(--orange)">${groupB.length}</span> same-name group${groupB.length!==1?'s':''}` : '',
      groupD.length ? `<span style="color:#d97706">${groupD.length}</span> fuzzy-match group${groupD.length!==1?'s':''}` : '',
      groupE.length ? `<span style="color:#8a4fff">${groupE.length}</span> cost/price pair${groupE.length!==1?'s':''}` : '',
      groupC.length ? `<span style="color:var(--gold)">${groupC.length}</span> unlinked orphan${groupC.length!==1?'s':''} with Square match` : '',
      squareFetchError ? `<span style="color:var(--red)">⚠ Square catalog fetch failed: ${escHtml(squareFetchError)} — orphan detection skipped.</span>` : ''
    ].filter(Boolean).join(' · ');
    statusEl.innerHTML = lines || 'No duplicates or orphans detected.';

    const html = [];

    // Group A render
    if (groupA.length) {
      html.push(`<div style="font-weight:700;font-size:13px;color:var(--red);margin:14px 0 6px;">🔴 Same Square Catalog ID on multiple rows (${groupA.length})</div>`);
      html.push('<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">These are unambiguous duplicates — the Square ID is shared.</div>');
      groupA.forEach(g => {
        html.push(renderDedupGroup(`Square ID ${escHtml(g.sqId)}`, g.rows));
      });
    }

    // Group B render
    if (groupB.length) {
      html.push(`<div style="font-weight:700;font-size:13px;color:var(--orange);margin:18px 0 6px;">🟠 Same normalized name (${groupB.length})</div>`);
      html.push('<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Names collapse to identical form after aggressive normalization. Review carefully before merging — sometimes two rows share a name but are different products (e.g. different colorway).</div>');
      groupB.forEach(g => {
        html.push(renderDedupGroup(`"${escHtml(g.normName)}"`, g.rows));
      });
    }

    // Group D render (fuzzy matches)
    if (groupD.length) {
      html.push(`<div style="font-weight:700;font-size:13px;color:#d97706;margin:18px 0 6px;">🟠 Fuzzy name match (${groupD.length})</div>`);
      html.push(`<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Rows whose names share ≥60% of significant words. Looser than Group B — catches dupes where one row has extra descriptor words (e.g. "Platte Blend 12oz" vs "Platte Blend 12oz Medium Roast"). Review carefully; some matches here may be legitimately distinct products.</div>`);
      groupD.forEach((rows, idx) => {
        html.push(renderDedupGroup(`Fuzzy group ${idx + 1}`, rows));
      });
    }

    // Group E render (cost/price pairs — the most useful for real merch cleanup)
    if (groupE.length) {
      html.push(`<div style="font-weight:700;font-size:13px;color:#8a4fff;margin:18px 0 6px;">🟣 Suspected cost/price pairs (${groupE.length})</div>`);
      html.push(`<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Cost-only rows (no Square ID, has cost) paired with the most-likely price-only row (has Square ID, has price) via shared name tokens. This is usually the same product split across a manual import and a Square sync — merging consolidates cost + price + Square link onto one row. <strong>Review each pair carefully</strong> — a single shared word like "Mug" or "Candle" can pair unrelated products.</div>`);
      groupE.forEach((p, idx) => {
        const pname = p.priceRow.ItemName || p.priceRow.Title || '';
        const cname = p.costRow.ItemName  || p.costRow.Title  || '';
        const label = `Pair ${idx+1}: "${pname}" ↔ "${cname}" · ${p.shared} shared token${p.shared!==1?'s':''}${p.catMatch ? ', categories match' : ', categories differ'}`;
        html.push(renderDedupGroup(label, [p.priceRow, p.costRow]));
      });
    }

    // Unmatched cost-only info block — no merge buttons, just visibility so
    // the user can eyeball the list and catch anything the algorithm missed.
    if (unmatchedCostOnly.length) {
      html.push(`<div style="font-weight:700;font-size:13px;color:var(--muted);margin:18px 0 6px;">ℹ️ Cost-only rows with no auto-pair (${unmatchedCostOnly.length})</div>`);
      html.push(`<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">No price-only row shared ≥2 name tokens with these (1-token matches are deliberately excluded — generic words like "mug" or "matcha" pair unrelated products). These rows are either legitimately standalone products needing their own Square listing, or their pair has a completely different name. Scroll the full list below and tell me any missed pair so I can expand the matcher.</div>`);
      html.push(`<table style="width:100%;font-size:12px;border-collapse:collapse;margin-bottom:6px;background:rgba(255,255,255,.02);border-radius:6px;overflow:hidden;">
        <thead><tr style="background:rgba(255,255,255,.05);">
          <th style="text-align:left;padding:6px 8px;">Item Name</th>
          <th style="text-align:left;padding:6px 8px;">Category</th>
          <th style="text-align:right;padding:6px 8px;">Cost</th>
          <th style="text-align:right;padding:6px 8px;">Price</th>
        </tr></thead><tbody>
        ${unmatchedCostOnly.map(r => `<tr style="border-top:1px solid rgba(255,255,255,.06);">
          <td style="padding:5px 8px;">${escHtml(r.ItemName||r.Title||'')} <span style="font-size:10px;color:var(--red);">⚠ unlinked</span></td>
          <td style="padding:5px 8px;color:var(--muted);">${escHtml(r.Category||'—')}</td>
          <td style="padding:5px 8px;text-align:right;">${r.CostPerUnit ? '$'+parseFloat(r.CostPerUnit).toFixed(2) : '—'}</td>
          <td style="padding:5px 8px;text-align:right;">${r.SellingPrice ? '$'+parseFloat(r.SellingPrice).toFixed(2) : '—'}</td>
        </tr>`).join('')}
        </tbody></table>`);
    }

    // Group C render
    if (groupC.length) {
      html.push(`<div style="font-weight:700;font-size:13px;color:var(--gold);margin:18px 0 6px;">🟡 Unlinked orphans with a Square match (${groupC.length})</div>`);
      html.push('<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">These merch rows have no Square Catalog ID set, but a Square item exists with a matching normalized name. The Step 3 sync hardening will auto-link these so future Square syncs stop creating duplicates.</div>');
      html.push('<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;font-size:12px;">');
      html.push('<div style="font-weight:600;color:var(--muted);">Unlinked merch row</div><div style="font-weight:600;color:var(--muted);">Square match</div>');
      groupC.forEach(({ row, sq }) => {
        html.push(`<div>${escHtml(row.ItemName||row.Title||'')} <span style="color:var(--muted);font-size:11px;">· id ${escHtml(row.id)}</span></div>`);
        html.push(`<div>${escHtml(sq.name)} <span style="color:var(--muted);font-size:11px;">· ${escHtml(sq.id)}</span></div>`);
      });
      html.push('</div>');
    }

    if (!groupA.length && !groupB.length && !groupC.length && !groupD.length && !groupE.length) {
      html.push('<div style="padding:18px 0 8px;text-align:center;color:var(--muted);font-size:13px;">✨ Auto-matcher found no dupes. Scroll down and use the <strong style="color:var(--gold);">manual row-picker</strong> to merge any two rows by hand.</div>');
    } else {
      html.push(`<div style="margin-top:18px;padding:12px 14px;background:rgba(200,169,81,.08);border:1px solid rgba(200,169,81,.25);border-radius:8px;font-size:12px;color:rgba(255,255,255,.75);">
        <strong>How to merge:</strong> in any group above, choose the row to keep (<em>Keep</em> radio), click <strong>🔍 Preview merge</strong> to see what will change across <code>BSC_{loc}_MerchCounts</code> + <code>BSC_MerchInventory</code>, then <strong>✓ Confirm merge</strong>. Losers are soft-archived, not deleted.
      </div>`);
    }

    // Manual merge picker — sorted alphabetically by normalized name so near-
    // duplicates sit next to each other. Check 2+ rows → "Build merge group"
    // injects a standard dedup group (with keeper radio, preview, confirm)
    // into the panel below. The auto-matcher only catches patterns we've
    // taught it; this lets the user merge anything they can eyeball.
    const sortedAll = [...merch].sort((a, b) =>
      normalizeMerchName(a.ItemName||a.Title||'').localeCompare(normalizeMerchName(b.ItemName||b.Title||''))
    );
    html.push(`<details open style="margin-top:18px;">
      <summary style="cursor:pointer;font-weight:700;font-size:13px;color:var(--gold);padding:6px 0;">🎯 Pick rows manually to merge (${sortedAll.length} merch rows)</summary>
      <div style="font-size:11px;color:var(--muted);margin:4px 0 8px;">Check any 2+ rows below, then press <strong>Build merge group</strong>. A keeper picker + preview + confirm flow opens below the table — same safety checks as the auto-groups.</div>
      <div style="margin:8px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button id="manual-merge-build-btn" class="btn btn-primary" onclick="buildManualMergeGroup()" disabled style="font-size:12px;padding:6px 14px;">🔀 Build merge group from 0 selected</button>
        <button id="manual-merge-delete-btn" class="btn btn-outline" onclick="deleteManualMergeSelection()" disabled style="font-size:12px;padding:6px 14px;color:var(--red);border-color:var(--red);">🗑 Delete 0 permanently</button>
        <button class="btn btn-outline" onclick="clearManualMergeSelection()" style="font-size:12px;padding:6px 14px;">Clear selection</button>
        <span style="font-size:11px;color:var(--muted);">Merge preserves count history · Delete removes the row from BSC_MerchInventory entirely.</span>
      </div>
      <div id="manual-merge-panel" style="margin:10px 0;"></div>
      <table style="width:100%;font-size:11px;border-collapse:collapse;background:rgba(255,255,255,.02);border-radius:6px;overflow:hidden;">
        <thead><tr style="background:rgba(255,255,255,.05);">
          <th style="text-align:center;padding:6px 8px;width:40px;">Pick</th>
          <th style="text-align:left;padding:6px 8px;">Item Name</th>
          <th style="text-align:left;padding:6px 8px;">Normalized</th>
          <th style="text-align:left;padding:6px 8px;">Category</th>
          <th style="text-align:left;padding:6px 8px;">Sq ID</th>
          <th style="text-align:right;padding:6px 8px;">Cost</th>
          <th style="text-align:right;padding:6px 8px;">Price</th>
        </tr></thead><tbody>
        ${sortedAll.map(r => {
          const linked = !!(r.SquareCatalogItemId||'').trim();
          return `<tr style="border-top:1px solid rgba(255,255,255,.06);">
            <td style="padding:5px 8px;text-align:center;"><input type="checkbox" data-id="${escHtml(String(r.id))}" onchange="onManualMergeCheckboxChange(this)" style="cursor:pointer;width:16px;height:16px;"></td>
            <td style="padding:5px 8px;">${escHtml(r.ItemName||r.Title||'')}${linked?'':' <span style="font-size:10px;color:var(--red);">⚠</span>'}</td>
            <td style="padding:5px 8px;color:var(--muted);font-family:monospace;font-size:10px;">${escHtml(normalizeMerchName(r.ItemName||r.Title||''))}</td>
            <td style="padding:5px 8px;color:var(--muted);">${escHtml(r.Category||'—')}</td>
            <td style="padding:5px 8px;color:var(--muted);font-family:monospace;font-size:10px;">${linked?escHtml((r.SquareCatalogItemId||'').slice(0,14)):'—'}</td>
            <td style="padding:5px 8px;text-align:right;">${r.CostPerUnit?'$'+parseFloat(r.CostPerUnit).toFixed(2):'—'}</td>
            <td style="padding:5px 8px;text-align:right;">${r.SellingPrice?'$'+parseFloat(r.SellingPrice).toFixed(2):'—'}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </details>`);

    resultsEl.innerHTML = html.join('');
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red)">Scan failed: ${escHtml(e.message||e)}</span>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Manual merge picker handlers ─────────────────────────────────────────────
// The "Pick rows manually" table has a checkbox per row. Each toggle updates
// _manualSelectedIds and relabels the Build button. Clicking Build renders a
// standard dedup group (with keeper radio, preview, confirm) into the panel
// above the table so the merge still goes through the same safety gates.
function onManualMergeCheckboxChange(cb) {
  const id = cb.dataset.id;
  if (!id) return;
  if (cb.checked) _manualSelectedIds.add(id);
  else _manualSelectedIds.delete(id);
  _refreshManualMergeButtons();
}

// Keep the Build + Delete button labels in sync with _manualSelectedIds.size.
// Merge needs 2+ rows; delete accepts 1+.
function _refreshManualMergeButtons() {
  const n = _manualSelectedIds.size;
  const build = document.getElementById('manual-merge-build-btn');
  const del = document.getElementById('manual-merge-delete-btn');
  if (build) {
    build.textContent = `🔀 Build merge group from ${n} selected`;
    build.disabled = n < 2;
  }
  if (del) {
    del.textContent = `🗑 Delete ${n} permanently`;
    del.disabled = n < 1;
  }
}

function clearManualMergeSelection() {
  _manualSelectedIds.clear();
  document.querySelectorAll('#merch-dedup-results input[type="checkbox"][data-id]').forEach(cb => { cb.checked = false; });
  _refreshManualMergeButtons();
  const panel = document.getElementById('manual-merge-panel');
  if (panel) panel.innerHTML = '';
}

function buildManualMergeGroup() {
  if (_manualSelectedIds.size < 2) return;
  const merch = (cache.merchInventory || []).filter(i => !i.Archived);
  const rows = merch.filter(r => _manualSelectedIds.has(String(r.id)));
  if (rows.length < 2) {
    alert('Need at least 2 rows selected to build a merge group.');
    return;
  }
  const panel = document.getElementById('manual-merge-panel');
  if (!panel) return;
  panel.innerHTML = renderDedupGroup('Manual merge group (picked by you)', rows);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Hard-delete the picked merch rows from BSC_MerchInventory. Count-history
// rows in BSC_{loc}_MerchCounts are NOT touched — they'll become orphans
// (Title still references the deleted item, but no metadata row). Use merge
// instead if you want Title rewrites and keeper-field consolidation.
//
// Two confirmations: the first spells out exactly what will happen, the
// second is a final "really?" gate. Writes happen in batches of 8. Cache
// and UI refresh on success.
async function deleteManualMergeSelection() {
  if (!_manualSelectedIds.size) return;
  const merch = (cache.merchInventory || []).filter(i => !i.Archived);
  const rows = merch.filter(r => _manualSelectedIds.has(String(r.id)));
  if (!rows.length) return;
  const nameList = rows.map(r => '  • ' + (r.ItemName || r.Title || '(unnamed id ' + r.id + ')')).join('\n');
  const firstMsg =
    `⚠ PERMANENT DELETE — ${rows.length} row${rows.length>1?'s':''}\n\n` +
    `This will hard-delete the following from BSC_MerchInventory:\n\n${nameList}\n\n` +
    `Count history in BSC_{loc}_MerchCounts will NOT be deleted. Those rows will become orphans ` +
    `(referencing names that no longer exist in inventory). If you want Title rewrites to preserve ` +
    `count history, use MERGE instead.\n\nThis cannot be undone. Continue?`;
  if (!confirm(firstMsg)) return;
  if (!confirm(`Last chance — really permanently delete ${rows.length} row${rows.length>1?'s':''}?`)) return;

  const btn = document.getElementById('manual-merge-delete-btn');
  const buildBtn = document.getElementById('manual-merge-build-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  if (buildBtn) buildBtn.disabled = true;

  try {
    const tasks = rows.map(r => () => deleteListItem(LISTS.merchInventory, r.id));
    for (let i = 0; i < tasks.length; i += 8) {
      await Promise.all(tasks.slice(i, i + 8).map(fn => fn()));
    }
    // Evict from cache so the next scan doesn't still show them.
    const deletedIds = new Set(rows.map(r => String(r.id)));
    cache.merchInventory = (cache.merchInventory || []).filter(r => !deletedIds.has(String(r.id)));
    _manualSelectedIds.clear();
    if (typeof toast === 'function') toast('ok', `✓ Deleted ${rows.length} merch row${rows.length>1?'s':''}`);
    // Re-run the scan (which also clears selection state + re-renders the picker).
    findMerchDuplicates();
    if (typeof renderCogs === 'function') renderCogs();
  } catch (e) {
    console.error('[dedup] delete failed:', e);
    if (typeof toast === 'function') toast('err', 'Delete failed: ' + (e.message || e));
    if (btn) { btn.disabled = false; }
    _refreshManualMergeButtons();
  }
}

// Render one dedup group with a per-row keeper radio, a Preview button, and a
// disabled Confirm button. Clicking Preview fetches count history across all
// locations and fills the preview panel; clicking Confirm runs the merge.
function renderDedupGroup(label, rows) {
  const groupId = `grp_${++_dedupGroupCounter}`;
  // Default keeper: prefer a Square-linked row (so the merged survivor stays in
  // sync with Square), else the row with the highest numeric id (most recent).
  const linkedRows = rows.filter(r => (r.SquareCatalogItemId||'').trim());
  const defaultKeeper = linkedRows.length
    ? linkedRows[0].id
    : rows.slice().sort((a,b) => (+b.id||0) - (+a.id||0))[0].id;
  _dedupGroups[groupId] = { rows, label, keeperId: defaultKeeper };

  const hdr = `<div style="font-size:12px;color:rgba(255,255,255,.7);margin:10px 0 4px;">${escHtml(label)} · ${rows.length} rows</div>`;
  const table = `<table style="width:100%;font-size:12px;border-collapse:collapse;margin-bottom:6px;background:rgba(255,255,255,.02);border-radius:6px;overflow:hidden;">
    <thead><tr style="background:rgba(255,255,255,.05);">
      <th style="text-align:center;padding:6px 4px;width:40px;">Keep</th>
      <th style="text-align:left;padding:6px 8px;">SP ID</th>
      <th style="text-align:left;padding:6px 8px;">Item Name</th>
      <th style="text-align:left;padding:6px 8px;">Category</th>
      <th style="text-align:left;padding:6px 8px;">Square ID</th>
      <th style="text-align:right;padding:6px 8px;">Cost</th>
      <th style="text-align:right;padding:6px 8px;">Price</th>
    </tr></thead><tbody>
    ${rows.map(r => {
      const linked = !!(r.SquareCatalogItemId||'').trim();
      const checked = r.id === defaultKeeper ? 'checked' : '';
      return `<tr style="border-top:1px solid rgba(255,255,255,.06);">
        <td style="padding:6px 4px;text-align:center;"><input type="radio" name="keeper_${groupId}" value="${escHtml(r.id)}" ${checked} data-group-id="${groupId}" onchange="onDedupKeeperChange(this)"></td>
        <td style="padding:6px 8px;color:var(--muted);font-family:monospace;font-size:11px;">${escHtml(r.id)}</td>
        <td style="padding:6px 8px;">${escHtml(r.ItemName||r.Title||'')}${linked ? '' : ' <span style="font-size:10px;color:var(--red);">⚠ unlinked</span>'}</td>
        <td style="padding:6px 8px;color:var(--muted);">${escHtml(r.Category||'—')}</td>
        <td style="padding:6px 8px;color:var(--muted);font-family:monospace;font-size:11px;">${escHtml((r.SquareCatalogItemId||'').slice(0,18))||'—'}</td>
        <td style="padding:6px 8px;text-align:right;">${r.CostPerUnit ? '$'+parseFloat(r.CostPerUnit).toFixed(2) : '—'}</td>
        <td style="padding:6px 8px;text-align:right;">${r.SellingPrice ? '$'+parseFloat(r.SellingPrice).toFixed(2) : '—'}</td>
      </tr>`;
    }).join('')}
    </tbody></table>`;
  const actions = `<div id="merge-preview-${groupId}" style="margin:6px 0;padding:10px 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:6px;font-size:12px;line-height:1.6;display:none;"></div>
    <div style="margin:4px 0 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-outline btn-sm" data-group-id="${groupId}" onclick="previewDedupMerge(this.dataset.groupId)">🔍 Preview merge</button>
      <button class="btn btn-primary btn-sm" id="confirm-btn-${groupId}" data-group-id="${groupId}" onclick="confirmDedupMerge(this.dataset.groupId)" disabled>✓ Confirm merge</button>
      <span style="font-size:11px;color:var(--muted);">Keeper = Square-linked row by default. Preview is required before confirm.</span>
    </div>`;
  return hdr + table + actions;
}

// Keep _dedupGroups[gid].keeperId in sync with the radio selection. Invalidates
// any preview that was already computed against the prior keeper so the user
// can't Confirm a stale plan.
function onDedupKeeperChange(inp) {
  const gid = inp.dataset.groupId;
  const g = _dedupGroups[gid];
  if (!g) return;
  g.keeperId = inp.value;
  g.preview = null;
  const panel = document.getElementById(`merge-preview-${gid}`);
  const btn = document.getElementById(`confirm-btn-${gid}`);
  if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
  if (btn) btn.disabled = true;
}

// Fetch count history across every location, find rows that reference any
// loser's name, and compute what fields the keeper will gain. Writes nothing.
async function previewDedupMerge(groupId) {
  const g = _dedupGroups[groupId];
  if (!g) { if (typeof toast==='function') toast('err','Group not found'); return; }
  const panel = document.getElementById(`merge-preview-${groupId}`);
  const confirmBtn = document.getElementById(`confirm-btn-${groupId}`);
  if (!panel) return;
  panel.style.display = 'block';
  panel.innerHTML = `<em style="color:var(--muted);">Scanning count lists across all locations…</em>`;

  const keeper = g.rows.find(r => r.id === g.keeperId);
  const losers = g.rows.filter(r => r.id !== g.keeperId);
  if (!keeper || !losers.length) {
    panel.innerHTML = `<span style="color:var(--red)">Pick a keeper first.</span>`;
    return;
  }
  const keeperName = (keeper.ItemName||keeper.Title||'').trim();
  const loserNameSet = new Set(
    losers.map(r => (r.ItemName||r.Title||'').trim().toLowerCase()).filter(Boolean)
  );

  let countRefs = {};
  let countErrs = [];
  try {
    const siteId = await getSiteId();
    const locs = (typeof getLocations === 'function' ? getLocations() : ['Blake','Platte','Sherman','17th']);
    for (const loc of locs) {
      const slug = loc.replace(/[\s\/\\]/g, '_');
      const listName = `BSC_${slug}_MerchCounts`;
      try {
        const cntRows = await getCountHistoryForList(siteId, listName);
        const matches = cntRows.filter(r => loserNameSet.has((r.Title||'').trim().toLowerCase()));
        if (matches.length) countRefs[loc] = { listName, matches };
      } catch (e) {
        countErrs.push(`${loc}: ${e.message||e}`);
      }
    }
  } catch (e) {
    panel.innerHTML = `<span style="color:var(--red)">Preview failed: ${escHtml(e.message||e)}</span>`;
    return;
  }

  // Field fills — copy loser value into keeper only where keeper is blank.
  const copyFields = ['SquareCatalogItemId','CostPerUnit','SellingPrice','ItemNo','Category','Tags'];
  const fills = {};
  for (const f of copyFields) {
    const kv = (keeper[f] == null ? '' : String(keeper[f])).trim();
    if (kv) continue;
    for (const l of losers) {
      const lv = (l[f] == null ? '' : String(l[f])).trim();
      if (lv) { fills[f] = lv; break; }
    }
  }

  g.preview = { keeper, losers, keeperName, countRefs, fills };

  const totalCount = Object.values(countRefs).reduce((s,o) => s + o.matches.length, 0);
  const locBreakdown = Object.entries(countRefs)
    .map(([loc, o]) => `<strong>${o.matches.length}</strong> in ${escHtml(loc)}`)
    .join(' · ') || '<span style="color:var(--muted)">none</span>';

  const fillPairs = Object.entries(fills)
    .map(([k,v]) => `<code>${escHtml(k)}</code>=${escHtml(String(v).slice(0,40))}`)
    .join(', ') || '<span style="color:var(--muted)">nothing to copy</span>';

  panel.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px;">Merge plan</div>
    <div>Keeper: <strong>${escHtml(keeperName)}</strong> <span style="color:var(--muted)">· id ${escHtml(keeper.id)}</span></div>
    <div style="color:var(--muted);margin-top:2px;">Losers (${losers.length}): ${losers.map(l => escHtml(l.ItemName||l.Title||'')+` <span style="font-size:11px">(id ${escHtml(l.id)})</span>`).join(' · ')}</div>
    <div style="margin-top:8px;">📋 Count rows to retitle → keeper's name: ${locBreakdown} · <strong>${totalCount} total</strong></div>
    <div style="margin-top:4px;">➕ Keeper gains: ${fillPairs}</div>
    <div style="margin-top:4px;">📦 Losers will be archived (soft-delete — the Archived='yes' field is set, rows are recoverable via inventory form).</div>
    ${countErrs.length ? `<div style="margin-top:6px;color:var(--red);font-size:11px">⚠ Fetch errors: ${escHtml(countErrs.join('; '))}</div>` : ''}
    <div style="margin-top:8px;font-size:11px;color:var(--muted);">Review above, then click <strong>Confirm merge</strong>. Nothing is written until you confirm.</div>
  `;
  if (confirmBtn) confirmBtn.disabled = false;
}

// Execute the merge plan stored on _dedupGroups[gid].preview. Runs in three
// phases: retitle count rows, PATCH keeper with fills, archive losers. All
// phases batch 8 concurrent writes (same pattern as bulk count submit).
async function confirmDedupMerge(groupId) {
  const g = _dedupGroups[groupId];
  if (!g || !g.preview) {
    if (typeof toast === 'function') toast('err','Run Preview first');
    return;
  }
  const { keeper, losers, keeperName, countRefs, fills } = g.preview;
  const totalCount = Object.values(countRefs).reduce((s,o) => s + o.matches.length, 0);

  const msg = `Merge ${losers.length} row${losers.length>1?'s':''} into "${keeperName}"?\n\n` +
              `• ${totalCount} count row${totalCount!==1?'s':''} will be retitled\n` +
              `• Keeper will gain ${Object.keys(fills).length} field${Object.keys(fills).length!==1?'s':''}\n` +
              `• ${losers.length} row${losers.length>1?'s':''} will be archived\n\n` +
              `Losers are archived (reversible), not deleted.`;
  if (!confirm(msg)) return;

  const confirmBtn = document.getElementById(`confirm-btn-${groupId}`);
  if (confirmBtn) confirmBtn.disabled = true;
  if (typeof setLoading === 'function') setLoading(true, 'Merging…');

  try {
    // Phase 1 — retitle every matching count row to the keeper's name.
    let done = 0;
    for (const [loc, info] of Object.entries(countRefs)) {
      for (let i = 0; i < info.matches.length; i += 8) {
        const batch = info.matches.slice(i, i+8);
        await Promise.all(batch.map(r => updateListItem(info.listName, r.id, { Title: keeperName })));
        done += batch.length;
        if (typeof setLoading === 'function') setLoading(true, `Retitling count history ${done}/${totalCount}…`);
      }
    }

    // Phase 2 — copy missing fields onto the keeper.
    if (Object.keys(fills).length) {
      if (typeof setLoading === 'function') setLoading(true, 'Updating keeper…');
      await updateListItem(LISTS.merchInventory, keeper.id, fills);
      Object.assign(keeper, fills);  // mirror in cache
    }

    // Phase 3 — archive the losers.
    for (let i = 0; i < losers.length; i += 8) {
      if (typeof setLoading === 'function') setLoading(true, `Archiving losers ${Math.min(i+8, losers.length)}/${losers.length}…`);
      const batch = losers.slice(i, i+8);
      await Promise.all(batch.map(l => updateListItem(LISTS.merchInventory, l.id, { Archived: 'yes' })));
      batch.forEach(l => { l.Archived = 'yes'; });
    }

    if (typeof toast === 'function') {
      toast('ok', `✓ Merged ${losers.length+1} rows into "${keeperName}" · ${totalCount} count rows retitled`);
    }

    // Refresh dependent views. findMerchDuplicates filters Archived, so the
    // merged losers disappear from the scan; renderCogs picks up the new cache.
    if (typeof renderCogs === 'function') renderCogs();
    findMerchDuplicates();
  } catch (e) {
    if (typeof toast === 'function') toast('err', 'Merge failed: ' + (e.message||e));
    else alert('Merge failed: ' + (e.message||e));
    if (confirmBtn) confirmBtn.disabled = false;
  } finally {
    if (typeof setLoading === 'function') setLoading(false);
  }
}
