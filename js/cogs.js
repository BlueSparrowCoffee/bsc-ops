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

function renderCogsOverviewChart(items, target) {
  const el = document.getElementById('cogs-overview-chart');
  if (!el) return;
  if (!items.length) { el.innerHTML = ''; return; }

  const W = 620, H = 300;
  const PAD_L = 48, PAD_R = 24, PAD_T = 24, PAD_B = 44;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const maxPrice = Math.max(...items.map(i => i.price), 1);
  const xCeil = Math.ceil(maxPrice * 1.15 / 5) * 5; // round up to nearest $5

  const xScale = p => PAD_L + (p / xCeil) * plotW;
  const yScale = m => PAD_T + plotH - (Math.min(100, Math.max(0, m)) / 100) * plotH;

  const dotColor = (m) => m >= target ? '#16a34a' : m >= target * 0.8 ? '#d97706' : '#dc2626';

  const svg = [];

  // Grid lines — Y (margin)
  [0, 25, 50, 75, 100].forEach(m => {
    const y = yScale(m);
    svg.push(`<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>`);
    svg.push(`<text x="${PAD_L - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="rgba(255,255,255,.4)">${m}%</text>`);
  });

  // Grid lines — X (price)
  const xStep = xCeil <= 10 ? 2 : xCeil <= 20 ? 5 : xCeil <= 50 ? 10 : 15;
  for (let p = 0; p <= xCeil; p += xStep) {
    const x = xScale(p);
    svg.push(`<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${PAD_T + plotH}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>`);
    svg.push(`<text x="${x}" y="${PAD_T + plotH + 14}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.4)">$${p}</text>`);
  }

  // Axis borders
  svg.push(`<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + plotH}" stroke="rgba(255,255,255,.15)" stroke-width="1"/>`);
  svg.push(`<line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - PAD_R}" y2="${PAD_T + plotH}" stroke="rgba(255,255,255,.15)" stroke-width="1"/>`);

  // Axis labels
  svg.push(`<text x="${PAD_L + plotW / 2}" y="${H - 4}" text-anchor="middle" font-size="11" fill="rgba(255,255,255,.45)">Selling Price ($)</text>`);
  svg.push(`<text transform="rotate(-90)" x="${-(PAD_T + plotH / 2)}" y="12" text-anchor="middle" font-size="11" fill="rgba(255,255,255,.45)">Margin %</text>`);

  // Target line
  const ty = yScale(target);
  svg.push(`<line x1="${PAD_L}" y1="${ty}" x2="${W - PAD_R}" y2="${ty}" stroke="#c8a951" stroke-width="1.5" stroke-dasharray="5,4" opacity=".8"/>`);
  svg.push(`<text x="${W - PAD_R - 2}" y="${ty - 4}" text-anchor="end" font-size="10" fill="#c8a951" opacity=".9">Target ${target}%</text>`);

  // Dots — draw in z-order: below-target first, then on-target
  const sorted = [...items].sort((a, b) => b.margin - a.margin);
  sorted.forEach(item => {
    const cx = xScale(item.price);
    const cy = yScale(item.margin);
    const col = dotColor(item.margin);
    const label = item.name + (item.variation ? ` · ${item.variation}` : '') + ` — ${item.margin.toFixed(1)}% @ $${item.price.toFixed(2)}`;
    svg.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="${col}" opacity="${item.isHidden ? '.3' : '.85'}" stroke="rgba(255,255,255,.2)" stroke-width="1">
      <title>${escHtml(label)}</title>
    </circle>`);
  });

  // Legend
  const legendY = H - 10;
  const legendItems = [
    { col: '#16a34a', label: `At target (≥${target}%)` },
    { col: '#d97706', label: `Near target (≥${Math.round(target * 0.8)}%)` },
    { col: '#dc2626', label: 'Below target' }
  ];
  let lx = PAD_L;
  legendItems.forEach(({ col, label }) => {
    svg.push(`<circle cx="${lx + 5}" cy="${legendY}" r="4" fill="${col}" opacity=".85"/>`);
    svg.push(`<text x="${lx + 13}" y="${legendY + 4}" font-size="10" fill="rgba(255,255,255,.5)">${escHtml(label)}</text>`);
    lx += label.length * 6.2 + 20;
  });

  el.innerHTML = `
    <div class="card" style="padding:16px 16px 12px;overflow-x:auto;">
      <div style="font-size:12px;font-weight:600;color:rgba(255,255,255,.6);margin-bottom:10px;letter-spacing:.5px;">MARGIN VS. PRICE</div>
      <svg width="${W}" height="${H}" style="display:block;min-width:${W}px;font-family:inherit;">
        ${svg.join('\n')}
      </svg>
    </div>`;
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
      if (i.Archived === 'Yes') return;  // drop archived items from overview chart, stats, and list
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
