/* ================================================================
 * BSC Ops — foodpars.js
 * Food-pars tab inside Inventory: per-item weekday pars for pastries
 * and sandwiches, per location. Data is split across:
 *   - BSC_FoodPars (master list: Title, Category, Price, SortOrder,
 *                   ExportName) — shared across locations
 *   - BSC_<Loc>_FoodPars (per-location: Title, Mon..Sun)
 *
 * getMergedFoodPars joins the two on Title (case-insensitive).
 * Drag-and-drop reorder writes SortOrder back to the master list.
 * openFoodParSync pulls the Square "Food" category so managers can
 * bulk-seed new items with zeroed pars.
 *
 * Depends on:
 *   - state.js (cache, currentLocation)
 *   - constants.js (FP_JS_DAY_MAP, FP_DAYS, FP_DAY_FULL,
 *     FP_PAR_LIST_COLS, LISTS, MODAL_FOCUS_DELAY_MS)
 *   - graph.js (ensureList, addListItem, updateListItem,
 *     deleteListItem)
 *   - utils.js (escHtml, toast, setLoading, openModal, closeModal)
 *   - index.html globals resolved at call time:
 *     isOwner, isManagerOrOwner, squareAPI, openPastryOrderSync
 * ================================================================ */

function foodParsListName(loc) {
  const l = loc || currentLocation;
  if (!l || l === 'all') return null;
  return 'BSC_' + l.replace(/[\s\/\\]/g, '_') + '_FoodPars';
}

function fpTodayKey() {
  return FP_JS_DAY_MAP[new Date().getDay()];
}

function getMergedFoodPars(category) {
  const valMap = {};
  for (const v of cache.foodParValues) {
    valMap[(v.Title || '').toLowerCase().trim()] = v;
  }
  return cache.foodPars
    .filter(p => p.Category === category)
    .map(master => {
      const locData = valMap[(master.Title || '').toLowerCase().trim()] || {};
      return {
        ...master,
        Mon: locData.Mon, Tue: locData.Tue, Wed: locData.Wed,
        Thu: locData.Thu, Fri: locData.Fri, Sat: locData.Sat, Sun: locData.Sun,
        _locId: locData.id || null
      };
    })
    .sort((a,b) => ((a.SortOrder||999) - (b.SortOrder||999)) || (a.Title||'').localeCompare(b.Title||''));
}

function renderFoodParsInTab(category) {
  const container = document.getElementById('inv-foodpars-content');
  if (!container) return;
  const todayKey = fpTodayKey();
  const todayIdx = FP_DAYS.indexOf(todayKey);
  const todayFull = FP_DAY_FULL[todayIdx] || todayKey;
  const label = category === 'pastries' ? 'Pastry' : 'Sandwich';

  // Prompt if no location selected
  if (currentLocation === 'all') {
    container.innerHTML = `
      <div class="card" style="text-align:center;padding:32px;">
        <div style="font-size:28px;margin-bottom:8px;">📍</div>
        <div style="font-weight:600;margin-bottom:4px;">Select a location</div>
        <div style="font-size:13px;color:var(--muted);">Pars are tracked per location. Choose Blake, Platte, Sherman, or 17th above.</div>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="toolbar" style="justify-content:flex-end;">
      ${isOwner() ? `<button class="btn btn-outline" onclick="openFoodParSync('${escHtml(category)}')">↓ Sync from Square</button>` : ''}
      ${category === 'pastries' && isManagerOrOwner() ? `<button class="btn btn-outline" onclick="openPastryOrderSync()">↑ Sync to Order Sheet</button>` : ''}
      <button class="btn btn-primary" onclick="openFoodParForm(null,'${escHtml(category)}')">+ Add ${escHtml(label)}</button>
    </div>
    <div id="fp-table-wrap"></div>
  `;
  renderFoodParsTable(category);
}

function renderFoodParsTable(category) {
  const wrap = document.getElementById('fp-table-wrap');
  if (!wrap) return;
  const todayKey = fpTodayKey();
  const rows = getMergedFoodPars(category);

  if (!rows.length) {
    wrap.innerHTML = `<div class="no-data" style="padding:32px 0">No items yet. Click "+ Add" to create your first par.</div>`;
    return;
  }

  const thToday = (day) => day === todayKey ? `style="background:var(--brand,#c8a951);"` : '';
  const tdToday = (day) => day === todayKey
    ? `style="text-align:center;font-weight:700;background:var(--brand-light,#fff8e7);color:var(--brand,#c8a951);"`
    : `style="text-align:center;"`;

  const thead = `<thead><tr>
    <th style="width:28px;"></th>
    <th>Item</th>
    <th style="text-align:right;">Price</th>
    ${FP_DAYS.map(d => `<th ${thToday(d)} style="text-align:center;${d===todayKey?'background:var(--brand,#c8a951);':''}">${d}</th>`).join('')}
    <th style="text-align:right;">Est. Weekly Rev</th>
    <th style="width:32px;"></th>
  </tr></thead>`;

  let totalRevenue = 0;
  const tbody = rows.map(p => {
    const price = parseFloat(p.Price) || 0;
    const weekTotal = FP_DAYS.reduce((sum, d) => sum + (parseFloat(p[d]) || 0), 0);
    const weekRev = price * weekTotal;
    totalRevenue += weekRev;
    const revCell = price > 0
      ? `<span style="color:#2e7d32;font-weight:600;">$${weekRev.toFixed(2)}</span>`
      : `<span style="color:var(--muted)">—</span>`;
    return `<tr data-id="${escHtml(p.id)}">
      <td class="fp-drag-handle" title="Drag to reorder" style="color:var(--muted);">⠿</td>
      <td style="font-weight:500;">${escHtml(p.Title||'')}</td>
      <td style="text-align:right;color:var(--muted);">${price > 0 ? '$'+price.toFixed(2) : '<span style="color:var(--muted)">—</span>'}</td>
      ${FP_DAYS.map(d => `<td ${tdToday(d)}>${p[d] != null && p[d] !== '' ? p[d] : '<span style="color:var(--muted)">—</span>'}</td>`).join('')}
      <td style="text-align:right;">${revCell}</td>
      <td style="text-align:center;">
        <button class="btn btn-sm" data-id="${escHtml(p.id)}" data-cat="${escHtml(category)}" onclick="openFoodParForm(this.dataset.id,this.dataset.cat)">Edit</button>
      </td>
    </tr>`;
  }).join('');

  const tfoot = `<tfoot><tr>
    <td colspan="3" style="padding:10px 14px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;">Weekly Total</td>
    <td colspan="${FP_DAYS.length}"></td>
    <td style="text-align:right;font-weight:700;font-size:14px;color:#2e7d32;padding:10px 14px;">$${totalRevenue.toFixed(2)}</td>
    <td></td>
  </tr></tfoot>`;

  wrap.innerHTML = `
    <div class="table-wrap">
      <table style="min-width:600px;">
        ${thead}<tbody id="fp-tbody">${tbody}</tbody>${tfoot}
      </table>
    </div>`;

  initFpDragDrop(category);
}

function initFpDragDrop(category) {
  const tbody = document.getElementById('fp-tbody');
  if (!tbody) return;
  let dragSrc = null;

  // Enable draggable only when mousedown is on the grip handle, so
  // clicking Edit / inputs never accidentally starts a drag.
  tbody.addEventListener('mousedown', e => {
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    row.draggable = !!e.target.closest('.fp-drag-handle');
  });

  tbody.addEventListener('dragstart', e => {
    dragSrc = e.target.closest('tr[data-id]');
    if (!dragSrc) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSrc.dataset.id);
    // Delay opacity so the drag ghost captures the full row first
    setTimeout(() => { if (dragSrc) dragSrc.style.opacity = '0.45'; }, 0);
  });

  tbody.addEventListener('dragend', () => {
    if (dragSrc) { dragSrc.style.opacity = ''; dragSrc.draggable = false; }
    tbody.querySelectorAll('tr.fp-drag-over').forEach(r => r.classList.remove('fp-drag-over'));
    dragSrc = null;
  });

  tbody.addEventListener('dragover', e => {
    e.preventDefault();
    const target = e.target.closest('tr[data-id]');
    if (!target || target === dragSrc) return;
    tbody.querySelectorAll('tr.fp-drag-over').forEach(r => r.classList.remove('fp-drag-over'));
    target.classList.add('fp-drag-over');
    e.dataTransfer.dropEffect = 'move';
  });

  tbody.addEventListener('drop', async e => {
    e.preventDefault();
    const target = e.target.closest('tr[data-id]');
    if (!target || target === dragSrc || !dragSrc) return;
    target.classList.remove('fp-drag-over');
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    after ? target.after(dragSrc) : target.before(dragSrc);
    await saveFpSortOrder(tbody, category);
  });
}

async function saveFpSortOrder(tbody, category) {
  const rows = [...tbody.querySelectorAll('tr[data-id]')];
  const updates = rows
    .map((row, idx) => ({ id: row.dataset.id, sort: idx + 1 }))
    .filter(({ id, sort }) => {
      const item = cache.foodPars.find(p => p.id === id);
      return item && item.SortOrder !== sort;
    });
  if (!updates.length) return;
  try {
    await Promise.all(updates.map(u => updateListItem(LISTS.foodPars, u.id, { SortOrder: u.sort })));
    updates.forEach(u => {
      const item = cache.foodPars.find(p => p.id === u.id);
      if (item) item.SortOrder = u.sort;
    });
    toast('ok', '✓ Order saved');
  } catch(e) { toast('err', 'Could not save order: ' + e.message); }
}

let _fpEditCategory = null;

function toggleFpAdvanced() {
  const panel  = document.getElementById('fp-advanced-panel');
  const arrow  = document.getElementById('fp-advanced-arrow');
  const open   = panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  arrow.textContent   = open ? '▾' : '▸';
}

function openFoodParForm(id, category) {
  _fpEditCategory = category || _fpEditCategory;
  const p = id ? getMergedFoodPars(_fpEditCategory).find(x => x.id === id) : null;
  const label = _fpEditCategory === 'pastries' ? 'Pastry' : 'Sandwich';

  document.getElementById('foodpar-modal-title').textContent = p ? `Edit ${label}` : `Add ${label}`;
  document.getElementById('fp-name').value        = p ? (p.Title || '') : '';
  document.getElementById('fp-price').value       = p && p.Price != null ? p.Price : '';
  document.getElementById('fp-edit-id').value     = p ? p.id : '';
  document.getElementById('fp-loc-id').value      = p ? (p._locId || '') : '';
  document.getElementById('fp-category').value    = _fpEditCategory;
  document.getElementById('fp-export-name').value = p ? (p.ExportName || '') : '';

  FP_DAYS.forEach(d => {
    const el = document.getElementById('fp-' + d.toLowerCase());
    if (el) el.value = (p && p[d] != null && p[d] !== '') ? p[d] : '';
  });

  // Auto-open Advanced panel if an export name is already set
  const hasExportName = !!(p?.ExportName);
  document.getElementById('fp-advanced-panel').style.display = hasExportName ? 'block' : 'none';
  document.getElementById('fp-advanced-arrow').textContent   = hasExportName ? '▾' : '▸';

  document.getElementById('fp-delete-btn').style.display = p ? 'inline-flex' : 'none';
  openModal('modal-foodpar');
  setTimeout(() => document.getElementById('fp-name')?.focus(), MODAL_FOCUS_DELAY_MS);
}

async function saveFoodParForm() {
  const name = document.getElementById('fp-name').value.trim();
  if (!name) { toast('err','Item name is required'); return; }
  const editId  = document.getElementById('fp-edit-id').value;
  const locId   = document.getElementById('fp-loc-id').value;
  const cat     = document.getElementById('fp-category').value;

  const priceVal    = parseFloat(document.getElementById('fp-price').value);
  const exportName  = document.getElementById('fp-export-name').value.trim();
  const masterData  = { Title: name, Category: cat, Price: isNaN(priceVal) ? null : priceVal, ExportName: exportName || null };
  const parData = { Title: name };
  FP_DAYS.forEach(d => {
    const val = document.getElementById('fp-' + d.toLowerCase())?.value;
    parData[d] = val !== '' && val != null ? Number(val) : null;
  });

  const locListName = foodParsListName(currentLocation);
  if (!locListName) { toast('err','Select a location first'); return; }

  setLoading(true, editId ? 'Saving…' : 'Adding…');
  try {
    await ensureList(LISTS.foodPars, [
      {name:'Category',text:{}},{name:'SortOrder',number:{decimalPlaces:'none'}},{name:'Price',number:{decimalPlaces:'automatic'}},{name:'ExportName',text:{}}
    ]);
    await ensureList(locListName, FP_PAR_LIST_COLS);

    // Save master item
    if (editId) {
      await updateListItem(LISTS.foodPars, editId, masterData);
      const idx = cache.foodPars.findIndex(x => x.id === editId);
      if (idx >= 0) cache.foodPars[idx] = { ...cache.foodPars[idx], ...masterData };
    } else {
      const item = await addListItem(LISTS.foodPars, masterData);
      cache.foodPars.push(item);
    }

    // Save per-location par values
    if (locId) {
      await updateListItem(locListName, locId, parData);
      const idx = cache.foodParValues.findIndex(x => x.id === locId);
      if (idx >= 0) cache.foodParValues[idx] = { ...cache.foodParValues[idx], ...parData };
    } else {
      const locItem = await addListItem(locListName, parData);
      cache.foodParValues.push(locItem);
    }

    closeModal('modal-foodpar');
    renderFoodParsInTab(cat);
    toast('ok', editId ? '✓ Item updated' : '✓ Item added');
  } catch(e) { toast('err', 'Save failed: ' + e.message); }
  finally { setLoading(false); }
}

async function deleteFoodPar() {
  const editId = document.getElementById('fp-edit-id').value;
  const locId  = document.getElementById('fp-loc-id').value;
  const cat    = document.getElementById('fp-category').value;
  if (!editId) return;
  if (!confirm('Delete this item and all its pars?')) return;
  setLoading(true, 'Deleting…');
  try {
    await deleteListItem(LISTS.foodPars, editId);
    cache.foodPars = cache.foodPars.filter(x => x.id !== editId);
    if (locId) {
      const locListName = foodParsListName(currentLocation);
      await deleteListItem(locListName, locId).catch(() => {});
      cache.foodParValues = cache.foodParValues.filter(x => x.id !== locId);
    }
    closeModal('modal-foodpar');
    renderFoodParsInTab(cat);
    toast('ok', '🗑 Item deleted');
  } catch(e) { toast('err', 'Delete failed: ' + e.message); }
  finally { setLoading(false); }
}

let _fpSyncCategory = null;
let _fpSyncItems    = []; // Square items available to import

async function openFoodParSync(category) {
  _fpSyncCategory = category;
  const label = category === 'pastries' ? 'Pastries' : 'Sandwiches';
  document.getElementById('fp-sync-title').textContent = `Sync ${label} from Square`;
  const body = document.getElementById('fp-sync-body');
  const importBtn = document.getElementById('fp-sync-import-btn');
  body.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px;">Fetching Square catalog…</div>';
  importBtn.style.display = 'none';
  openModal('modal-foodpar-sync');

  try {
    // Fetch catalog from Square
    let objects = [], cursor = null;
    do {
      const params = `catalog/list?types=ITEM,CATEGORY${cursor ? '&cursor='+encodeURIComponent(cursor) : ''}`;
      const data = await squareAPI('GET', params);
      objects = objects.concat(data.objects || []);
      cursor = data.cursor || null;
    } while (cursor);

    // Build category name map
    const catMap = {};
    objects.filter(o => o.type === 'CATEGORY' && !o.is_deleted).forEach(c => {
      catMap[c.id] = (c.category_data?.name || '').toLowerCase();
    });

    // Filter: Food category, non-archived, non-deleted
    const foodItems = objects.filter(o => {
      if (o.type !== 'ITEM' || o.is_deleted || o.item_data?.is_archived) return false;
      const d = o.item_data || {};
      const catId = (d.categories?.length > 0)
        ? (d.categories[0].id || d.categories[0])
        : (d.reporting_category?.id || d.category_id || null);
      const catName = catId ? catMap[catId] || '' : '';
      return catName === 'food';
    });

    // Find which names are already in this category's master list
    const existing = new Set(
      cache.foodPars
        .filter(p => p.Category === category)
        .map(p => (p.Title || '').toLowerCase().trim())
    );

    _fpSyncItems = foodItems
      .map(o => o.item_data?.name || '')
      .filter(n => n && !existing.has(n.toLowerCase().trim()))
      .sort();

    if (!_fpSyncItems.length) {
      body.innerHTML = `<div style="padding:16px;font-size:13px;color:var(--muted);">
        All Square Food items are already in your ${label} pars, or no Food items were found.
      </div>`;
      return;
    }

    body.innerHTML = `
      <div style="font-size:13px;color:var(--muted);padding:0 0 12px;">
        Select Square Food items to add to <b>${label}</b>. Pars will default to 0 — edit them after importing.
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <button class="btn btn-sm" style="font-size:11px;" onclick="fpSyncSelectAll(true)">Select all</button>
        <button class="btn btn-sm" style="font-size:11px;" onclick="fpSyncSelectAll(false)">Deselect all</button>
      </div>
      ${_fpSyncItems.map((name, i) => `
        <label style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px;">
          <input type="checkbox" id="fp-sync-cb-${i}" value="${escHtml(name)}" style="width:16px;height:16px;accent-color:var(--brand,#c8a951);">
          ${escHtml(name)}
        </label>`).join('')}`;

    importBtn.style.display = 'inline-flex';
    importBtn.textContent = 'Import Selected';
  } catch(e) {
    body.innerHTML = `<div style="padding:16px;font-size:13px;color:var(--red);">Failed to fetch Square catalog: ${escHtml(e.message)}</div>`;
  }
}

function fpSyncSelectAll(checked) {
  _fpSyncItems.forEach((_, i) => {
    const cb = document.getElementById(`fp-sync-cb-${i}`);
    if (cb) cb.checked = checked;
  });
}

async function importSelectedFoodPars() {
  const selected = _fpSyncItems.filter((_, i) => {
    const cb = document.getElementById(`fp-sync-cb-${i}`);
    return cb?.checked;
  });
  if (!selected.length) { toast('warn', 'Select at least one item'); return; }

  const btn = document.getElementById('fp-sync-import-btn');
  btn.disabled = true; btn.textContent = 'Importing…';
  const locListName = foodParsListName(currentLocation);
  if (!locListName) { toast('err','Select a location first'); return; }
  try {
    await ensureList(LISTS.foodPars, [
      {name:'Category',text:{}},{name:'SortOrder',number:{decimalPlaces:'none'}},{name:'Price',number:{decimalPlaces:'automatic'}},{name:'ExportName',text:{}}
    ]);
    await ensureList(locListName, FP_PAR_LIST_COLS);
    for (const name of selected) {
      // Add to master list
      const masterItem = await addListItem(LISTS.foodPars, {
        Title: name, Category: _fpSyncCategory
      });
      cache.foodPars.push(masterItem);
      // Add to per-location par list with zeroes
      const locItem = await addListItem(locListName, {
        Title: name, Mon:0, Tue:0, Wed:0, Thu:0, Fri:0, Sat:0, Sun:0
      });
      cache.foodParValues.push(locItem);
    }
    closeModal('modal-foodpar-sync');
    renderFoodParsInTab(_fpSyncCategory);
    toast('ok', `✓ Imported ${selected.length} item${selected.length > 1 ? 's' : ''} — set your pars below`);
  } catch(e) {
    toast('err', 'Import failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Import Selected';
  }
}
