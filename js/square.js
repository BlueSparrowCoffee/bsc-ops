/* ================================================================
 * BSC Ops — square.js
 * Square integration: core API helper, settings, diagnostics, location
 * mapping, and the four sync flows (team, catalog, menu counts, merch
 * sales).
 *
 * Contents:
 *   - squareAPI(method, path, body) — proxied through /api/square/…
 *   - getSquareToken / getSquareLocMap / getSquareLocIds
 *   - bscNameToSquareLocId
 *   - saveSquareToken / toggleSqTokenVis
 *   - testSquareAPIs — diagnostic runner
 *   - renderSquareSettings / sqLog / renderSquarePage
 *   - testSquareConnection
 *   - loadSquareLocations / saveSquareLocationMap
 *   - syncSquareTeam / syncSquareCatalog / syncSquareInventory
 *   - pullMerchSalesFromSquare (called from merch count sheet)
 *
 * Depends on:
 *   state.js     — cache, currentUser, currentLocation
 *   constants.js — LISTS, CFG
 *   utils.js     — escHtml, toast
 *   auth.js      — getToken
 *   graph.js     — getSiteId, getListItems, addListItem, updateListItem, ensureList
 *   settings.js  — getSetting, saveSetting
 *   inventory.js — invCfg, _merchCountMonth (merch count state), menuCountsListName
 *   menu.js      — loadMenuData, renderMenu
 *   contacts/staff — renderStaff
 *   locations.js — getLocations
 * ================================================================ */

// ── Core API helper ───────────────────────────────────────────────────────
async function squareAPI(method, path, body) {
  const msalToken = await getToken();
  const res = await fetch(`/api/square/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${msalToken}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.errors?.[0]?.detail
      || (data?.reason ? `${data?.error}: ${data.reason}` : data?.error)
      || `Square error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ── Settings helpers ─────────────────────────────────────────────────────
function getSquareToken()      { return getSetting('square_token'); }
function getSquareLocMap()     { try { return JSON.parse(getSetting('square_loc_map')||'{}'); } catch { return {}; } }
// Map is stored as { squareId: bscName }. Helpers:
function getSquareLocIds()      { return Object.keys(getSquareLocMap()); }
function bscNameToSquareLocId(bscName) {
  const m = getSquareLocMap();
  return Object.entries(m).find(([, v]) => v === bscName)?.[0] || null;
}

async function saveSquareToken() {
  const val = document.getElementById('sq-token-input').value.trim();
  if (!val) { toast('err','Enter an access token'); return; }
  await saveSetting('square_token', val);
  document.getElementById('sq-token-status').textContent = '✓ Token saved';
  toast('ok','✓ Square token saved');
}

function toggleSqTokenVis() {
  const el = document.getElementById('sq-token-input');
  el.type = el.type === 'password' ? 'text' : 'password';
}

// Diagnostic — probes each major Square endpoint and reports status
async function testSquareAPIs() {
  const btn = document.getElementById('sq-test-btn');
  const log = document.getElementById('sq-test-log');
  btn.disabled = true; btn.textContent = 'Testing…';
  log.style.display = 'block';
  log.textContent = 'Running tests…\n';

  const locMap = getSquareLocMap();
  const firstLocId = getSquareLocIds()[0];
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24*60*60*1000);

  const tests = [
    { name: 'Locations (list)',   method: 'GET',  path: 'locations' },
    { name: 'Catalog (list)',     method: 'GET',  path: 'catalog/list?types=CATEGORY&limit=1' },
    { name: 'Team Members',       method: 'POST', path: 'team-members/search', body: { query: { filter: { status: 'ACTIVE' } }, limit: 1 } },
    { name: 'Inventory Counts',   method: 'POST', path: 'inventory/counts/batch-retrieve', body: { catalog_object_ids: [], location_ids: firstLocId ? [firstLocId] : [] } },
    { name: 'Orders (search) ←',  method: 'POST', path: 'orders/search', body: {
        location_ids: firstLocId ? [firstLocId] : [],
        query: { filter: {
          date_time_filter: { created_at: { start_at: yesterday.toISOString(), end_at: now.toISOString() } },
          state_filter: { states: ['COMPLETED'] }
        }},
        limit: 1
      }
    }
  ];

  const results = [];
  for (const t of tests) {
    try {
      const msalToken = await getToken();
      const res = await fetch(`/api/square/${t.path}`, {
        method: t.method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${msalToken}` },
        body: t.body ? JSON.stringify(t.body) : undefined
      });
      const text = await res.text();
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      const detail = res.ok
        ? 'OK'
        : (parsed?.errors?.[0]?.code ? `${parsed.errors[0].code}: ${parsed.errors[0].detail||''}` : (parsed?.error || text.slice(0,200)));
      results.push({ name: t.name, status: res.status, ok: res.ok, detail });
    } catch(e) {
      results.push({ name: t.name, status: 'ERR', ok: false, detail: e.message });
    }
  }

  // Render results
  const lines = [
    '═══ Square API Diagnostic ═══',
    `Locations configured: ${Object.keys(locMap).length}`,
    `Using loc ID: ${firstLocId || '(none!)'}`,
    '',
    ...results.map(r => `${r.ok ? '✓' : '✗'} [${r.status}] ${r.name} — ${r.detail}`),
    '',
  ];
  const ordersResult = results.find(r => r.name.includes('Orders'));
  const otherOk = results.filter(r => !r.name.includes('Orders')).every(r => r.ok);
  if (ordersResult && !ordersResult.ok && otherOk) {
    lines.push('→ Other Square APIs work but Orders does not.');
    lines.push('→ This is a token permissions issue. Your Square access token');
    lines.push('  does not have ORDERS_READ scope. Regenerate the token with');
    lines.push('  Orders permission enabled in the Square Developer Dashboard,');
    lines.push('  then update SQUARE_ACCESS_TOKEN in Azure Portal.');
  } else if (results.every(r => !r.ok)) {
    lines.push('→ All Square calls failing. Token is likely invalid/expired,');
    lines.push('  or SQUARE_ACCESS_TOKEN is not set in Azure env vars.');
  } else if (results.every(r => r.ok)) {
    lines.push('→ All good! Orders API is reachable. If bag sync is still failing,');
    lines.push('  it may be a location-mapping or date-range issue.');
  }

  log.textContent = lines.join('\n');
  btn.disabled = false; btn.textContent = '🔍 Test Square APIs';
}

function renderSquareSettings() {
  const input  = document.getElementById('sq-token-input');
  const status = document.getElementById('sq-token-status');
  if (!input) return;
  const val = getSquareToken();
  if (val) { input.value = val; status.textContent = '✓ Token saved'; }
}

function sqLog(logId, msg) {
  const el = document.getElementById(logId);
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML += msg + '<br>';
  el.scrollTop = el.scrollHeight;
}

function renderSquarePage() {
  const token = getSquareToken();
  const dot  = document.getElementById('sq-status-dot');
  const text = document.getElementById('sq-status-text');
  if (!dot || !text) return;
  if (token) {
    dot.style.background  = '#f0c040';
    text.textContent = 'Token configured — click Test Connection to verify';
  } else {
    dot.style.background  = '#ccc';
    text.textContent = 'Not connected — add your Square access token in Settings';
  }
  // Restore last-sync timestamps
  ['team','catalog','inv'].forEach(k => {
    const el = document.getElementById(`sq-${k}-last`);
    const ts = localStorage.getItem(`sq_last_${k}`);
    if (el && ts) el.textContent = `Last synced: ${new Date(ts).toLocaleString()}`;
  });
}

// ── Test connection ───────────────────────────────────────────────────────
async function testSquareConnection() {
  const dot  = document.getElementById('sq-status-dot');
  const text = document.getElementById('sq-status-text');
  dot.style.background = '#f0c040';
  text.textContent = 'Testing…';
  try {
    const data = await squareAPI('GET', 'locations');
    const count = data.locations?.length || 0;
    dot.style.background  = '#2d7a47';
    text.textContent = `Connected ✓ — ${count} location${count!==1?'s':''} found in Square`;
    toast('ok', `✓ Square connected — ${count} locations`);
  } catch(e) {
    dot.style.background  = '#9b2335';
    text.textContent = `Connection failed: ${e.message}`;
    toast('err', 'Square connection failed: ' + e.message);
  }
}

// ── Load & map locations ─────────────────────────────────────────────────
async function loadSquareLocations() {
  const btn = document.getElementById('sq-btn-locs');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const data   = await squareAPI('GET', 'locations');
    const locs   = data.locations || [];
    const bscLocs = getLocations();
    const saved  = getSquareLocMap();
    const el = document.getElementById('sq-locations-map');
    el.innerHTML = locs.map(l => `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:13px;flex-wrap:wrap">
        <span style="min-width:160px;color:var(--text)"><strong>${escHtml(l.name)}</strong><br><span style="font-size:11px;color:var(--muted)">${escHtml(l.id)}</span></span>
        <span style="color:var(--muted)">→</span>
        <select class="filter" style="flex:1;min-width:140px" id="sq-loc-map-${escHtml(l.id)}">
          <option value="">— skip —</option>
          ${bscLocs.map(b=>`<option value="${escHtml(b)}"${saved[l.id]===b?' selected':''}>${escHtml(b)}</option>`).join('')}
        </select>
      </div>`).join('');
    document.getElementById('sq-btn-save-locs').style.display = 'inline-flex';
    btn.textContent = 'Reload Locations';
  } catch(e) {
    toast('err', 'Failed to load locations: ' + e.message);
    btn.textContent = 'Load Square Locations';
  }
  btn.disabled = false;
}

async function saveSquareLocationMap() {
  const locs = await squareAPI('GET', 'locations');
  const map  = {};
  (locs.locations||[]).forEach(l => {
    const sel = document.getElementById(`sq-loc-map-${l.id}`);
    if (sel?.value) map[l.id] = sel.value;
  });
  await saveSetting('square_loc_map', JSON.stringify(map));
  toast('ok', '✓ Location mapping saved');
}

// ── Sync team members ────────────────────────────────────────────────────
async function syncSquareTeam() {
  const btn = document.getElementById('sq-btn-team');
  const logId = 'sq-log-team';
  btn.disabled = true; btn.textContent = 'Syncing…';
  document.getElementById(logId).innerHTML = '';
  try {
    sqLog(logId, 'Fetching team members from Square…');
    // Paginate through all team members
    let members = [], cursor = null;
    do {
      const body = { limit: 200, ...(cursor ? { cursor } : {}) };
      const data = await squareAPI('POST', 'team-members/search', body);
      members = members.concat(data.team_members || []);
      cursor = data.cursor || null;
    } while (cursor);

    sqLog(logId, `Found ${members.length} team members`);

    const siteId = await getSiteId();
    let created = 0, updated = 0, skipped = 0;
    const locMap = getSquareLocMap();
    const bscLocs = getLocations();

    for (const m of members) {
      if (m.status === 'INACTIVE') { skipped++; continue; }
      const name  = [m.given_name, m.family_name].filter(Boolean).join(' ') || m.id;
      const email = m.email_address || '';
      const phone = m.phone_number || '';
      // Determine location from assigned locations
      const assignedLocIds = m.assigned_locations?.location_ids || [];
      const bscLoc = assignedLocIds.map(id => locMap[id]).find(Boolean) || '';

      const existing = cache.staff.find(s => s.Email && s.Email.toLowerCase() === email.toLowerCase());
      const fields = { Title: name, Email: email, Phone: phone, Active: 'Yes', Location: bscLoc };

      if (existing) {
        await updateListItem(LISTS.staff, existing.id, fields);
        Object.assign(existing, fields);
        updated++;
        sqLog(logId, `  ↻ Updated: ${name}`);
      } else {
        const item = await addListItem(LISTS.staff, fields);
        cache.staff.push(item);
        created++;
        sqLog(logId, `  + Added: ${name}${bscLoc ? ' ('+bscLoc+')' : ''}`);
      }
    }

    sqLog(logId, `<br>✅ Done — ${created} added, ${updated} updated, ${skipped} inactive skipped`);
    localStorage.setItem('sq_last_team', new Date().toISOString());
    document.getElementById('sq-team-last').textContent = `Last synced: ${new Date().toLocaleString()}`;
    renderStaff();
    toast('ok', `✓ Team sync complete — ${created} added, ${updated} updated`);
  } catch(e) {
    sqLog(logId, `❌ Error: ${e.message}`);
    toast('err', 'Team sync failed: ' + e.message);
  }
  btn.disabled = false; btn.textContent = 'Sync Team Members';
}

// ── Sync catalog ─────────────────────────────────────────────────────────
async function syncSquareCatalog() {
  const btn = document.getElementById('sq-btn-catalog');
  const logId = 'sq-log-catalog';
  btn.disabled = true; btn.textContent = 'Syncing…';
  document.getElementById(logId).innerHTML = '';
  try {
    sqLog(logId, 'Fetching catalog from Square…');
    let objects = [], cursor = null;
    do {
      const params = `catalog/list?types=ITEM,CATEGORY${cursor ? '&cursor='+encodeURIComponent(cursor) : ''}`;
      const data = await squareAPI('GET', params);
      objects = objects.concat(data.objects || []);
      cursor = data.cursor || null;
    } while (cursor);

    // Build category ID → name map from CATEGORY objects
    const categories = {};
    const catObjects = objects.filter(o => o.type === 'CATEGORY' && !o.is_deleted);
    catObjects.forEach(c => {
      const name = c.category_data?.name;
      if (name) categories[c.id] = name;
    });

    const allItems = objects.filter(o => o.type === 'ITEM' && !o.is_deleted);
    const items    = allItems.filter(o => !o.item_data?.is_archived);
    const archived = allItems.filter(o =>  o.item_data?.is_archived);
    sqLog(logId, `Found ${items.length} active items, ${archived.length} archived, ${catObjects.length} categories`);

    if (catObjects.length) {
      sqLog(logId, `📂 Categories: ${catObjects.map(c => `"${categories[c.id]}"`).join(', ')}`);
    } else {
      sqLog(logId, `⚠️ No CATEGORY objects returned from Square`);
    }

    const siteId = await getSiteId();
    // Ensure BSC_Menu list exists
    await ensureList(LISTS.menu, [
      {name:'ItemName',text:{}},{name:'Category',text:{}},{name:'Description',text:{allowMultipleLines:true}},
      {name:'Price',number:{decimalPlaces:'automatic'}},{name:'Variations',text:{allowMultipleLines:true}},
      {name:'SquareId',text:{}},{name:'Hidden',text:{}}
    ]);
    const existing = await getListItems(siteId, LISTS.menu);
    const existMap = {};
    existing.forEach(i => { if (i.SquareId) existMap[i.SquareId] = i; });

    let created = 0, updated = 0, failed = 0;
    for (const item of items) {
      const d = item.item_data || {};
      const name = d.name || item.id;
      // Resolve category — try multiple Square API formats in order:
      // 1. categories[] array (newer API) — may have name embedded directly
      // 2. reporting_category (newest API)
      // 3. category_id (legacy)
      let cat = 'Uncategorized';
      const catArr = d.categories || [];
      if (catArr.length) {
        // Some newer API responses embed the name directly on the category object
        const embedded = catArr[0]?.name || catArr[0]?.category_data?.name;
        if (embedded) {
          cat = embedded;
        } else {
          const id = catArr[0]?.id || catArr[0];
          cat = (id && categories[id]) ? categories[id] : (cat);
        }
      } else if (d.reporting_category?.id) {
        const id = d.reporting_category.id;
        cat = categories[id] || d.reporting_category?.name || cat;
      } else if (d.category_id) {
        cat = categories[d.category_id] || cat;
      }
      const desc = d.description || '';
      // Build variations summary with prices
      const vars = (d.variations || []).map(v => {
        const vd = v.item_variation_data || {};
        const price = vd.price_money ? '$'+(vd.price_money.amount/100).toFixed(2) : 'market';
        return `${vd.name||'Regular'}: ${price}`;
      });
      const firstPrice = (d.variations||[])[0]?.item_variation_data?.price_money;
      const priceAmt = firstPrice ? firstPrice.amount / 100 : null;

      const fields = {
        Title: name, ItemName: name, Category: cat,
        Description: desc,
        Variations: vars.join('\n'),
        SquareId: item.id,
        ...(priceAmt != null ? { Price: priceAmt } : {})
        // Note: Hidden flag is intentionally NOT overwritten — preserved from existing record
      };

      // Skip-and-continue: one bad item shouldn't abort the whole sync.
      // graph() already retries 429/503/504 — anything throwing here is a
      // hard failure (400 invalid field, 403 perms, exhausted retries, etc).
      try {
        if (existMap[item.id]) {
          // Preserve Hidden flag — don't overwrite user's hide/show preference
          await updateListItem(LISTS.menu, existMap[item.id].id, fields);
          updated++;
          sqLog(logId, `  ↻ ${name} (${cat})`);
        } else {
          await addListItem(LISTS.menu, fields);
          created++;
          sqLog(logId, `  + ${name} (${cat})`);
        }
      } catch (e) {
        failed++;
        sqLog(logId, `  ✗ ${name} — ${e.message}`);
        console.warn(`[syncSquareCatalog] failed to write "${name}":`, e);
      }
    }

    // Auto-hide items that are now archived in Square
    let autoHidden = 0;
    for (const item of archived) {
      const existing = existMap[item.id];
      if (existing && existing.Hidden !== 'Yes') {
        try {
          await updateListItem(LISTS.menu, existing.id, { Hidden: 'Yes' });
          autoHidden++;
          sqLog(logId, `  👁 Hidden (archived in Square): ${item.item_data?.name || item.id}`);
        } catch (e) {
          failed++;
          sqLog(logId, `  ✗ Failed to hide ${item.item_data?.name || item.id} — ${e.message}`);
        }
      }
    }

    // Reload menu cache
    const sId = await getSiteId();
    cache.menu = await getListItems(sId, LISTS.menu).catch(()=>[]);
    renderMenu();

    const failSuffix = failed ? `, ⚠ ${failed} failed (see log above)` : '';
    sqLog(logId, `<br>${failed ? '⚠️' : '✅'} Done — ${created} added, ${updated} updated${autoHidden ? `, ${autoHidden} auto-hidden (archived in Square)` : ''}${failSuffix}`);
    localStorage.setItem('sq_last_catalog', new Date().toISOString());
    document.getElementById('sq-catalog-last').textContent = `Last synced: ${new Date().toLocaleString()}`;
    toast(failed ? 'err' : 'ok', `${failed ? '⚠' : '✓'} Catalog synced — ${created} added, ${updated} updated${failSuffix}`);
  } catch(e) {
    sqLog(logId, `❌ Error: ${e.message}`);
    toast('err', 'Catalog sync failed: ' + e.message);
  }
  btn.disabled = false; btn.textContent = 'Sync Catalog → Menu';
}

// ── Sync inventory counts ─────────────────────────────────────────────────
async function syncSquareInventory() {
  const btn = document.getElementById('sq-btn-inv');
  const logId = 'sq-log-inv';
  btn.disabled = true; btn.textContent = 'Syncing…';
  document.getElementById(logId).innerHTML = '';
  try {
    const locMap = getSquareLocMap();
    if (!Object.keys(locMap).length) {
      toast('err', 'Set up location mapping first (Location Mapping card)');
      btn.disabled = false; btn.textContent = 'Sync Inventory Counts';
      return;
    }

    sqLog(logId, 'Fetching catalog object IDs…');
    let objects = [], cursor = null;
    do {
      const params = `catalog/list?types=ITEM_VARIATION${cursor ? '&cursor='+encodeURIComponent(cursor) : ''}`;
      const data = await squareAPI('GET', params);
      objects = objects.concat(data.objects || []);
      cursor = data.cursor || null;
    } while (cursor);

    // Map variation ID → item name
    sqLog(logId, `Found ${objects.length} item variations`);
    const varNameMap = {};
    // Need parent item names — fetch items too
    let items = [], cur2 = null;
    do {
      const params = `catalog/list?types=ITEM${cur2 ? '&cursor='+encodeURIComponent(cur2) : ''}`;
      const data = await squareAPI('GET', params);
      items = items.concat(data.objects || []);
      cur2 = data.cursor || null;
    } while (cur2);

    const itemNames = {};
    items.forEach(i => { itemNames[i.id] = i.item_data?.name || i.id; });
    objects.forEach(v => {
      const parentName = itemNames[v.item_variation_data?.item_id];
      if (parentName) varNameMap[v.id] = parentName;
    });

    const catalogIds = objects.map(o => o.id);
    const squareLocIds = Object.keys(locMap);
    sqLog(logId, `Fetching counts for ${catalogIds.length} variations across ${squareLocIds.length} location(s)…`);

    // Batch retrieve in chunks of 100
    const counts = [];
    for (let i=0; i<catalogIds.length; i+=100) {
      const chunk = catalogIds.slice(i, i+100);
      const data = await squareAPI('POST', 'inventory/counts/batch-retrieve', {
        catalog_object_ids: chunk,
        location_ids: squareLocIds
      });
      counts.push(...(data.counts || []));
    }
    sqLog(logId, `Retrieved ${counts.length} count records`);

    // Group counts by Square location → BSC location name
    const byLoc = {};
    counts.forEach(c => {
      const bscLoc = locMap[c.location_id];
      if (!bscLoc) return;
      if (!byLoc[bscLoc]) byLoc[bscLoc] = {};
      const name = varNameMap[c.catalog_object_id];
      if (!name) return;
      // If multiple variations for same item, add quantities
      byLoc[bscLoc][name] = (byLoc[bscLoc][name] || 0) + parseFloat(c.quantity || 0);
    });

    const weekOf = new Date().toISOString().split('T')[0];
    const siteId = await getSiteId();
    const by = currentUser?.name || currentUser?.username || 'Square Sync';
    let totalRecords = 0;

    for (const [bscLoc, itemCounts] of Object.entries(byLoc)) {
      const cntList = menuCountsListName(bscLoc);
      if (!cntList) continue;
      // Ensure the MenuCounts list exists for this location
      await ensureList(cntList, [
        {name:'WeekOf',dateTime:{displayAs:'default',format:'dateOnly'}},
        {name:'Quantity',number:{decimalPlaces:'automatic'}},
        {name:'Location',text:{}},{name:'CountedBy',text:{}}
      ]);
      sqLog(logId, `Saving counts for <b>${bscLoc}</b> (${Object.keys(itemCounts).length} items)…`);
      for (const [itemName, qty] of Object.entries(itemCounts)) {
        await addListItem(cntList, {
          Title: itemName,
          WeekOf: weekOf + 'T00:00:00Z',
          Quantity: qty,
          Location: bscLoc,
          CountedBy: by
        });
        totalRecords++;
      }
    }

    // Reload menu counts
    await loadMenuData(siteId);
    renderMenu();

    sqLog(logId, `<br>✅ Done — ${totalRecords} count records saved across ${Object.keys(byLoc).length} location(s)`);
    localStorage.setItem('sq_last_inv', new Date().toISOString());
    document.getElementById('sq-inv-last').textContent = `Last synced: ${new Date().toLocaleString()}`;
    toast('ok', `✓ Menu counts synced — ${totalRecords} records`);
  } catch(e) {
    sqLog(logId, `❌ Error: ${e.message}`);
    toast('err', 'Menu counts sync failed: ' + e.message);
  }
  btn.disabled = false; btn.textContent = 'Sync Menu Counts';
}

// ── Merch sales pull ───────────────────────────────────────────────────────
// Called from the merch count sheet "Pull from Square" button.
async function pullMerchSalesFromSquare() {
  const btn = document.getElementById('merch-sq-btn');
  if (btn) { btn.disabled=true; btn.textContent='Pulling…'; }

  try {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() + _merchCountMonth, 1);
    const endD = new Date(now.getFullYear(), now.getMonth() + _merchCountMonth + 1, 0);
    const startAt = d.toISOString();
    const endAt   = new Date(endD.getFullYear(), endD.getMonth(), endD.getDate(), 23, 59, 59).toISOString();

    // Build catalog-id → item name map from merch cache
    const cfg = invCfg();
    const catalogMap = {}; // squareCatalogItemId → ItemName
    (cache[cfg.cacheKey]||[]).forEach(i => {
      if (i.SquareCatalogItemId) catalogMap[i.SquareCatalogItemId.trim()] = i.ItemName;
    });
    if (!Object.keys(catalogMap).length) {
      toast('warn','No Square Catalog IDs set on merch items — add them via Edit');
      return;
    }

    // Square Orders API — search orders for the location
    const loc = currentLocation;
    const squareLocId = bscNameToSquareLocId(loc);
    if (!squareLocId) { toast('err',`No Square location mapped for "${loc}"`); return; }

    let cursor = null, salesMap = {}; // itemName → qty sold
    do {
      const body = {
        location_ids: [squareLocId],
        query: { filter: { date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
          state_filter: { states: ['COMPLETED'] } } },
        ...(cursor ? { cursor } : {})
      };
      const resp = await squareAPI('POST', 'orders/search', body);
      (resp.orders||[]).forEach(order => {
        (order.line_items||[]).forEach(li => {
          const catId = li.catalog_object_id;
          if (!catId) return;
          const name = catalogMap[catId];
          if (!name) return;
          salesMap[name] = (salesMap[name]||0) + parseInt(li.quantity||0, 10);
        });
      });
      cursor = resp.cursor || null;
    } while (cursor);

    // Fill Sold inputs
    let filled = 0;
    document.querySelectorAll('.merch-count-row').forEach(row => {
      const name = row.dataset.name;
      if (salesMap[name] !== undefined) {
        row.querySelector('.merch-sold').value = salesMap[name];
        filled++;
      }
    });
    toast('ok', filled ? `✓ Pulled Square sales — ${filled} items updated` : 'No matching sales found for this period');
  } catch(e) { toast('err','Square pull failed: '+e.message); }
  finally { if (btn) { btn.disabled=false; btn.textContent='Populate Sales from Square'; } }
}
