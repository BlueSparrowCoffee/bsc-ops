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
 *     sendSlackAlert, pullMerchSalesFromSquare
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
      const soldEl    = row.querySelector('.merch-sold');
      const store   = storeEl   ? storeEl.value   : '';
      const storage = storageEl ? storageEl.value : '';
      const sold    = soldEl    ? soldEl.value    : '';
      if (store !== '' || storage !== '' || sold !== '') {
        const rec = {};
        if (store   !== '') rec.store   = store;
        if (storage !== '') rec.storage = storage;
        if (sold    !== '') rec.sold    = sold;
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
      const soldEl    = row.querySelector('.merch-sold');
      if (storeEl   && rec.store   != null) { storeEl.value   = rec.store;   restored++; }
      if (storageEl && rec.storage != null) { storageEl.value = rec.storage; restored++; }
      if (soldEl    && rec.sold    != null) { soldEl.value    = rec.sold;    restored++; }
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

function _currentMerchMonthStr() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + (_merchCountMonth||0), 1);
  return d.toISOString().slice(0,7); // YYYY-MM
}

// ── Count Sheet (consumable, weekly) ──────────────────────────────
function renderCountSheet() {
  // Show warning if no specific location is selected
  const container = document.getElementById('count-sheet-body');
  if (currentLocation === 'all') {
    container.innerHTML = `
      <div style="background:#fff8e1;border:1.5px solid #f0c040;border-radius:10px;padding:20px 24px;margin-top:12px;text-align:center">
        <div style="font-size:22px;margin-bottom:8px">📍</div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px">Select a location to enter counts</div>
        <div style="font-size:13px;color:var(--muted)">Use the location buttons at the top to choose Sherman, Blake, or Platte before entering weekly counts.</div>
      </div>`;
    return;
  }

  // Auto date — always use current date/time, no manual input needed.
  // submitWeeklyCount reads the clock directly at submit time (see below),
  // so this function only drives the visible display.
  function updateCountDateDisplay() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const display = document.getElementById('count-date-display');
    if (display) display.textContent = now.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' }) + ' · ' + timeStr;
  }
  updateCountDateDisplay();
  // Update every minute so timestamp stays current
  if (window._countDateInterval) clearInterval(window._countDateInterval);
  window._countDateInterval = setInterval(updateCountDateDisplay, 60000);

  // auto-fill counted by from logged-in user — read-only display
  const byDisplay = document.getElementById('count-by-display');
  if (byDisplay) byDisplay.textContent = currentUser?.name || currentUser?.username || '—';

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

  // group items by vendor — all shared items, same list for every location
  const items = (cache[cfg.cacheKey] || []).filter(i => !i.Archived);
  const byVendor = {};
  items.forEach(i => {
    const vendor = i.Supplier || 'No Vendor';
    if (!byVendor[vendor]) byVendor[vendor] = [];
    byVendor[vendor].push(i);
  });

  container.innerHTML = Object.entries(byVendor).sort(([a],[b])=>a>b?1:-1).map(([vendor, vendorItems]) => `
    <div class="count-cat-section">
      <div class="count-cat-header">${vendor}</div>
      ${vendorItems.map(item => {
        const last = recentMap[item.ItemName];
        const unit = item.OrderUnit || item.Unit || '';
        const _par = (typeof getItemPar === 'function') ? (getItemPar(item, currentLocation) ?? 0) : (item.ParLevel||0);
        return `<div class="count-row" data-id="${item.id}" data-name="${(item.ItemName||'').replace(/"/g,'&quot;')}">
          <div style="flex:1;min-width:160px">
            <div class="count-item-name">${item.ItemName||'—'}</div>
            <div class="count-item-meta">par ${_par} ${unit}</div>
          </div>
          <div class="count-input-group">
            <label>Store</label>
            <input type="number" class="count-num-input count-store" min="0" step="0.1"
              oninput="updateCountTotal(this)" placeholder="0" value="${last != null ? last.store : ''}">
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;align-self:flex-end;margin-bottom:1px;flex-shrink:0;">
            <button onclick="countPlusOne(this, 'store')" title="+1 to store"
              style="padding:3px 8px;background:var(--opal);border:1.5px solid var(--border);border-radius:5px;font-size:12px;font-weight:700;cursor:pointer;color:var(--dark-blue);line-height:1;">+1</button>
            <button onclick="countPlusOne(this, 'store', -1)" title="-1 to store"
              style="padding:3px 8px;background:var(--opal);border:1.5px solid var(--border);border-radius:5px;font-size:12px;font-weight:700;cursor:pointer;color:var(--dark-blue);line-height:1;">−1</button>
          </div>
          <div class="count-input-group">
            <label>Storage</label>
            <input type="number" class="count-num-input count-storage" min="0" step="0.1"
              oninput="updateCountTotal(this)" placeholder="0" value="${last != null ? last.storage : ''}">
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;align-self:flex-end;margin-bottom:1px;flex-shrink:0;">
            <button onclick="countPlusOne(this, 'storage')" title="+1 to storage"
              style="padding:3px 8px;background:var(--opal);border:1.5px solid var(--border);border-radius:5px;font-size:12px;font-weight:700;cursor:pointer;color:var(--dark-blue);line-height:1;">+1</button>
            <button onclick="countPlusOne(this, 'storage', -1)" title="-1 to storage"
              style="padding:3px 8px;background:var(--opal);border:1.5px solid var(--border);border-radius:5px;font-size:12px;font-weight:700;cursor:pointer;color:var(--dark-blue);line-height:1;">−1</button>
          </div>
          <div class="count-total-box">
            <label>Total</label>
            <div class="count-total-val" id="count-total-${item.id}">${last != null ? last.total : '—'}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`).join('');

  // Restore any saved-but-unsubmitted draft for this location
  const _cfg = invCfg();
  if (_cfg && currentLocation !== 'all') {
    const n = restoreCountDraft('.count-row', _cfg, currentLocation, null, updateCountTotal);
    if (n > 0) {
      toast('ok', `↺ Restored ${n} draft value${n===1?'':'s'} — submit to commit`);
      _showDraftSaved();
    }
  }
}

function updateCountTotal(input) {
  const row = input.closest('.count-row');
  if (!row) return;
  const id = row.dataset.id;
  const store = parseFloat(row.querySelector('.count-store').value)||0;
  const storage = parseFloat(row.querySelector('.count-storage').value)||0;
  const totalEl = document.getElementById('count-total-'+id);
  if (totalEl) totalEl.textContent = +(store+storage).toFixed(2);
  // Autosave the whole sheet as a draft
  _autosaveCountDebounced(() => {
    const cfg = invCfg();
    if (cfg && currentLocation !== 'all') saveCountDraft('.count-row', cfg, currentLocation, null);
  });
}

function countPlusOne(btn, target='store', delta=1) {
  const row = btn.closest('.count-row');
  if (!row) return;
  const input = row.querySelector(target === 'storage' ? '.count-storage' : '.count-store');
  input.value = +Math.max(0, (parseFloat(input.value)||0) + delta).toFixed(2);
  updateCountTotal(input);
}

function clearCountSheet() {
  document.querySelectorAll('.count-num-input').forEach(i=>i.value='');
  document.querySelectorAll('.count-total-val').forEach(el=>el.textContent='0');
  const cfg = invCfg();
  if (cfg && currentLocation !== 'all') clearCountDraft(cfg, currentLocation, null);
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

  const rows = document.querySelectorAll('#count-sheet-body .count-row');
  const entries = [];
  rows.forEach(row => {
    const storeEl = row.querySelector('.count-store');
    const storageEl = row.querySelector('.count-storage');
    const storeVal = storeEl.value.trim();
    const storageVal = storageEl.value.trim();
    if (storeVal==='' && storageVal==='') return; // skip blank rows
    const store = parseFloat(storeVal)||0;
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

  try {
    setLoading(true, `Saving ${entries.length} count records…`);

    const cfg = invCfg();
    const cntList = cfg.countsPrefix.replace('{loc}', (loc||'').replace(/[\s\/\\]/g, '_'));
    if (!cntList) { toast('err','Select a specific location to submit counts'); setLoading(false); btn.disabled=false; return; }

    // batch save to location counts list (8 concurrent). Stock totals live on
    // the count record only — the inventory item master has no CurrentStock /
    // StoreCount / StorageCount columns. Display reads via getLatestCountsMap()
    // / recentMap, so writing back to the item is unnecessary (and used to 400).
    const countTasks = entries.map(e => () => addListItem(cntList, {
      Title: e.name,
      WeekOf: countedAt,
      StoreCount: e.store,
      StorageCount: e.storage,
      TotalCount: e.total,
      Location: loc,
      CountedBy: countedBy
    }));

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

    // Slack alert for low items
    const lowItems = entries.filter(e => {
      const item = cache[cfg.cacheKey].find(i=>String(i.id)===String(e.id));
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
    toast('ok',`✓ Count submitted — ${entries.length} items`);
    clearCountSheet();
    renderDashboard();
    prog.textContent = '';
  } catch(e) { toast('err','Submit failed: '+e.message); }
  finally { setLoading(false); btn.disabled=false; }
}

// ── Merch Count Sheet (monthly) ───────────────────────────────────
// Track which month is displayed (0 = current month, -1 = prev, etc.)
let _merchCountMonth = 0; // offset from current month

function renderMerchCountSheet() {
  const container = document.getElementById('count-sheet-body');
  if (currentLocation === 'all') {
    container.innerHTML = `
      <div style="background:#fff8e1;border:1.5px solid #f0c040;border-radius:10px;padding:20px 24px;margin-top:12px;text-align:center">
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
        <button class="btn btn-outline" onclick="shiftMerchMonth(-1)" style="padding:5px 12px;">◀</button>
        <div style="font-weight:700;font-size:15px;min-width:160px;text-align:center">${monthLabel}</div>
        <button class="btn btn-outline" onclick="shiftMerchMonth(1)" style="padding:5px 12px;" ${_merchCountMonth>=0?'disabled':''}>▶</button>
        <div style="font-size:13px;color:var(--muted)">${currentUser?.name || currentUser?.username || ''}</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-outline" id="merch-sq-btn" onclick="pullMerchSalesFromSquare()">Pull from Square</button>
        <span id="count-draft-indicator" style="font-size:12px;color:var(--gold);opacity:0;transition:opacity .2s;"></span>
        <span id="merch-count-submit-progress" style="font-size:13px;color:var(--muted)"></span>
        <button class="btn btn-outline" onclick="clearMerchCountSheet()">Clear</button>
        <button class="btn btn-primary" onclick="submitMerchCount()">Submit Count</button>
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

  // Find most recent count for this month+loc per item
  const recentMap = {};
  (cache[cfg.countKey]||[])
    .filter(r => r.Location === loc && (r.WeekOf||'').startsWith(monthStr))
    .sort((a,b)=>(a.WeekOf||'')>(b.WeekOf||'')?1:-1)
    .forEach(r => {
      const name = (r.Title||r.ItemName||'').trim();
      if (name) recentMap[name] = {
        store: r.StoreCount||0, storage: r.StorageCount||0,
        total: r.TotalCount||0, sold: r.ChangesSinceLastCount||0
      };
    });

  // Merch no longer tracks Category or ItemNo — sort alphabetically by name.
  const items = [...(cache[cfg.cacheKey]||[])].sort((a,b) =>
    (a.ItemName||'').localeCompare(b.ItemName||'')
  );

  container.innerHTML = `
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:var(--opal);border-bottom:2px solid var(--border)">
        <th style="padding:8px 12px;text-align:left;font-weight:600">Item</th>
        <th style="padding:8px 12px;text-align:center;font-weight:600">Store</th>
        <th style="padding:8px 12px;text-align:center;font-weight:600">Storage</th>
        <th style="padding:8px 12px;text-align:center;font-weight:600">Total</th>
        <th style="padding:8px 12px;text-align:center;font-weight:600" title="Units sold since last count (from Square)">Sold</th>
      </tr></thead>
      <tbody>
      ${items.map(item => {
          const last = recentMap[item.ItemName||''];
          return `<tr class="merch-count-row" data-id="${item.id}" data-name="${(item.ItemName||'').replace(/"/g,'&quot;')}" style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 12px;font-weight:500">${escHtml(item.ItemName||'—')}</td>
            <td style="padding:6px 8px;text-align:center">
              <input type="number" class="count-num-input merch-store" min="0" step="1" placeholder="0"
                value="${last ? last.store : ''}"
                oninput="updateMerchCountTotal(this)"
                style="width:64px;text-align:center;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px">
            </td>
            <td style="padding:6px 8px;text-align:center">
              <input type="number" class="count-num-input merch-storage" min="0" step="1" placeholder="0"
                value="${last ? last.storage : ''}"
                oninput="updateMerchCountTotal(this)"
                style="width:64px;text-align:center;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px">
            </td>
            <td style="padding:8px 12px;text-align:center;font-weight:700" id="merch-total-${item.id}">${last ? last.total : 0}</td>
            <td style="padding:6px 8px;text-align:center">
              <input type="number" class="merch-sold" min="0" step="1" placeholder="0"
                value="${last ? last.sold : ''}"
                style="width:64px;text-align:center;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;background:var(--opal)" title="Pulled from Square">
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>`;

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

function shiftMerchMonth(delta) {
  _merchCountMonth = Math.min(0, _merchCountMonth + delta);
  renderMerchCountSheet();
}

function updateMerchCountTotal(input) {
  const row = input.closest('.merch-count-row');
  if (!row) return;
  const id = row.dataset.id;
  const store = parseFloat(row.querySelector('.merch-store').value)||0;
  const storage = parseFloat(row.querySelector('.merch-storage').value)||0;
  const el = document.getElementById('merch-total-'+id);
  if (el) el.textContent = store + storage;
  // Autosave draft
  _autosaveCountDebounced(() => {
    const cfg = invCfg();
    if (cfg && currentLocation !== 'all') saveCountDraft('.merch-count-row', cfg, currentLocation, _currentMerchMonthStr());
  });
}

function clearMerchCountSheet() {
  document.querySelectorAll('.merch-count-row .count-num-input').forEach(i=>i.value='');
  document.querySelectorAll('.merch-count-row .merch-sold').forEach(i=>i.value='');
  document.querySelectorAll('[id^="merch-total-"]').forEach(el=>el.textContent='0');
  const cfg = invCfg();
  if (cfg && currentLocation !== 'all') clearCountDraft(cfg, currentLocation, _currentMerchMonthStr());
}

async function submitMerchCount() {
  const loc = currentLocation === 'all' ? null : currentLocation;
  if (!loc) { toast('err','Select a location first'); return; }

  const countedBy = currentUser?.name || currentUser?.username || '';
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + _merchCountMonth, 1);
  const monthDate = d.toISOString().split('T')[0]; // first of the month

  const rows = document.querySelectorAll('.merch-count-row');
  const entries = [];
  rows.forEach(row => {
    const storeVal = row.querySelector('.merch-store').value.trim();
    const storageVal = row.querySelector('.merch-storage').value.trim();
    const soldVal = row.querySelector('.merch-sold').value.trim();
    if (storeVal==='' && storageVal==='') return;
    const store = parseFloat(storeVal)||0;
    const storage = parseFloat(storageVal)||0;
    entries.push({
      id: row.dataset.id,
      name: row.dataset.name,
      store, storage,
      total: store + storage,
      sold: parseFloat(soldVal)||0
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
      ChangesSinceLastCount: e.sold,
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
      ChangesSinceLastCount: e.sold, Location: loc, CountedBy: countedBy
    }));
    cache[cfg.countKey].unshift(...newRecords);
    upsertLastCount(cfg, loc, countedBy); // fire-and-forget
    clearCountDraft(cfg, loc, _currentMerchMonthStr()); // draft committed — wipe backup
    clearMerchCountSheet();
    toast('ok', `✓ Merch count submitted — ${entries.length} items`);
    renderDashboard();
    prog.textContent = '';
  } catch(e) { toast('err','Submit failed: '+e.message); }
  finally { setLoading(false); btn.disabled=false; }
}
