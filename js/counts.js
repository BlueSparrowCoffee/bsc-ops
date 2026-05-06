/* ================================================================
 * BSC Ops — counts.js
 * Weekly (consumable) and monthly (merch) count-sheet rendering and
 * submission. This file owns ALL writes to the BSC_Counts_* lists —
 * SignalR and updateCountTotal never write, they only re-render.
 *
 * Counts are always written against a specific location (not "all").
 * Every submit also upserts BSC_LastCount so the dashboard can show
 * "last submitted" per invType:location.
 *
 * Depends on:
 *   - state.js (cache, currentLocation, currentUser)
 *   - constants.js (LISTS)
 *   - graph.js (addListItem, updateListItem)
 *   - utils.js (escHtml, toast, setLoading)
 *   - inventory.js (invCfg)
 *   - dashboard.js (renderDashboard)
 *   - index.html globals resolved at call time:
 *     sendSlackAlert
 * ================================================================ */

// ── Autosave drafts ───────────────────────────────────────────────
// Counts are saved to localStorage on every input change so a browser
// crash, accidental reload, or lost session does not destroy in-progress
// work. Drafts are keyed by inventory type + location (+ month for
// merch) and cleared on successful submit or explicit Clear click.
function _countAutosaveKey(cfg, loc, monthStr) {
  const base = `bsc_autosave_count_${cfg.cacheKey}_${loc}`;
  return monthStr ? `${base}_${monthStr}` : base;
}

function saveCountDraft(rowSelector, cfg, loc, monthStr) {
  try {
    const data = {};
    document.querySelectorAll(rowSelector).forEach(row => {
      const id = row.dataset.id;
      if (!id) return;
      const storeEl   = row.querySelector('.count-store, .merch-store');
      const storageEl = row.querySelector('.count-storage, .merch-storage');
      // When the count sheet is split into a single-view mode (consumable
      // Store/Storage toggle), the inactive column isn't in the DOM but
      // its last-known value is stashed on the row's data-store /
      // data-storage attribute. Persist whichever is present.
      const store   = storeEl   ? storeEl.value   : (row.dataset.store   ?? '');
      const storage = storageEl ? storageEl.value : (row.dataset.storage ?? '');
      if (store !== '' || storage !== '') {
        const rec = {};
        if (store   !== '') rec.store   = store;
        if (storage !== '') rec.storage = storage;
        data[id] = rec;
      }
    });
    const key = _countAutosaveKey(cfg, loc, monthStr);
    if (!Object.keys(data).length) { localStorage.removeItem(key); return; }
    localStorage.setItem(key, JSON.stringify({savedAt: Date.now(), data}));
    _showDraftSaved();
  } catch(e) { /* quota or disabled — ignore */ }
}

function restoreCountDraft(rowSelector, cfg, loc, monthStr, updateTotalFn) {
  try {
    const raw = localStorage.getItem(_countAutosaveKey(cfg, loc, monthStr));
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    const data = (parsed && parsed.data) || {};
    let restored = 0;
    document.querySelectorAll(rowSelector).forEach(row => {
      const rec = data[row.dataset.id];
      if (!rec) return;
      const storeEl   = row.querySelector('.count-store, .merch-store');
      const storageEl = row.querySelector('.count-storage, .merch-storage');
      if (storeEl   && rec.store   != null) { storeEl.value   = rec.store;   restored++; }
      else if (rec.store   != null) { row.dataset.store   = rec.store; }   // hidden view → stash on row
      if (storageEl && rec.storage != null) { storageEl.value = rec.storage; restored++; }
      else if (rec.storage != null) { row.dataset.storage = rec.storage; }
      if (typeof updateTotalFn === 'function' && (storeEl || storageEl)) {
        updateTotalFn(storeEl || storageEl);
      }
    });
    return restored;
  } catch { return 0; }
}

function clearCountDraft(cfg, loc, monthStr) {
  try { localStorage.removeItem(_countAutosaveKey(cfg, loc, monthStr)); } catch {}
}

let _draftSavedHideTimer = null;
function _showDraftSaved() {
  const el = document.getElementById('count-draft-indicator');
  if (!el) return;
  const ts = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  el.textContent = `💾 Draft saved · ${ts}`;
  el.style.opacity = '1';
  clearTimeout(_draftSavedHideTimer);
  _draftSavedHideTimer = setTimeout(() => { el.style.opacity = '.55'; }, 1500);
}

let _draftSaveDebounceTimer = null;
function _autosaveCountDebounced(fn) {
  clearTimeout(_draftSaveDebounceTimer);
  _draftSaveDebounceTimer = setTimeout(fn, 400);
}

// "(1,000 ct.)" — per-case pack size pulled from OrderSize. Returns
// "" when the item has no OrderSize.
function _caseSizeLabel(item) {
  const orderSize = (item.OrderSize != null && String(item.OrderSize) !== '') ? Number(item.OrderSize) : 0;
  if (!orderSize) return '';
  return ` (${orderSize.toLocaleString()} ct.)`;
}

function _currentMerchMonthStr() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + (_merchCountMonth||0), 1);
  return d.toISOString().slice(0,7); // YYYY-MM
}

// ── Count Sheet (consumable, weekly) ──────────────────────────────
// Split-view state: the count entry form shows EITHER the Store column
// OR the Storage column at a time, never both. This matches the
// physical workflow (count one room, then the other). The hidden
// column's value still rides through via data-attr + the persisted
// draft, so totals stay correct and Submit writes both to one record.
let _consumableCountView = (typeof localStorage !== 'undefined' && localStorage.getItem('bsc_count_view') === 'storage') ? 'storage' : 'store';

function setConsumableCountView(view) {
  if (view !== 'store' && view !== 'storage') return;
  if (view === _consumableCountView) return;
  // Persist whatever's typed in the active view before flipping. Merch
  // and consumable use different row-class selectors and different
  // monthStr keys, so save against the active one.
  const cfg = invCfg();
  if (cfg && currentLocation !== 'all') {
    if (cfg.isMerch) saveCountDraft('.merch-count-row', cfg, currentLocation, _currentMerchMonthStr());
    else             saveCountDraft('.count-row',       cfg, currentLocation, null);
  }
  _consumableCountView = view;
  try { localStorage.setItem('bsc_count_view', view); } catch {}
  if (cfg && cfg.isMerch) { if (typeof renderMerchCountSheet === 'function') renderMerchCountSheet(); }
  else                    { if (typeof renderCountSheet      === 'function') renderCountSheet(); }
}

// ── Per-location custom item order (any inv-type) ────────────────
// Stored in BSC_Settings. Consumable + equipment counts split into
// Store and Storage views, so each has its own saved order:
//   <cacheKey>_order_<Location>_store
//   <cacheKey>_order_<Location>_storage
// Merch has no view split:
//   <cacheKey>_order_<Location>
// Items not in the saved array fall through to alphabetical at the end.
// _getCountOrder also falls back to the legacy view-less key so any
// orders saved before the split-view change still apply.
function _countOrderKey(cacheKey, loc, view) {
  const base = cacheKey + '_order_' + loc;
  return view ? base + '_' + view : base;
}
function _getCountOrder(cacheKey, loc, view) {
  if (!cacheKey || !loc || loc === 'all') return null;
  const get = (k) => (typeof getSetting === 'function') ? getSetting(k) : '';
  let raw = get(_countOrderKey(cacheKey, loc, view));
  // Legacy fallback: pre-split orders were stored without a view suffix.
  if (!raw && view) raw = get(_countOrderKey(cacheKey, loc, null));
  if (!raw) return null;
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : null; }
  catch { return null; }
}

// All count sheets (consumable, equipment, merch) split into Store /
// Storage passes — share a single view state so the user's choice
// follows them across inv-types in one session.
function _activeCountView(cfg) {
  if (!cfg) return null;
  return (typeof _consumableCountView !== 'undefined') ? _consumableCountView : null;
}

// Apply a saved order in-place to an items array (sorts custom-ordered
// ids first, then everything else alphabetically by ItemName).
function _applyCountOrder(items, orderArr) {
  if (orderArr && orderArr.length) {
    const idx = {};
    orderArr.forEach((id, i) => { idx[String(id)] = i; });
    items.sort((a, b) => {
      const ai = idx[String(a.id)];
      const bi = idx[String(b.id)];
      if (ai != null && bi != null) return ai - bi;
      if (ai != null) return -1;
      if (bi != null) return 1;
      return (a.ItemName||'').localeCompare(b.ItemName||'');
    });
  } else {
    items.sort((a, b) => (a.ItemName||'').localeCompare(b.ItemName||''));
  }
  return items;
}

function openCountOrderModal() {
  if (typeof isManagerOrOwner === 'function' && !isManagerOrOwner()) {
    toast('err','Manager or owner access required'); return;
  }
  if (currentLocation === 'all') { toast('err','Pick a specific location first'); return; }
  const cfg = invCfg();
  if (!cfg) return;
  _renderCountOrderList();
  openModal('modal-count-order');
}

function _renderCountOrderList() {
  const tbody = document.getElementById('cco-list');
  if (!tbody) return;
  const cfg = invCfg();
  if (!cfg) return;
  const view = _activeCountView(cfg);
  const items = (cache[cfg.cacheKey]||[]).filter(i => !i.Archived);
  const orderArr = _getCountOrder(cfg.cacheKey, currentLocation, view);
  _applyCountOrder(items, orderArr);
  const viewLabel = view ? ' · ' + (view === 'store' ? '📦 Store' : '🗄️ Storage') : '';
  document.getElementById('cco-location-label').textContent = currentLocation + viewLabel + ' · ' + (cfg.label || cfg.cacheKey);
  document.getElementById('cco-saved-flag').textContent = (orderArr && orderArr.length) ? 'Custom order in use' : 'Alphabetical (no custom order saved yet)';
  // Vendor column is meaningful for consumable; for merch/equipment
  // most rows have no Supplier, so suppress the column entirely.
  const showVendor = !cfg.isMerch && cfg.cacheKey !== 'equipInventory';
  tbody.innerHTML = items.map(it => `
    <tr data-id="${escHtml(String(it.id))}" style="border-bottom:1px solid var(--border);">
      <td class="fp-drag-handle" title="Drag to reorder">⠿</td>
      <td style="padding:8px 12px;font-size:13px;font-weight:500;">${escHtml(it.ItemName||'—')}</td>
      ${showVendor ? `<td style="padding:8px 12px;font-size:11px;color:var(--muted);">${escHtml(it.Supplier||'')}</td>` : ''}
    </tr>`).join('');
  _wireCountOrderDrag();
}

function _wireCountOrderDrag() {
  const tbody = document.getElementById('cco-list');
  if (!tbody || tbody._dragWired) return;
  tbody._dragWired = true;

  function _flagUnsaved() {
    const f = document.getElementById('cco-saved-flag');
    if (f) f.textContent = 'Unsaved changes — click Save Order to apply';
  }
  function _clearOver() {
    tbody.querySelectorAll('tr.fp-drag-over').forEach(r => r.classList.remove('fp-drag-over'));
  }

  // ── Mouse / desktop HTML5 drag-and-drop ─────────────────────────
  let dragSrc = null;
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
    setTimeout(() => { if (dragSrc) dragSrc.style.opacity = '0.45'; }, 0);
  });
  tbody.addEventListener('dragend', () => {
    if (dragSrc) { dragSrc.style.opacity = ''; dragSrc.draggable = false; }
    _clearOver();
    dragSrc = null;
  });
  tbody.addEventListener('dragover', e => {
    e.preventDefault();
    const target = e.target.closest('tr[data-id]');
    if (!target || target === dragSrc) return;
    _clearOver();
    target.classList.add('fp-drag-over');
    e.dataTransfer.dropEffect = 'move';
  });
  tbody.addEventListener('drop', e => {
    e.preventDefault();
    const target = e.target.closest('tr[data-id]');
    if (!target || target === dragSrc || !dragSrc) return;
    target.classList.remove('fp-drag-over');
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    after ? target.after(dragSrc) : target.before(dragSrc);
    _flagUnsaved();
  });

  // ── Touch parity (iOS / iPadOS) ─────────────────────────────────
  // HTML5 dragstart never fires on touch, so we wire a parallel handler
  // that uses elementFromPoint to track the hovered row and reorders on
  // touchend. Auto-scrolls the modal body when the finger nears the
  // top/bottom edge so long lists are reachable.
  let touchSrc = null;
  let lastOver = null;
  let scrollTimer = null;
  function _autoScroll(touch) {
    const wrap = tbody.closest('div[style*="overflow-y:auto"]');
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const EDGE = 36;
    let dy = 0;
    if (touch.clientY < r.top + EDGE)        dy = -8;
    else if (touch.clientY > r.bottom - EDGE) dy =  8;
    if (dy && !scrollTimer) {
      scrollTimer = setInterval(() => { wrap.scrollTop += dy; }, 16);
    } else if (!dy && scrollTimer) {
      clearInterval(scrollTimer); scrollTimer = null;
    }
  }
  function _stopScroll() {
    if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = null; }
  }

  tbody.addEventListener('touchstart', e => {
    const handle = e.target.closest('.fp-drag-handle');
    if (!handle) return; // touches outside the handle still scroll the list
    const row = handle.closest('tr[data-id]');
    if (!row) return;
    e.preventDefault(); // claim the gesture
    touchSrc = row;
    row.style.opacity = '0.45';
  }, { passive: false });

  tbody.addEventListener('touchmove', e => {
    if (!touchSrc) return;
    e.preventDefault();
    const t = e.touches[0];
    if (!t) return;
    _autoScroll(t);
    // Find row under finger via hit-testing (works through pointer-events)
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const target = el ? el.closest('tr[data-id]') : null;
    if (!target || target === touchSrc) return;
    if (lastOver && lastOver !== target) lastOver.classList.remove('fp-drag-over');
    target.classList.add('fp-drag-over');
    lastOver = target;
  }, { passive: false });

  function _touchEnd(e) {
    _stopScroll();
    if (touchSrc && lastOver && lastOver !== touchSrc) {
      const t = e.changedTouches && e.changedTouches[0];
      const rect = lastOver.getBoundingClientRect();
      const after = t ? (t.clientY > rect.top + rect.height / 2) : true;
      after ? lastOver.after(touchSrc) : lastOver.before(touchSrc);
      _flagUnsaved();
    }
    if (touchSrc) touchSrc.style.opacity = '';
    if (lastOver) lastOver.classList.remove('fp-drag-over');
    _clearOver();
    touchSrc = null;
    lastOver  = null;
  }
  tbody.addEventListener('touchend',    _touchEnd);
  tbody.addEventListener('touchcancel', _touchEnd);
}

// Re-renders whichever count sheet matches the active inv-type after
// an order save/reset.
function _rerenderActiveCountSheet() {
  const cfg = invCfg();
  if (!cfg) return;
  if (cfg.isMerch) { if (typeof renderMerchCountSheet === 'function') renderMerchCountSheet(); }
  else             { if (typeof renderCountSheet      === 'function') renderCountSheet(); }
}

async function saveCountOrder() {
  if (typeof isManagerOrOwner === 'function' && !isManagerOrOwner()) return;
  if (currentLocation === 'all') return;
  const cfg = invCfg();
  if (!cfg) return;
  const view = _activeCountView(cfg);
  const ids = [...document.querySelectorAll('#cco-list tr[data-id]')].map(r => r.dataset.id);
  if (!ids.length) { toast('err','Nothing to save'); return; }
  const btn = document.getElementById('cco-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await saveSetting(_countOrderKey(cfg.cacheKey, currentLocation, view), JSON.stringify(ids));
    const viewLabel = view ? ' (' + view + ')' : '';
    toast('ok','✓ Order saved for ' + currentLocation + viewLabel);
    closeModal('modal-count-order');
    _rerenderActiveCountSheet();
  } catch (e) { toast('err','Save failed: ' + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Save Order'; } }
}

async function resetCountOrder() {
  if (typeof isManagerOrOwner === 'function' && !isManagerOrOwner()) return;
  if (currentLocation === 'all') return;
  const cfg = invCfg();
  if (!cfg) return;
  const view = _activeCountView(cfg);
  const viewLabel = view ? ` ${view}` : '';
  if (!await confirmModal({ title: 'Reset sort order?', body: `Reset to alphabetical order for ${currentLocation}${viewLabel} (${cfg.label || cfg.cacheKey}).`, confirmLabel: 'Reset' })) return;
  try {
    await saveSetting(_countOrderKey(cfg.cacheKey, currentLocation, view), '');
    toast('ok','✓ Reset to alphabetical');
    closeModal('modal-count-order');
    _rerenderActiveCountSheet();
  } catch (e) { toast('err','Reset failed: ' + e.message); }
}

// Renders the Store/Storage toggle pills + flips the toolbar primary
// button between "Save & Start Storage Count" (in store view) and
// "Submit Count" (in storage view).
function _renderConsumableViewToggle() {
  const view = _consumableCountView;
  const pill = (val, label, emoji) => {
    const active = view === val;
    const bg = active ? 'var(--dark-blue)' : 'transparent';
    const fg = active ? '#fff' : 'var(--muted)';
    const border = active ? 'var(--dark-blue)' : 'var(--border)';
    return `<button onclick="setConsumableCountView('${val}')" style="padding:5px 14px;font-size:12px;font-weight:600;background:${bg};color:${fg};border:1.5px solid ${border};border-radius:14px;cursor:pointer;">${emoji} ${label}</button>`;
  };
  const html = pill('store','Store','📦') + pill('storage','Storage','🗄️');
  // Same pills are mounted in two places — the consumable toolbar and
  // the merch toolbar. Populate both whichever exists.
  const tog1 = document.getElementById('count-view-toggle');
  if (tog1) tog1.innerHTML = html;
  const tog2 = document.getElementById('merch-view-toggle');
  if (tog2) tog2.innerHTML = html;
}

function renderCountSheet() {
  // Show warning if no specific location is selected
  const container = document.getElementById('count-sheet-body');
  if (currentLocation === 'all') {
    container.innerHTML = `
      <div style="background:var(--warning);border:1.5px solid var(--orange);border-radius:12px;padding:20px 24px;margin-top:12px;text-align:center">
        <div style="font-size:22px;margin-bottom:8px">📍</div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px">Select a location to enter counts</div>
        <div style="font-size:13px;color:var(--muted)">Use the location buttons at the top to choose Sherman, Blake, or Platte before entering weekly counts.</div>
      </div>`;
    return;
  }

  // submitWeeklyCount reads the clock directly at submit time, so we don't
  // need any visible "now" display here.

  // show last submitted count for this location
  const cfg = invCfg();
  const _lastCountEl = document.getElementById('count-last-submitted');
  if (_lastCountEl && cfg) {
    const loc0 = currentLocation === 'all' ? null : currentLocation;
    const lcRec = loc0 ? cache.lastCount.find(r => r.Title === cfg.listKey + ':' + loc0) : null;
    if (lcRec?.CountedAt) {
      const d = new Date(lcRec.CountedAt);
      const fmt = d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'}) + ' · ' + d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      _lastCountEl.textContent = fmt + (lcRec.CountedBy ? ' · ' + lcRec.CountedBy : '');
      _lastCountEl.closest('.count-last-wrap').style.display = '';
    } else {
      _lastCountEl.closest('.count-last-wrap').style.display = 'none';
    }
  }

  // find most recent count records for current location
  if (!cfg) return;
  const loc = currentLocation === 'all' ? null : currentLocation;
  const recentMap = {}; // itemName → { store, storage, total, weekOf }
  const filtered = (cache[cfg.countKey] || []).filter(r => !loc || !r.Location || r.Location === loc);
  filtered.sort((a,b)=>{
    const wDiff = (a.WeekOf||'') < (b.WeekOf||'') ? -1 : (a.WeekOf||'') > (b.WeekOf||'') ? 1 : 0;
    return wDiff !== 0 ? wDiff : Number(a.id||0) - Number(b.id||0); // tiebreak by SP item id (higher = newer)
  });
  filtered.forEach(r => {
    const name = r.Title || r.ItemName;
    if (name) recentMap[name] = {
      store: r.StoreCount||0, storage: r.StorageCount||0,
      total: r.TotalCount||0,
      weekOf: r.WeekOf?.split('T')[0],
      countedBy: r.CountedBy||''
    };
  });

  // Flat list with an optional per-(location, view) custom order
  // (saved as `<cacheKey>_order_<Location>_<view>`). Items not in
  // the saved array fall through to alphabetical at the end.
  const items = (cache[cfg.cacheKey] || []).filter(i => !i.Archived);
  _applyCountOrder(items, _getCountOrder(cfg.cacheKey, currentLocation, _activeCountView(cfg)));

  // Render Store/Storage toggle pills + adjust the primary/secondary
  // action buttons in the toolbar based on the active view.
  _renderConsumableViewToggle();

  const view = _consumableCountView;
  const visibleColLabel = view === 'store' ? 'Store' : 'Storage';

  container.innerHTML = `<div class="count-cat-section">${items.map(item => {
    const last = recentMap[item.ItemName];
    const unit = item.OrderUnit || item.Unit || '';
    const _par = (typeof getItemPar === 'function') ? (getItemPar(item, currentLocation) ?? 0) : (item.ParLevel||0);
    // Pre-fill the active column from last submitted value; the inactive
    // column's last value rides on the row as a data attribute so
    // updateCountTotal can still sum store + storage.
    const lastStore   = last ? last.store   : '';
    const lastStorage = last ? last.storage : '';
    const visibleVal = view === 'store' ? lastStore : lastStorage;
    const otherDataAttr = view === 'store'
      ? `data-storage="${lastStorage === '' ? '' : lastStorage}"`
      : `data-store="${lastStore === '' ? '' : lastStore}"`;
    const inputClass = view === 'store' ? 'count-store' : 'count-storage';
    const target     = view === 'store' ? 'store' : 'storage';
    return `<div class="count-row" data-id="${item.id}" data-name="${(item.ItemName||'').replace(/"/g,'&quot;')}" ${otherDataAttr}>
      <div style="flex:1;min-width:160px">
        <div class="count-item-name">${item.ItemName||'—'}</div>
        <div class="count-item-meta">par ${_par} ${unit}${_caseSizeLabel(item)}</div>
      </div>
      <div class="count-input-group">
        <label>${visibleColLabel}</label>
        <input type="number" class="count-num-input ${inputClass}" min="0" step="0.1"
          oninput="updateCountTotal(this)" placeholder="0" value="${visibleVal}">
      </div>
      <div class="count-pm-group">
        <button class="count-pm-btn" onclick="countPlusOne(this, '${target}')" title="+1 to ${target}">+1</button>
        <button class="count-pm-btn" onclick="countPlusOne(this, '${target}', -1)" title="-1 to ${target}">−1</button>
      </div>
      <div class="count-total-box">
        <label>Total</label>
        <div class="count-total-val" id="count-total-${item.id}">${last != null ? last.total : '—'}</div>
      </div>
    </div>`;
  }).join('')}</div>`;

  // Restore any saved-but-unsubmitted draft for this location
  const _cfg = invCfg();
  if (_cfg && currentLocation !== 'all') {
    const n = restoreCountDraft('.count-row', _cfg, currentLocation, null, updateCountTotal);
    if (n > 0) {
      toast('ok', `↺ Restored ${n} draft value${n===1?'':'s'} — submit to commit`);
      _showDraftSaved();
    }
  }
  _refreshCountProgress();
}

// Updates the live "X of Y counted · Z below par" stat in the sticky
// count header. Called from updateCountTotal on every input. Cheap —
// just reads existing DOM nodes.
function _refreshCountProgress() {
  const prog = document.getElementById('count-submit-progress');
  if (!prog) return;
  // Don't override the "Saving N records…" message during submit.
  if (prog.dataset.busy === '1') return;
  const rows = document.querySelectorAll('#inv-tab-count .count-row');
  if (!rows.length) { prog.innerHTML = ''; return; }
  let counted = 0, belowPar = 0;
  const cfg = (typeof invCfg === 'function') ? invCfg() : null;
  const loc = (typeof currentLocation !== 'undefined') ? currentLocation : null;
  rows.forEach(row => {
    const id = row.dataset.id;
    const storeEl   = row.querySelector('.count-store');
    const storageEl = row.querySelector('.count-storage');
    const store   = storeEl   ? (parseFloat(storeEl.value)  ||0) : (parseFloat(row.dataset.store)  ||0);
    const storage = storageEl ? (parseFloat(storageEl.value)||0) : (parseFloat(row.dataset.storage)||0);
    const hasInput = (storeEl && storeEl.value !== '') || (storageEl && storageEl.value !== '')
                     || row.dataset.store || row.dataset.storage;
    if (!hasInput) return;
    counted++;
    // Below-par check requires the item record + invLowThreshold helper.
    if (typeof invLowThreshold === 'function' && cfg && id) {
      const item = (cache[cfg.cacheKey] || []).find(i => String(i.id) === String(id));
      if (item) {
        const thresh = invLowThreshold(item, loc);
        if (thresh != null && thresh > 0 && (store + storage) <= thresh) belowPar++;
      }
    }
  });
  prog.innerHTML = `
    <span class="count-progress-stat">
      <b>${counted}</b><span class="muted"> / ${rows.length} counted</span>
      ${belowPar > 0 ? `<span class="below-par"> · ${belowPar} below par</span>` : ''}
    </span>`;
}

function updateCountTotal(input) {
  const row = input.closest('.count-row');
  if (!row) return;
  const id = row.dataset.id;
  // In split-view mode the inactive column input isn't rendered — fall
  // back to the row's data-store / data-storage stash (set at render
  // time from the most recent count or the saved draft).
  const storeEl   = row.querySelector('.count-store');
  const storageEl = row.querySelector('.count-storage');
  const store   = storeEl   ? (parseFloat(storeEl.value)  ||0) : (parseFloat(row.dataset.store)  ||0);
  const storage = storageEl ? (parseFloat(storageEl.value)||0) : (parseFloat(row.dataset.storage)||0);
  const totalEl = document.getElementById('count-total-'+id);
  if (totalEl) totalEl.textContent = +(store+storage).toFixed(2);
  _flashCountRow(row);
  _refreshCountProgress();
  // Autosave the whole sheet as a draft
  _autosaveCountDebounced(() => {
    const cfg = invCfg();
    if (cfg && currentLocation !== 'all') saveCountDraft('.count-row', cfg, currentLocation, null);
  });
}

// Briefly flash a count row (cream → light-blue → fade) so the user
// gets visual confirmation the change is staged. Lightweight: just
// toggle a class that drives a 600 ms CSS keyframe (see index.html
// .count-row.count-saved). Re-triggering during the animation
// removes + re-adds so successive edits keep flashing.
function _flashCountRow(row) {
  if (!row) return;
  row.classList.remove('count-saved');
  // Force reflow so re-adding the class restarts the animation.
  void row.offsetWidth;
  row.classList.add('count-saved');
  setTimeout(() => row.classList.remove('count-saved'), 650);
}

function countPlusOne(btn, target='store', delta=1) {
  const row = btn.closest('.count-row');
  if (!row) return;
  const input = row.querySelector(target === 'storage' ? '.count-storage' : '.count-store');
  input.value = +Math.max(0, (parseFloat(input.value)||0) + delta).toFixed(2);
  updateCountTotal(input);
}

// "Clear Draft" — wipes the in-progress draft + reverts every input
// back to the most recent submitted count (renderCountSheet pre-fills
// inputs from recentMap, so re-rendering after clearing the draft is
// the simplest way to revert).
function clearCountSheet() {
  const cfg = invCfg();
  if (cfg && currentLocation !== 'all') clearCountDraft(cfg, currentLocation, null);
  if (typeof renderCountSheet === 'function') renderCountSheet();
}

// Upsert BSC_LastCount — one record per invType:location
async function upsertLastCount(cfg, loc, countedBy) {
  const key = cfg.listKey + ':' + loc;
  const now = new Date().toISOString();
  const existing = cache.lastCount.find(r => r.Title === key);
  try {
    if (existing) {
      await updateListItem(LISTS.lastCount, existing.id, { CountedBy: countedBy, CountedAt: now });
      existing.CountedBy = countedBy;
      existing.CountedAt = now;
    } else {
      const rec = await addListItem(LISTS.lastCount, {
        Title: key, InvType: cfg.listKey, CountedBy: countedBy, CountedAt: now
      });
      cache.lastCount.push(rec);
    }
  } catch(e) {
    console.warn('[BSC] upsertLastCount failed:', e.message);
  }
}

async function submitWeeklyCount() {
  // Stamp with the exact submit timestamp — gives every submit a unique sort key.
  // Schema column is still named WeekOf for compatibility with existing per-location
  // count lists; the value is now a full ISO datetime, not midnight.
  const countedAt = new Date().toISOString();
  const countedBy = currentUser?.name || currentUser?.username || '';
  const loc = currentLocation === 'all' ? (
    cache.inventory[0]?.Location || 'All'
  ) : currentLocation;

  // In split-view mode the inactive column input isn't in the DOM —
  // its value is stashed on the row's data-store / data-storage attr
  // (set at render from the most recent count + restored draft).
  const rows = document.querySelectorAll('#count-sheet-body .count-row');
  const entries = [];
  rows.forEach(row => {
    const storeEl   = row.querySelector('.count-store');
    const storageEl = row.querySelector('.count-storage');
    const storeVal   = storeEl   ? storeEl.value.trim()   : (row.dataset.store   ?? '');
    const storageVal = storageEl ? storageEl.value.trim() : (row.dataset.storage ?? '');
    if (storeVal==='' && storageVal==='') return; // skip blank rows
    const store   = parseFloat(storeVal)||0;
    const storage = parseFloat(storageVal)||0;
    entries.push({
      id: row.dataset.id,
      name: row.dataset.name,
      store, storage,
      total: +(store+storage).toFixed(2)
    });
  });

  if (!entries.length) { toast('err','Enter at least one count'); return; }

  const prog = document.getElementById('count-submit-progress');
  const btn = document.querySelector('#inv-tab-count .btn-primary');
  btn.disabled = true;
  // Mark prog as busy so _refreshCountProgress (called by typing in
  // any count input mid-submit) doesn't overwrite the "X/Y saving…"
  // status. Cleared in finally.
  if (prog) prog.dataset.busy = '1';

  try {
    setLoading(true, `Saving ${entries.length} count records…`);

    const cfg = invCfg();
    const cntList = cfg.countsPrefix.replace('{loc}', (loc||'').replace(/[\s\/\\]/g, '_'));
    if (!cntList) { toast('err','Select a specific location to submit counts'); setLoading(false); btn.disabled=false; return; }

    // batch save to location counts list (8 concurrent). Stock totals live on
    // the count record only — the inventory item master has no CurrentStock /
    // StoreCount / StorageCount columns. Display reads via getLatestCountsMap()
    // / recentMap, so writing back to the item is unnecessary (and used to 400).
    // PR 14c — route writes through safeAddListItem so they queue
    // to IndexedDB if we're offline (or hit a recoverable error).
    // The queue auto-drains when the browser comes back online.
    // Falls back to addListItem directly if sync-queue.js failed to load.
    const _writer = (typeof safeAddListItem === 'function') ? safeAddListItem : addListItem;
    const countTasks = entries.map(e => () => _writer(cntList, {
      Title: e.name,
      WeekOf: countedAt,
      StoreCount: e.store,
      StorageCount: e.storage,
      TotalCount: e.total,
      Location: loc,
      CountedBy: countedBy
    }, { kind: 'count', label: `${e.name} @ ${loc}` }));

    for (let i=0; i<countTasks.length; i+=8) {
      await Promise.all(countTasks.slice(i,i+8).map(t=>t()));
      prog.textContent = `${Math.min(i+8,countTasks.length)}/${countTasks.length}`;
    }

    // update cache — assign synthetic ids higher than any existing so recentMap tiebreak picks these
    const maxExistingId = Math.max(0, ...cache[cfg.countKey].map(r => Number(r.id||0)));
    const newRecords = entries.map((e, idx) => ({
      id: maxExistingId + idx + 1,
      Title: e.name, WeekOf: countedAt,
      StoreCount: e.store, StorageCount: e.storage, TotalCount: e.total,
      Location: loc, CountedBy: countedBy
    }));
    cache[cfg.countKey].unshift(...newRecords);

    // Slack alert for low items — O(1) lookup; was O(n²) over the inventory list
    const _itemById = new Map((cache[cfg.cacheKey] || []).map(i => [String(i.id), i]));
    const lowItems = entries.filter(e => {
      const item = _itemById.get(String(e.id));
      if (!item) return false;
      const thresh = invLowThreshold(item, loc);
      if (thresh == null) return false;
      return e.total <= thresh && e.total >= 0;
    });
    if (lowItems.length) {
      const names = lowItems.slice(0,5).map(e=>e.name).join(', ');
      const humanDate = countedAt.split('T')[0];
      sendSlackAlert(`⚠️ *${loc} Inventory Count — ${humanDate}*\nLow stock: ${names}${lowItems.length>5?` +${lowItems.length-5} more`:''}`, 'low_inventory');
    }

    upsertLastCount(cfg, loc, countedBy); // fire-and-forget
    clearCountDraft(cfg, loc, null); // draft committed — wipe backup
    // Always start the next session in Store view (matches the workflow)
    _consumableCountView = 'store';
    try { localStorage.setItem('bsc_count_view', 'store'); } catch {}
    toast('ok',`✓ Count submitted — ${entries.length} items`);
    clearCountSheet();
    renderCountSheet();
    renderDashboard();
    prog.textContent = '';
  } catch(e) { toast('err','Submit failed: '+e.message); }
  finally {
    setLoading(false);
    btn.disabled = false;
    if (prog) delete prog.dataset.busy;
    _refreshCountProgress();
  }
}

// ── Merch Count Sheet (monthly) ───────────────────────────────────
// Track which month is displayed (0 = current month, -1 = prev, etc.)
let _merchCountMonth = 0; // offset from current month

// View filter — hide rows whose pre-filled Total is 0 (typically items
// nobody stocks). Persisted across sessions per device.
let _merchHideZero = (typeof localStorage !== 'undefined' && localStorage.getItem('bsc_merch_hide_zero') === '1');

function toggleMerchHideZero() {
  _merchHideZero = !_merchHideZero;
  try { localStorage.setItem('bsc_merch_hide_zero', _merchHideZero ? '1' : '0'); } catch {}
  renderMerchCountSheet();
}

function renderMerchCountSheet() {
  const container = document.getElementById('count-sheet-body');
  if (currentLocation === 'all') {
    container.innerHTML = `
      <div style="background:var(--warning);border:1.5px solid var(--orange);border-radius:12px;padding:20px 24px;margin-top:12px;text-align:center">
        <div style="font-size:22px;margin-bottom:8px">📍</div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px">Select a location to enter counts</div>
        <div style="font-size:13px;color:var(--muted)">Use the location buttons at the top to choose a specific location before entering monthly counts.</div>
      </div>`;
    return;
  }

  // Update the count tab header controls dynamically for merch
  const headerBar = document.querySelector('#inv-tab-count .count-header-bar');
  if (headerBar) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() + _merchCountMonth, 1);
    const monthLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    headerBar.innerHTML = `
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick="shiftMerchMonth(-1)">◀</button>
        <div style="font-weight:700;font-size:15px;min-width:160px;text-align:center">${monthLabel}</div>
        <button class="btn btn-outline btn-sm" onclick="shiftMerchMonth(1)" ${_merchCountMonth>=0?'disabled':''}>▶</button>
        <div style="font-size:13px;color:var(--muted)">${currentUser?.name || currentUser?.username || ''}</div>
        <div style="display:flex;gap:6px;align-items:center;margin-left:8px;">
          <span style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Counting</span>
          <div id="merch-view-toggle" style="display:flex;gap:6px;"></div>
        </div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span id="count-draft-indicator" style="font-size:12px;color:var(--gold);opacity:0;transition:opacity .2s;"></span>
        <span id="merch-count-submit-progress" style="font-size:13px;color:var(--muted)"></span>
        <button class="btn btn-outline" onclick="toggleMerchHideZero()" title="Hide items whose pre-filled total is 0 — typically merch you don't stock">${_merchHideZero ? '👁 Show All' : '🙈 Hide Zero'}</button>
        <button class="btn btn-outline" onclick="openCountOrderModal()" title="Customize the per-location item order">⇅ Reorder</button>
        ${(typeof isOwner === 'function' && isOwner()) ? `<button class="btn btn-outline" onclick="openMerchCountRecords()" title="Owner-only: view and delete past count batches">🗑 Records</button>` : ''}
        <button class="btn btn-outline" onclick="clearMerchCountSheet()" title="Wipe the in-progress draft and revert each input to the last submitted count">Clear Draft</button>
        <button class="btn btn-primary" onclick="submitMerchCount()">Submit ${escHtml(monthLabel.split(' ')[0])} Count</button>
      </div>`;
    // Inject last-submitted info into merch header
    const _cfg = invCfg();
    const _lcRec = _cfg ? cache.lastCount.find(r => r.Title === _cfg.listKey + ':' + currentLocation) : null;
    if (_lcRec?.CountedAt) {
      const _d = new Date(_lcRec.CountedAt);
      const _fmt = _d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'}) + ' · ' + _d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      const _label = _fmt + (_lcRec.CountedBy ? ' · ' + _lcRec.CountedBy : '');
      const _lastEl = document.createElement('div');
      _lastEl.style.cssText = 'font-size:12px;color:var(--muted);padding:4px 0;width:100%';
      _lastEl.innerHTML = `<span style="font-weight:600">Last submitted:</span> ${escHtml(_label)}`;
      headerBar.appendChild(_lastEl);
    }
  }

  const cfg = invCfg();
  const loc = currentLocation;
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + _merchCountMonth, 1);
  const monthStr = d.toISOString().split('T')[0].slice(0,7); // "YYYY-MM"

  // Most recent count per item: prefer this-month records; fall back to the
  // most recent record from any earlier month so a fresh month opens with the
  // prior month's values pre-filled (manager updates only what changed).
  const recentMap = {};
  const priorMap  = {};
  (cache[cfg.countKey]||[])
    .filter(r => r.Location === loc)
    .sort((a,b)=>(a.WeekOf||'')>(b.WeekOf||'')?1:-1)
    .forEach(r => {
      const name = (r.Title||r.ItemName||'').trim();
      if (!name) return;
      const wk = r.WeekOf||'';
      const snap = {
        store: r.StoreCount||0, storage: r.StorageCount||0,
        total: r.TotalCount||0
      };
      if (wk.startsWith(monthStr))      recentMap[name] = snap;
      else if (wk.slice(0,7) < monthStr) priorMap[name]  = snap; // sorted asc → last write wins (most recent prior)
    });
  // Apply prior-month fallback for items missing a this-month entry
  for (const [name, snap] of Object.entries(priorMap)) {
    if (!recentMap[name]) recentMap[name] = snap;
  }

  // Merch no longer tracks Category or ItemNo. Apply per-location custom
  // order if one's saved (BSC_Settings `merchInventory_order_<Location>`),
  // otherwise alphabetical. Merch has no Store/Storage view split.
  const items = [...(cache[cfg.cacheKey]||[])];
  _applyCountOrder(items, _getCountOrder(cfg.cacheKey, currentLocation, _activeCountView(cfg)));

  // Owner+accounting see an "Expected" column = prior-month count
  // + received this month − Square sales this month. Useful for spotting
  // shrink/discrepancies before submitting the count. Hidden from baristas
  // and managers because it surfaces sales/COGs-adjacent data.
  const showExpected = (typeof isOwnerOrAccounting === 'function') && isOwnerOrAccounting();
  const expectedHeader = showExpected
    ? `<th style="padding:8px 12px;text-align:center;font-weight:600;color:var(--dark-blue)" title="Prior month total + received this month − Square sales this month">Expected</th>`
    : '';

  // Split-view (matches consumable count): only render the active
  // column header + input. Hidden column rides on row data-attr.
  const mview = (typeof _consumableCountView !== 'undefined') ? _consumableCountView : 'store';
  const visibleColLabel = mview === 'store' ? 'Store' : 'Storage';

  container.innerHTML = `
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:var(--opal);border-bottom:2px solid var(--border)">
        <th style="padding:8px 12px;text-align:left;font-weight:600">Item</th>
        <th style="padding:8px 12px;text-align:center;font-weight:600">${visibleColLabel}</th>
        <th style="padding:8px 12px;text-align:center;font-weight:600">Total</th>
        ${expectedHeader}
      </tr></thead>
      <tbody>
      ${items.map(item => {
          const last = recentMap[item.ItemName||''];
          const lastTotal = last ? (Number(last.total)||0) : 0;
          // Hide-zero filter: skip items whose pre-filled total is 0
          if (_merchHideZero && lastTotal === 0) return '';
          const expectedCell = showExpected
            ? `<td class="merch-expected" data-name="${(item.ItemName||'').replace(/"/g,'&quot;')}" style="padding:8px 12px;text-align:center;font-weight:600;color:var(--muted)" id="merch-expected-${item.id}">…</td>`
            : '';
          const lastStore   = last ? last.store   : '';
          const lastStorage = last ? last.storage : '';
          // Split-view: only render the active column's input. The other
          // column rides on a row data-attr so totals + submit stay correct.
          const otherDataAttr = mview === 'store'
            ? `data-storage="${lastStorage === '' ? '' : lastStorage}"`
            : `data-store="${lastStore === '' ? '' : lastStore}"`;
          const inputClass = mview === 'store' ? 'merch-store' : 'merch-storage';
          const visibleVal = mview === 'store' ? lastStore     : lastStorage;
          return `<tr class="merch-count-row" data-id="${item.id}" data-name="${(item.ItemName||'').replace(/"/g,'&quot;')}" ${otherDataAttr} style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 12px;font-weight:500">${escHtml(item.ItemName||'—')}</td>
            <td style="padding:6px 8px;text-align:center">
              <input type="number" class="count-num-input ${inputClass}" min="0" step="1" placeholder="0"
                value="${visibleVal}"
                oninput="updateMerchCountTotal(this)"
                style="width:64px;text-align:center;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px">
            </td>
            <td style="padding:8px 12px;text-align:center;font-weight:700" id="merch-total-${item.id}">${last ? last.total : 0}</td>
            ${expectedCell}
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>`;

  // Mount the Store/Storage toggle pills in the merch toolbar
  _renderConsumableViewToggle();

  // Async-populate Expected Total cells (Square fetch can take a few seconds)
  if (showExpected) _renderMerchExpectedTotals(loc, monthStr);

  // Restore any saved-but-unsubmitted merch draft for this loc + month
  const _cfgM = invCfg();
  if (_cfgM && currentLocation !== 'all') {
    const n = restoreCountDraft('.merch-count-row', _cfgM, currentLocation, _currentMerchMonthStr(), updateMerchCountTotal);
    if (n > 0) {
      toast('ok', `↺ Restored ${n} draft value${n===1?'':'s'} — submit to commit`);
      _showDraftSaved();
    }
  }
}

// Owner+accounting only — populates the Expected Total column in the
// merch count sheet. Called after renderMerchCountSheet writes the
// table; mutates the .merch-expected <td> cells once the Square sales
// fetch resolves. Formula: prior-month count + received this month
// − Square sales this month. Square sales come from
// fetchSquareSalesForMerchMonth (defined in index.html).
function _renderMerchExpectedTotals(loc, monthStr) {
  const cfg = invCfg();
  if (!cfg) return;
  // Prior-month total per item — most recent submitted count from any
  // month strictly before monthStr.
  const priorByName = {};
  (cache[cfg.countKey]||[])
    .filter(r => r.Location === loc)
    .sort((a,b) => (a.WeekOf||'') > (b.WeekOf||'') ? 1 : -1)
    .forEach(r => {
      const name = (r.Title||r.ItemName||'').trim();
      if (!name) return;
      const wk = (r.WeekOf||'').slice(0,7);
      if (wk && wk < monthStr) priorByName[name] = r.TotalCount || 0; // sorted asc → last write wins
    });
  // Received this month per item
  const receivedByName = {};
  (cache.merchReceived||[])
    .filter(r => r.Month === monthStr && r.Location === loc)
    .forEach(r => {
      const name = r.ItemName || '';
      if (!name) return;
      receivedByName[name] = (receivedByName[name]||0) + (Number(r.Quantity)||0);
    });

  const cells = [...document.querySelectorAll('.merch-expected')];
  if (!cells.length) return;

  // Square sales fetcher lives in index.html; if it's missing or the
  // call fails, show "—" so the column still renders cleanly.
  if (typeof fetchSquareSalesForMerchMonth !== 'function') {
    cells.forEach(c => { c.textContent = '—'; c.title = 'Square not configured'; });
    return;
  }
  fetchSquareSalesForMerchMonth(monthStr, loc).then(salesMap => {
    const sales = salesMap || {};
    cells.forEach(cell => {
      const name = cell.dataset.name || '';
      const prior = priorByName[name] || 0;
      const recv  = receivedByName[name] || 0;
      const sold  = (sales[name]?.qty) || 0;
      const expected = prior + recv - sold;
      cell.textContent = expected;
      cell.style.color = expected < 0 ? 'var(--red)' : 'var(--dark-blue)';
      cell.title = `prior ${prior} + received ${recv} − sold ${sold}`;
    });
  }).catch(e => {
    console.warn('[merchExpected] sales fetch failed:', e);
    cells.forEach(c => {
      const name = c.dataset.name || '';
      const prior = priorByName[name] || 0;
      const recv  = receivedByName[name] || 0;
      // Fall back to prior + received (no sales) so the column isn't useless.
      const partial = prior + recv;
      c.textContent = partial;
      c.style.color = 'var(--muted)';
      c.title = `prior ${prior} + received ${recv} (Square sales unavailable)`;
    });
  });
}

function shiftMerchMonth(delta) {
  _merchCountMonth = Math.min(0, _merchCountMonth + delta);
  renderMerchCountSheet();
}

function updateMerchCountTotal(input) {
  const row = input.closest('.merch-count-row');
  if (!row) return;
  const id = row.dataset.id;
  // Split-view: read from input when present, fall back to row data-attr
  // (the inactive column's last value).
  const storeEl   = row.querySelector('.merch-store');
  const storageEl = row.querySelector('.merch-storage');
  const store   = storeEl   ? (parseFloat(storeEl.value)  ||0) : (parseFloat(row.dataset.store)  ||0);
  const storage = storageEl ? (parseFloat(storageEl.value)||0) : (parseFloat(row.dataset.storage)||0);
  const el = document.getElementById('merch-total-'+id);
  if (el) el.textContent = store + storage;
  _flashCountRow(row);
  // Autosave draft
  _autosaveCountDebounced(() => {
    const cfg = invCfg();
    if (cfg && currentLocation !== 'all') saveCountDraft('.merch-count-row', cfg, currentLocation, _currentMerchMonthStr());
  });
}

// "Clear Draft" for merch — wipes the in-progress draft + reverts
// every input to the last submitted count for the active month.
function clearMerchCountSheet() {
  const cfg = invCfg();
  if (cfg && currentLocation !== 'all') clearCountDraft(cfg, currentLocation, _currentMerchMonthStr());
  if (typeof renderMerchCountSheet === 'function') renderMerchCountSheet();
}

async function submitMerchCount() {
  const loc = currentLocation === 'all' ? null : currentLocation;
  if (!loc) { toast('err','Select a location first'); return; }

  const countedBy = currentUser?.name || currentUser?.username || '';
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + _merchCountMonth, 1);
  const monthDate = d.toISOString().split('T')[0]; // first of the month
  const monthLabel = d.toLocaleDateString('en-US', { month:'long', year:'numeric' });

  // Past-month confirm — small but easy to miss the header switching back
  // to "May" via a SignalR-triggered re-render, so make the target explicit
  // before we write.
  if (_merchCountMonth < 0) {
    if (!await confirmModal({ title: 'Submit a past-month count?', body: `You're about to submit a count for ${monthLabel} (a past month).`, confirmLabel: 'Submit' })) return;
  }

  // Split-view: the inactive column's input isn't in the DOM. Pull
  // from row data-attr when missing so we always submit a complete record.
  const rows = document.querySelectorAll('.merch-count-row');
  const entries = [];
  rows.forEach(row => {
    const storeEl   = row.querySelector('.merch-store');
    const storageEl = row.querySelector('.merch-storage');
    const storeVal   = storeEl   ? storeEl.value.trim()   : (row.dataset.store   ?? '');
    const storageVal = storageEl ? storageEl.value.trim() : (row.dataset.storage ?? '');
    if (storeVal==='' && storageVal==='') return;
    const store   = parseFloat(storeVal)||0;
    const storage = parseFloat(storageVal)||0;
    entries.push({
      id: row.dataset.id,
      name: row.dataset.name,
      store, storage,
      total: store + storage
    });
  });

  if (!entries.length) { toast('err','Enter at least one count'); return; }

  const cfg = invCfg();
  const cntList = cfg.countsPrefix.replace('{loc}', (loc||'').replace(/[\s\/\\]/g,'_'));
  if (!cntList) { toast('err','Could not resolve counts list'); return; }

  const prog = document.getElementById('merch-count-submit-progress');
  const btn = document.querySelector('#inv-tab-count .btn-primary');
  btn.disabled = true;

  try {
    setLoading(true, `Saving ${entries.length} merch count records…`);
    const tasks = entries.map(e => () => addListItem(cntList, {
      Title: e.name,
      WeekOf: monthDate + 'T00:00:00Z',
      StoreCount: e.store,
      StorageCount: e.storage,
      TotalCount: e.total,
      Location: loc,
      CountedBy: countedBy
    }));
    for (let i=0; i<tasks.length; i+=8) {
      await Promise.all(tasks.slice(i,i+8).map(t=>t()));
      prog.textContent = `${Math.min(i+8,tasks.length)}/${tasks.length}`;
    }
    // update cache — assign synthetic ids higher than any existing so recentMap tiebreak picks these
    const maxExistingId = Math.max(0, ...cache[cfg.countKey].map(r => Number(r.id||0)));
    const newRecords = entries.map((e, idx) => ({
      id: maxExistingId + idx + 1,
      Title: e.name, WeekOf: monthDate+'T00:00:00Z',
      StoreCount: e.store, StorageCount: e.storage, TotalCount: e.total,
      Location: loc, CountedBy: countedBy
    }));
    cache[cfg.countKey].unshift(...newRecords);
    upsertLastCount(cfg, loc, countedBy); // fire-and-forget
    clearCountDraft(cfg, loc, _currentMerchMonthStr()); // draft committed — wipe backup
    clearMerchCountSheet();
    toast('ok', `✓ ${monthLabel} count submitted — ${entries.length} items`);
    renderDashboard();
    prog.textContent = '';
  } catch(e) { toast('err','Submit failed: '+e.message); }
  finally { setLoading(false); btn.disabled=false; }
}

// ── Owner-only count batch manager ───────────────────────────────
// Lists every (location, month) bucket of count records for the
// current location, lets the owner delete an entire batch (e.g. a
// count that landed on the wrong month). Refetches from SharePoint
// on open so we never act on synthetic in-cache ids.
async function openMerchCountRecords() {
  if (typeof isOwner !== 'function' || !isOwner()) { toast('err','Owner access required'); return; }
  const cfg = invCfg();
  if (!cfg) return;
  const loc = currentLocation === 'all' ? null : currentLocation;
  if (!loc) { toast('err','Select a specific location first'); return; }
  openModal('modal-merch-count-records');
  const body = document.getElementById('mcr-body');
  if (body) body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">Loading from SharePoint…</div>';
  try {
    const siteId = await getSiteId();
    const listName = cfg.countsPrefix.replace('{loc}', loc.replace(/[\s\/\\]/g,'_'));
    const fresh = await getCountHistoryForList(siteId, listName);
    // Replace this location's records in cache with the fresh fetch — drops
    // any synthetic ids written by submitMerchCount in this session.
    cache[cfg.countKey] = (cache[cfg.countKey]||[])
      .filter(r => r.Location !== loc)
      .concat((fresh||[]).map(r => ({ ...r, Location: r.Location || loc })));
    _renderMerchCountRecords();
  } catch (e) {
    if (body) body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red);">Failed to load: ${escHtml(e.message)}</div>`;
  }
}

function _renderMerchCountRecords() {
  const body = document.getElementById('mcr-body');
  if (!body) return;
  const cfg = invCfg();
  if (!cfg) return;
  const loc = currentLocation === 'all' ? null : currentLocation;
  if (!loc) {
    body.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:13px;">Select a location first.</div>';
    return;
  }
  const groups = {};
  (cache[cfg.countKey] || [])
    .filter(r => r.Location === loc)
    .forEach(r => {
      const month = (r.WeekOf||'').slice(0,7);
      if (!month) return;
      if (!groups[month]) groups[month] = { month, count: 0, by: new Set(), latestWeekOf: '' };
      groups[month].count++;
      if (r.CountedBy) groups[month].by.add(r.CountedBy);
      if ((r.WeekOf||'') > groups[month].latestWeekOf) groups[month].latestWeekOf = r.WeekOf||'';
    });
  const sorted = Object.values(groups).sort((a,b) => b.month.localeCompare(a.month));
  if (!sorted.length) {
    body.innerHTML = `<div style="padding:14px;color:var(--muted);font-size:13px;">No count records yet for ${escHtml(loc)}.</div>`;
    return;
  }
  body.innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.5;">
      Each row = one month's count batch for <b>${escHtml(loc)}</b>. Deleting a batch removes every row in that month from the underlying SharePoint counts list. Cannot be undone.
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:var(--cream);">
          <th style="text-align:left;padding:6px 10px;font-size:11px;color:var(--muted);">Month</th>
          <th style="text-align:right;padding:6px 10px;font-size:11px;color:var(--muted);">Items</th>
          <th style="text-align:left;padding:6px 10px;font-size:11px;color:var(--muted);">Counted by</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
      ${sorted.map(g => {
        const niceMonth = new Date(g.month + '-01T00:00:00').toLocaleDateString('en-US', {month:'long', year:'numeric'});
        const by = [...g.by].join(', ') || '—';
        return `
          <tr style="border-bottom:1px solid var(--opal);">
            <td style="padding:8px 10px;font-weight:600;">${escHtml(niceMonth)}</td>
            <td style="padding:8px 10px;text-align:right;">${g.count}</td>
            <td style="padding:8px 10px;font-size:12px;color:var(--muted);">${escHtml(by)}</td>
            <td style="padding:8px 10px;text-align:right;">
              <button class="btn btn-danger btn-sm" data-month="${escHtml(g.month)}" data-loc="${escHtml(loc)}" onclick="deleteMerchCountBatch(this.dataset.loc, this.dataset.month, this)">Delete batch</button>
            </td>
          </tr>`;
      }).join('')}
      </tbody>
    </table>
  `;
}

async function deleteMerchCountBatch(loc, month, btn) {
  if (typeof isOwner !== 'function' || !isOwner()) return;
  const cfg = invCfg();
  if (!cfg) return;
  const targets = (cache[cfg.countKey]||[]).filter(r =>
    r.Location === loc && (r.WeekOf||'').slice(0,7) === month
  );
  if (!targets.length) { toast('err','Nothing to delete'); return; }
  const niceMonth = new Date(month + '-01T00:00:00').toLocaleDateString('en-US', {month:'long', year:'numeric'});
  if (!await confirmModal({ title: `Delete ${targets.length} count record${targets.length!==1?'s':''}?`, body: `For ${loc} — ${niceMonth}.\n\nThis cannot be undone.`, confirmLabel: 'Delete', danger: true })) return;
  const listName = cfg.countsPrefix.replace('{loc}', loc.replace(/[\s\/\\]/g,'_'));
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  setLoading(true, `Deleting ${targets.length} records…`);
  let ok = 0, fail = 0;
  try {
    for (const r of targets) {
      try { await deleteListItem(listName, r.id); ok++; }
      catch (e) { fail++; console.warn('count delete failed:', e); }
    }
    // Wipe from cache regardless so the UI reflects intent
    cache[cfg.countKey] = (cache[cfg.countKey]||[]).filter(r =>
      !(r.Location === loc && (r.WeekOf||'').slice(0,7) === month)
    );
    if (fail) toast('err', `Deleted ${ok} of ${targets.length}; ${fail} failed (already removed?). Cache cleared.`);
    else      toast('ok',  `✓ Deleted ${ok} record${ok!==1?'s':''} for ${niceMonth}`);
    _renderMerchCountRecords();
    renderMerchCountSheet();
    if (typeof renderDashboard === 'function') renderDashboard();
  } finally { setLoading(false); }
}

// ── Touch-to-adjust gesture (iPhone / iPad) ──────────────────────
// Press-and-hold on any count number input, then drag vertically to
// increment (drag up) or decrement (drag down). The hold-then-drag
// pattern keeps a quick tap focusing the field for typing AND keeps
// a quick vertical swipe free for scrolling the page; only when the
// finger holds for HOLD_MS without moving more than SCROLL_TOLERANCE
// do we engage adjust mode and start eating subsequent touchmoves.
//
// Step size respects the input's `step` attribute (consumable=0.1,
// merch=1). PX_PER_STEP controls drag sensitivity.
(function() {
  if (typeof document === 'undefined') return;
  const HOLD_MS          = 350;
  const SCROLL_TOLERANCE = 8;
  const PX_PER_STEP      = 18;
  let state = null;

  function reset() {
    if (!state) return;
    if (state.holdTimer) clearTimeout(state.holdTimer);
    if (state.input) state.input.classList.remove('count-adjust-active');
    if (state.badge) state.badge.remove();
    state = null;
  }

  function isCountInput(el) {
    return !!(el && el.classList && el.classList.contains('count-num-input'));
  }

  function fireRowUpdate(input) {
    if (input.closest && input.closest('.merch-count-row')) {
      if (typeof updateMerchCountTotal === 'function') updateMerchCountTotal(input);
    } else {
      if (typeof updateCountTotal === 'function') updateCountTotal(input);
    }
  }

  function fmtDelta(unitsDelta, step) {
    const sign = unitsDelta > 0 ? '+' : '';
    const decimals = step < 1 ? 1 : 0;
    return `${sign}${unitsDelta.toFixed(decimals)}`;
  }

  document.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const t = e.target;
    if (!isCountInput(t)) return;
    const touch = e.touches[0];
    const stepAttr = parseFloat(t.step) || 1;
    state = {
      input: t,
      startY: touch.clientY,
      startVal: parseFloat(t.value) || 0,
      step: stepAttr,
      adjusting: false,
      badge: null,
      holdTimer: setTimeout(() => {
        if (!state) return;
        state.adjusting = true;
        state.input.classList.add('count-adjust-active');
        // Dismiss the iOS keyboard if it had popped up
        try { state.input.blur(); } catch {}
        // Floating delta pill
        const badge = document.createElement('div');
        badge.className = 'count-adjust-badge';
        badge.textContent = '0';
        const r = state.input.getBoundingClientRect();
        // Place to the right when there's room, otherwise above
        const right = r.right + 10 + 110 < window.innerWidth;
        const top   = right ? (r.top + r.height/2 - 14) : (r.top - 36);
        const left  = right ? (r.right + 8)             : Math.max(8, r.left);
        badge.style.cssText = `position:fixed;left:${left}px;top:${top}px;background:var(--gold);color:#fff;padding:4px 10px;border-radius:14px;font-size:13px;font-weight:700;z-index:9999;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.20);white-space:nowrap;`;
        document.body.appendChild(badge);
        state.badge = badge;
        if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
      }, HOLD_MS)
    };
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!state) return;
    const touch = e.touches[0];
    if (!touch) return;
    const deltaY = touch.clientY - state.startY;
    if (!state.adjusting) {
      // Pre-hold: any meaningful movement cancels so the OS can scroll.
      if (Math.abs(deltaY) > SCROLL_TOLERANCE) {
        reset();
      }
      return;
    }
    // In adjust mode: eat the gesture so the page doesn't scroll.
    e.preventDefault();
    const stepCount  = Math.round(-deltaY / PX_PER_STEP);
    const unitsDelta = stepCount * state.step;
    const next = Math.max(0, +(state.startVal + unitsDelta).toFixed(2));
    state.input.value = next;
    if (state.badge) state.badge.textContent = `${fmtDelta(unitsDelta, state.step)}  →  ${next}`;
    fireRowUpdate(state.input);
  }, { passive: false });

  document.addEventListener('touchend',    () => reset());
  document.addEventListener('touchcancel', () => reset());
})();
