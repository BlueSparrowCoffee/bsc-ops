/* ================================================================
 * BSC Ops — market-analysis.js
 * Owner-only competitive pricing dashboard.
 *
 * Data sources:
 *   - cache.marketCompetitors  (BSC_MarketCompetitors)
 *   - cache.marketItems        (BSC_MarketItems — curated tracked items)
 *   - cache.marketPrices       (BSC_MarketPrices — one row per survey point)
 *   - cache.menu               (Square menu items, for matching)
 *   - cache.squareModifiers    (flattened Square modifiers, for matching)
 *
 * v1 (commit 1): page shell, manage competitors/items, single-row edit,
 *   spreadsheet importer, headline + per-item bar chart + heatmap.
 *
 * v2 (commit 2 — deferred): Survey Day batch entry, time-series chart,
 *   margin overlay, outlier review panel, change indicators, freshness.
 *
 * Depends on:
 *   state.js     — cache, currentUser
 *   constants.js — LISTS, MARKET_*_COLS
 *   utils.js     — escHtml, toast
 *   graph.js     — getSiteId, getListItems, addListItem, updateListItem,
 *                  deleteListItem, ensureList
 *   auth.js      — isOwner
 *   settings.js  — getSetting / saveSetting
 *   square.js    — syncSquareModifiers (already loaded once at boot)
 * ================================================================ */

// ── Categories ───────────────────────────────────────────────────
const MARKET_CATEGORIES = [
  { key:'espresso',  label:'Espresso-based',  emoji:'☕' },
  { key:'brewed',    label:'Brewed coffee',   emoji:'🫖' },
  { key:'cold',      label:'Cold drinks',     emoji:'🧊' },
  { key:'tea',       label:'Tea / matcha',    emoji:'🍵' },
  { key:'modifier',  label:'Modifiers',       emoji:'➕' },
  { key:'other',     label:'Other',           emoji:'•'  }
];
function _marketCatLabel(k) {
  return MARKET_CATEGORIES.find(c => c.key === k)?.label || 'Other';
}

// ── State (page-local) ───────────────────────────────────────────
let _maSelectedItemId = null;   // currently focused item in the bar chart
let _maImportFile     = null;   // raw {sheet, rows} from upload
let _maImportPlan     = null;   // user-confirmed mapping before write

// ── Helpers ──────────────────────────────────────────────────────
function _maMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toFixed(2);
}
function _maItemKey(item) {
  const t = (item.Title || '').trim();
  const s = (item.Size  || '').trim();
  return s ? `${t} ${s}` : t;
}
function _maParseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function _maFmtDate(d) {
  if (!d) return '';
  const dt = (typeof d === 'string') ? new Date(d) : d;
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'});
}

// Latest price per (itemKey, competitor) — caller-decides scope
function _maLatestPriceMap(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.ItemKey}||${r.Competitor}`;
    const d = _maParseDate(r.SurveyDate);
    const prev = m.get(k);
    if (!prev || (d && (!prev._date || d > prev._date))) {
      m.set(k, { ...r, _date: d });
    }
  }
  return m;
}

// ── Data load (called from loadAllData via index.html) ───────────
async function loadMarketAnalysisData(siteId) {
  const [comps, items, prices] = await Promise.all([
    getListItems(siteId, LISTS.marketCompetitors).catch(()=>[]),
    getListItems(siteId, LISTS.marketItems).catch(()=>[]),
    getListItems(siteId, LISTS.marketPrices).catch(()=>[])
  ]);
  cache.marketCompetitors = comps || [];
  cache.marketItems       = items || [];
  cache.marketPrices      = prices || [];
}

// ── Main page render ─────────────────────────────────────────────
function renderMarketAnalysis() {
  const page = document.getElementById('page-market-analysis');
  if (!page) return;
  if (!isOwner()) {
    page.querySelector('#ma-body').style.display = 'none';
    page.querySelector('#ma-access-denied').style.display = '';
    return;
  }
  page.querySelector('#ma-access-denied').style.display = 'none';
  page.querySelector('#ma-body').style.display = '';

  _renderMarketHeadline();
  _renderMarketCompetitorChips();
  _renderMarketItemPicker();
  _renderMarketBarChart();
  _renderMarketHeatmap();
}

// ── Headline ─────────────────────────────────────────────────────
function _renderMarketHeadline() {
  const el = document.getElementById('ma-headline');
  if (!el) return;
  const items   = (cache.marketItems || []).filter(i => i.Active !== 'No');
  const comps   = (cache.marketCompetitors || []).filter(c => c.Active !== 'No').map(c => c.Title);
  const prices  = cache.marketPrices || [];
  if (!items.length || !prices.length) {
    el.innerHTML = `<span style="color:var(--muted)">Add tracked items + competitor prices (or import a spreadsheet) to see how you compare.</span>`;
    return;
  }
  const latest = _maLatestPriceMap(prices);

  let summed = 0, counted = 0, above = 0, below = 0;
  for (const it of items) {
    const key = _maItemKey(it);
    const bsc = latest.get(`${key}||BSC`)?.Price;
    if (bsc == null) continue;
    const compPrices = comps
      .map(c => latest.get(`${key}||${c}`)?.Price)
      .filter(p => p != null && p > 0);
    if (!compPrices.length) continue;
    const avg = compPrices.reduce((a,b)=>a+b,0) / compPrices.length;
    if (avg <= 0) continue;
    const pct = (bsc - avg) / avg * 100;
    summed += pct; counted++;
    if (pct > 0)  above++;
    if (pct < 0) below++;
  }
  if (!counted) {
    el.innerHTML = `<span style="color:var(--muted)">Need BSC + at least one competitor price per item to compute the headline.</span>`;
    return;
  }
  const avgPct = summed / counted;
  const dir = avgPct >= 0 ? 'above' : 'below';
  const arrow = avgPct >= 0 ? '▲' : '▼';
  const color = avgPct >= 5 ? 'var(--red)' : avgPct <= -5 ? 'var(--gold)' : 'var(--dark-blue)';
  el.innerHTML = `
    <div style="font-size:15px;color:var(--muted);margin-bottom:4px;">Across ${counted} item${counted!==1?'s':''}, BSC is</div>
    <div style="font-size:32px;font-weight:700;color:${color};letter-spacing:-.5px;">
      ${arrow} ${Math.abs(avgPct).toFixed(1)}% ${dir} market avg
    </div>
    <div style="font-size:12px;color:var(--muted);margin-top:6px;">${above} items priced above market · ${below} below · ${counted-above-below} at market</div>
  `;
}

// ── Competitor chips (active toggles) ────────────────────────────
function _renderMarketCompetitorChips() {
  const el = document.getElementById('ma-competitor-chips');
  if (!el) return;
  const comps = (cache.marketCompetitors || []).slice().sort((a,b)=>(a.Title||'').localeCompare(b.Title||''));
  if (!comps.length) {
    el.innerHTML = `<span style="color:var(--muted);font-size:13px;">No competitors yet — open Manage to add some.</span>`;
    return;
  }
  el.innerHTML = comps.map(c => {
    const active = c.Active !== 'No';
    const bg = active ? 'var(--dark-blue)' : 'var(--opal)';
    const fg = active ? '#fff' : 'var(--muted)';
    return `<span data-id="${c.id}" onclick="toggleMarketCompetitor(this.dataset.id)" style="display:inline-block;padding:4px 10px;border-radius:14px;font-size:12px;font-weight:600;background:${bg};color:${fg};margin:2px 4px 2px 0;cursor:pointer;user-select:none;" title="Click to ${active?'hide':'show'}">${escHtml(c.Title)}</span>`;
  }).join('');
}
async function toggleMarketCompetitor(id) {
  if (!isOwner()) return;
  const c = (cache.marketCompetitors || []).find(x => x.id === id);
  if (!c) return;
  const next = (c.Active === 'No') ? 'Yes' : 'No';
  try {
    await updateListItem(LISTS.marketCompetitors, id, { Active: next });
    c.Active = next;
    renderMarketAnalysis();
  } catch (e) { toast('err','Toggle failed: '+e.message); }
}

// ── Item picker dropdown ─────────────────────────────────────────
function _renderMarketItemPicker() {
  const sel = document.getElementById('ma-item-picker');
  if (!sel) return;
  const items = (cache.marketItems || []).filter(i => i.Active !== 'No');
  // Group by category
  const grouped = {};
  for (const it of items) {
    const cat = it.Category || 'other';
    (grouped[cat] = grouped[cat] || []).push(it);
  }
  // Stable order via MARKET_CATEGORIES
  const html = MARKET_CATEGORIES
    .filter(c => grouped[c.key]?.length)
    .map(c => {
      const opts = grouped[c.key]
        .sort((a,b)=>{
          const oa = parseFloat(a.DisplayOrder)||999, ob = parseFloat(b.DisplayOrder)||999;
          if (oa !== ob) return oa - ob;
          return _maItemKey(a).localeCompare(_maItemKey(b));
        })
        .map(it => `<option value="${it.id}">${escHtml(_maItemKey(it))}</option>`).join('');
      return `<optgroup label="${c.emoji} ${c.label}">${opts}</optgroup>`;
    }).join('');
  if (!html) {
    sel.innerHTML = `<option value="">— No tracked items yet —</option>`;
    return;
  }
  // Preserve previous selection if still valid
  const prev = _maSelectedItemId;
  sel.innerHTML = html;
  if (prev && items.find(i => i.id === prev)) sel.value = prev;
  else _maSelectedItemId = sel.value;
}
function onMarketItemPick(id) {
  _maSelectedItemId = id || null;
  _renderMarketBarChart();
}

// ── Per-item bar chart (hand-rolled SVG) ─────────────────────────
function _renderMarketBarChart() {
  const el = document.getElementById('ma-bar-chart');
  if (!el) return;
  const itemId = _maSelectedItemId;
  const item = (cache.marketItems || []).find(i => i.id === itemId);
  if (!item) {
    el.innerHTML = `<div class="card" style="padding:32px 16px;text-align:center;color:var(--muted);font-size:13px;">Pick an item to see how you compare.</div>`;
    return;
  }
  const key = _maItemKey(item);
  const comps = (cache.marketCompetitors || []).filter(c => c.Active !== 'No').map(c => c.Title);
  const latest = _maLatestPriceMap(cache.marketPrices || []);

  // Build rows: BSC + every active competitor with a price
  const rows = [];
  const bscRow = latest.get(`${key}||BSC`);
  if (bscRow) rows.push({ name:'BSC', price:Number(bscRow.Price), date:bscRow._date, isBSC:true });
  for (const c of comps) {
    const r = latest.get(`${key}||${c}`);
    if (r && r.Price != null) rows.push({ name:c, price:Number(r.Price), date:r._date, isBSC:false });
  }
  rows.sort((a,b) => a.price - b.price);

  if (!rows.length) {
    el.innerHTML = `<div class="card" style="padding:32px 16px;text-align:center;color:var(--muted);font-size:13px;">No prices for "${escHtml(key)}" yet. Use <b>+ Add Survey</b> or import a spreadsheet.</div>`;
    return;
  }

  // BSC stats
  const bsc = rows.find(r => r.isBSC)?.price ?? null;
  const compPrices = rows.filter(r => !r.isBSC).map(r => r.price);
  const avg = compPrices.length ? compPrices.reduce((a,b)=>a+b,0) / compPrices.length : null;
  let bscRank = '—', rankSuffix = '';
  if (bsc != null) {
    bscRank = rows.findIndex(r => r.isBSC) + 1;
    rankSuffix = ` of ${rows.length}`;
  }
  const pct = (bsc != null && avg != null && avg > 0) ? ((bsc - avg) / avg * 100) : null;
  let summary = '';
  if (pct != null) {
    const arrow = pct >= 0 ? '▲' : '▼';
    const dir = pct >= 0 ? 'above' : 'below';
    summary = ` · BSC ${arrow} ${Math.abs(pct).toFixed(1)}% ${dir} avg · rank ${bscRank}${rankSuffix}`;
  } else if (bsc == null) {
    summary = ` · No BSC price yet — add one to compare`;
  }

  // SVG layout
  const VB_W = 720, ROW_H = 28, PAD_T = 12, PAD_B = 24, PAD_L = 130, PAD_R = 90;
  const VB_H = PAD_T + PAD_B + rows.length * ROW_H;
  const plotW = VB_W - PAD_L - PAD_R;
  const maxP = Math.max(...rows.map(r => r.price), avg || 0) * 1.08;
  const xScale = p => PAD_L + (p / maxP) * plotW;

  const bars = rows.map((r, i) => {
    const y = PAD_T + i * ROW_H;
    const w = xScale(r.price) - PAD_L;
    const fill = r.isBSC ? 'var(--gold)' : '#cfd9db';
    const labelColor = r.isBSC ? 'var(--dark-blue)' : '#444';
    return `
      <g>
        <text x="${PAD_L - 8}" y="${y + ROW_H/2 + 4}" text-anchor="end" font-size="12" fill="${labelColor}" font-weight="${r.isBSC?'700':'500'}">${escHtml(r.name)}</text>
        <rect x="${PAD_L}" y="${y + 4}" width="${Math.max(2, w)}" height="${ROW_H - 8}" fill="${fill}" rx="3"></rect>
        <text x="${PAD_L + w + 6}" y="${y + ROW_H/2 + 4}" font-size="12" fill="#222" font-weight="${r.isBSC?'700':'500'}">${_maMoney(r.price)}</text>
      </g>`;
  }).join('');

  // Avg reference line
  const avgLine = (avg != null) ? `
    <line x1="${xScale(avg)}" y1="${PAD_T - 2}" x2="${xScale(avg)}" y2="${PAD_T + rows.length*ROW_H + 2}" stroke="var(--dark-blue)" stroke-width="1.5" stroke-dasharray="4,4" opacity=".55"></line>
    <text x="${xScale(avg)}" y="${PAD_T + rows.length*ROW_H + 18}" text-anchor="middle" font-size="11" fill="var(--dark-blue)" opacity=".75">market avg ${_maMoney(avg)}</text>
  ` : '';

  el.innerHTML = `
    <div class="card" style="padding:16px 18px;">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
        <div style="font-size:16px;font-weight:700;color:var(--dark-blue);">${escHtml(key)}</div>
        <div style="font-size:12px;color:var(--muted);">${escHtml(_marketCatLabel(item.Category))}${summary}</div>
      </div>
      <svg viewBox="0 0 ${VB_W} ${VB_H}" style="width:100%;height:auto;display:block;">
        ${avgLine}
        ${bars}
      </svg>
    </div>
  `;
}

// ── Heatmap table ────────────────────────────────────────────────
function _renderMarketHeatmap() {
  const el = document.getElementById('ma-heatmap');
  if (!el) return;
  const items = (cache.marketItems || []).filter(i => i.Active !== 'No');
  const comps = (cache.marketCompetitors || []).filter(c => c.Active !== 'No');
  const latest = _maLatestPriceMap(cache.marketPrices || []);
  if (!items.length) {
    el.innerHTML = `<div class="card" style="padding:32px 16px;text-align:center;color:var(--muted);font-size:13px;">No tracked items yet.</div>`;
    return;
  }

  // Group by category
  const groups = {};
  for (const it of items) (groups[it.Category||'other'] = groups[it.Category||'other'] || []).push(it);

  const headHtml = `
    <thead>
      <tr style="background:var(--cream);">
        <th style="text-align:left;padding:8px 10px;font-size:12px;color:var(--muted);position:sticky;left:0;background:var(--cream);">Item</th>
        <th style="text-align:right;padding:8px 10px;font-size:12px;color:var(--muted);background:rgba(183,139,64,.10);">BSC</th>
        ${comps.map(c => `<th style="text-align:right;padding:8px 10px;font-size:12px;color:var(--muted);" title="${escHtml(c.Title)}">${escHtml(c.Title)}</th>`).join('')}
      </tr>
    </thead>`;

  const bodyHtml = MARKET_CATEGORIES
    .filter(c => groups[c.key]?.length)
    .map(cat => {
      const groupRows = groups[cat.key]
        .sort((a,b)=>{
          const oa = parseFloat(a.DisplayOrder)||999, ob = parseFloat(b.DisplayOrder)||999;
          if (oa !== ob) return oa - ob;
          return _maItemKey(a).localeCompare(_maItemKey(b));
        })
        .map(it => {
          const key = _maItemKey(it);
          const bsc = latest.get(`${key}||BSC`)?.Price;
          const cells = comps.map(c => {
            const p = latest.get(`${key}||${c.Title}`)?.Price;
            if (p == null) {
              return `<td data-id="${it.id}" data-comp="${escHtml(c.Title)}" onclick="openMarketPriceEdit(this.dataset.id, this.dataset.comp)" style="text-align:right;padding:6px 10px;font-size:12px;color:var(--muted);cursor:pointer;">—</td>`;
            }
            // color vs BSC: green if cheaper than them, red if more expensive
            let bg = 'transparent', fg = '#222';
            if (bsc != null && p > 0) {
              const diff = (bsc - p) / p; // BSC - them, normalized
              if (diff <= -0.05) { bg = 'rgba(22,163,74,.12)'; fg = '#166534'; }
              else if (diff >= 0.05) { bg = 'rgba(220,38,38,.12)'; fg = '#991b1b'; }
            }
            return `<td data-id="${it.id}" data-comp="${escHtml(c.Title)}" onclick="openMarketPriceEdit(this.dataset.id, this.dataset.comp)" style="text-align:right;padding:6px 10px;font-size:12px;background:${bg};color:${fg};cursor:pointer;font-variant-numeric:tabular-nums;">${_maMoney(p)}</td>`;
          }).join('');
          const bscCell = (bsc != null)
            ? `<td data-id="${it.id}" data-comp="BSC" onclick="openMarketPriceEdit(this.dataset.id, this.dataset.comp)" style="text-align:right;padding:6px 10px;font-size:12px;background:rgba(183,139,64,.10);color:var(--dark-blue);font-weight:700;cursor:pointer;font-variant-numeric:tabular-nums;">${_maMoney(bsc)}</td>`
            : `<td data-id="${it.id}" data-comp="BSC" onclick="openMarketPriceEdit(this.dataset.id, this.dataset.comp)" style="text-align:right;padding:6px 10px;font-size:12px;background:rgba(183,139,64,.10);color:var(--muted);cursor:pointer;">—</td>`;
          return `
            <tr style="border-bottom:1px solid var(--opal);">
              <td data-id="${it.id}" onclick="onMarketItemRowClick(this.dataset.id)" style="padding:6px 10px;font-size:12px;font-weight:600;color:var(--dark-blue);position:sticky;left:0;background:#fff;cursor:pointer;">${escHtml(_maItemKey(it))}</td>
              ${bscCell}
              ${cells}
            </tr>`;
        }).join('');
      return `
        <tr><td colspan="${2+comps.length}" style="padding:10px 10px 4px;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;">${cat.emoji} ${cat.label}</td></tr>
        ${groupRows}
      `;
    }).join('');

  el.innerHTML = `
    <div class="card" style="padding:8px 0 12px;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;min-width:600px;">
        ${headHtml}
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>
  `;
}
function onMarketItemRowClick(id) {
  const sel = document.getElementById('ma-item-picker');
  if (sel) { sel.value = id; }
  _maSelectedItemId = id;
  _renderMarketBarChart();
  document.getElementById('ma-bar-chart')?.scrollIntoView({behavior:'smooth', block:'nearest'});
}

// ── Single-row price edit modal ──────────────────────────────────
function openMarketPriceEdit(itemId, competitorName) {
  if (!isOwner()) return;
  const item = (cache.marketItems || []).find(i => i.id === itemId);
  if (!item) return;
  const key = _maItemKey(item);
  const latest = _maLatestPriceMap(cache.marketPrices || []);
  const existing = latest.get(`${key}||${competitorName}`);

  document.getElementById('mpe-title').textContent = `${key} — ${competitorName}`;
  document.getElementById('mpe-item-id').value = itemId;
  document.getElementById('mpe-item-key').value = key;
  document.getElementById('mpe-competitor').value = competitorName;
  document.getElementById('mpe-existing-id').value = existing?.id || '';
  document.getElementById('mpe-price').value = (existing?.Price != null) ? existing.Price : '';
  // Default survey date: today
  const today = new Date().toISOString().slice(0,10);
  const existingDate = existing?.SurveyDate ? new Date(existing.SurveyDate).toISOString().slice(0,10) : today;
  document.getElementById('mpe-date').value = existingDate;
  document.getElementById('mpe-notes').value = existing?.Notes || '';
  document.getElementById('mpe-delete-btn').style.display = existing ? '' : 'none';

  openModal('modal-market-price-edit');
}

async function saveMarketPriceEdit() {
  const itemKey = document.getElementById('mpe-item-key').value;
  const competitor = document.getElementById('mpe-competitor').value;
  const priceRaw = document.getElementById('mpe-price').value;
  const date = document.getElementById('mpe-date').value;
  const notes = document.getElementById('mpe-notes').value.trim();
  const existingId = document.getElementById('mpe-existing-id').value;

  const price = parseFloat(priceRaw);
  if (isNaN(price) || price < 0) { toast('err','Enter a valid price'); return; }
  if (!date) { toast('err','Pick a survey date'); return; }

  const fields = {
    Title: `${itemKey} | ${competitor} | ${date}`,
    ItemKey: itemKey,
    Competitor: competitor,
    Price: price,
    SurveyDate: date + 'T00:00:00Z',
    Notes: notes,
    Source: 'manual'
  };
  try {
    if (existingId) {
      await updateListItem(LISTS.marketPrices, existingId, fields);
      const row = cache.marketPrices.find(r => r.id === existingId);
      if (row) Object.assign(row, fields);
    } else {
      const item = await addListItem(LISTS.marketPrices, fields);
      cache.marketPrices.push(item);
    }
    closeModal('modal-market-price-edit');
    toast('ok','✓ Price saved');
    renderMarketAnalysis();
  } catch (e) { toast('err','Save failed: '+e.message); }
}

async function deleteMarketPriceEdit() {
  const id = document.getElementById('mpe-existing-id').value;
  if (!id) return;
  if (!confirm('Delete this price record?')) return;
  try {
    await deleteListItem(LISTS.marketPrices, id);
    cache.marketPrices = cache.marketPrices.filter(r => r.id !== id);
    closeModal('modal-market-price-edit');
    toast('ok','✓ Deleted');
    renderMarketAnalysis();
  } catch (e) { toast('err','Delete failed: '+e.message); }
}

// ── Manage modal: competitors + items ────────────────────────────
function openMarketManage() {
  if (!isOwner()) return;
  _renderManageCompetitorsList();
  _renderManageItemsList();
  openModal('modal-market-manage');
}
function _renderManageCompetitorsList() {
  const el = document.getElementById('mm-competitors-list');
  if (!el) return;
  const comps = (cache.marketCompetitors || []).slice().sort((a,b)=>(a.Title||'').localeCompare(b.Title||''));
  if (!comps.length) {
    el.innerHTML = `<div style="padding:8px;color:var(--muted);font-size:13px;">No competitors yet.</div>`;
    return;
  }
  el.innerHTML = comps.map(c => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--opal);font-size:13px;">
      <span style="flex:1;font-weight:600;${c.Active==='No'?'opacity:.5;text-decoration:line-through':''}">${escHtml(c.Title)}</span>
      <button class="btn btn-outline" style="padding:3px 10px;font-size:11px;" data-id="${c.id}" onclick="toggleMarketCompetitor(this.dataset.id)">${c.Active==='No'?'Show':'Hide'}</button>
      <button class="btn btn-outline" style="padding:3px 10px;font-size:11px;color:var(--red);" data-id="${c.id}" data-name="${escHtml(c.Title)}" onclick="deleteMarketCompetitor(this.dataset.id, this.dataset.name)">Delete</button>
    </div>
  `).join('');
}
async function addMarketCompetitor() {
  const inp = document.getElementById('mm-new-competitor');
  const name = inp.value.trim();
  if (!name) { toast('err','Enter a competitor name'); return; }
  if ((cache.marketCompetitors || []).some(c => (c.Title||'').toLowerCase() === name.toLowerCase())) {
    toast('err','Already exists'); return;
  }
  try {
    const item = await addListItem(LISTS.marketCompetitors, { Title:name, Active:'Yes' });
    cache.marketCompetitors.push(item);
    inp.value = '';
    _renderManageCompetitorsList();
    renderMarketAnalysis();
    toast('ok',`✓ ${name} added`);
  } catch (e) { toast('err','Add failed: '+e.message); }
}
async function deleteMarketCompetitor(id, name) {
  if (!confirm(`Delete "${name}" and ALL price rows for it? This cannot be undone.`)) return;
  try {
    await deleteListItem(LISTS.marketCompetitors, id);
    cache.marketCompetitors = cache.marketCompetitors.filter(c => c.id !== id);
    // Cascade delete prices for this competitor
    const orphans = cache.marketPrices.filter(p => p.Competitor === name);
    for (const p of orphans) {
      await deleteListItem(LISTS.marketPrices, p.id).catch(()=>{});
    }
    cache.marketPrices = cache.marketPrices.filter(p => p.Competitor !== name);
    _renderManageCompetitorsList();
    renderMarketAnalysis();
    toast('ok','✓ Deleted');
  } catch (e) { toast('err','Delete failed: '+e.message); }
}

function _renderManageItemsList() {
  const el = document.getElementById('mm-items-list');
  if (!el) return;
  const items = (cache.marketItems || []).slice().sort((a,b)=>{
    const oa = parseFloat(a.DisplayOrder)||999, ob = parseFloat(b.DisplayOrder)||999;
    if (oa !== ob) return oa - ob;
    return _maItemKey(a).localeCompare(_maItemKey(b));
  });
  if (!items.length) {
    el.innerHTML = `<div style="padding:8px;color:var(--muted);font-size:13px;">No tracked items yet.</div>`;
    return;
  }
  el.innerHTML = items.map(i => {
    const kindBadge = i.SquareKind === 'modifier' ? '🔧 modifier'
                    : i.SquareKind === 'item'     ? '🍴 item'
                    : '<span style="color:var(--muted)">unlinked</span>';
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--opal);font-size:13px;${i.Active==='No'?'opacity:.5':''}">
        <span style="flex:1;font-weight:600;">${escHtml(_maItemKey(i))}</span>
        <span style="font-size:11px;color:var(--muted);min-width:90px;">${kindBadge}</span>
        <span style="font-size:11px;color:var(--muted);min-width:80px;">${escHtml(_marketCatLabel(i.Category))}</span>
        <button class="btn btn-outline" style="padding:3px 10px;font-size:11px;" data-id="${i.id}" onclick="openMarketItemEdit(this.dataset.id)">Edit</button>
        <button class="btn btn-outline" style="padding:3px 10px;font-size:11px;color:var(--red);" data-id="${i.id}" data-name="${escHtml(_maItemKey(i))}" onclick="deleteMarketItem(this.dataset.id, this.dataset.name)">Delete</button>
      </div>`;
  }).join('');
}

function openMarketItemEdit(id) {
  const isEdit = !!id;
  const it = isEdit ? (cache.marketItems || []).find(x => x.id === id) : null;
  document.getElementById('mie-id').value = id || '';
  document.getElementById('mie-title-text').textContent = isEdit ? 'Edit Tracked Item' : 'Add Tracked Item';
  document.getElementById('mie-title').value = it?.Title || '';
  document.getElementById('mie-size').value  = it?.Size  || '';
  document.getElementById('mie-active').value = it?.Active || 'Yes';
  document.getElementById('mie-display-order').value = it?.DisplayOrder ?? '';
  // Category select
  const catSel = document.getElementById('mie-category');
  catSel.innerHTML = MARKET_CATEGORIES.map(c => `<option value="${c.key}"${(it?.Category||'other')===c.key?' selected':''}>${c.emoji} ${c.label}</option>`).join('');
  // Square kind + ref
  const kindSel = document.getElementById('mie-square-kind');
  kindSel.value = it?.SquareKind || '';
  document.getElementById('mie-square-ref-id').value = it?.SquareRefId || '';
  _renderMarketSquareRefDropdown();
  openModal('modal-market-item-edit');
}
function _renderMarketSquareRefDropdown() {
  const kind = document.getElementById('mie-square-kind').value;
  const sel = document.getElementById('mie-square-ref');
  const currentId = document.getElementById('mie-square-ref-id').value;
  let opts = [];
  if (kind === 'item') {
    opts = (cache.menu || []).filter(m => m.SquareId).map(m => ({ id:m.SquareId, label:m.ItemName||m.Title||m.SquareId }));
  } else if (kind === 'modifier') {
    opts = (cache.squareModifiers || []).map(m => ({
      id: m.id,
      label: `${m.name}${m.price != null ? ' ('+_maMoney(m.price)+')' : ''}${m.listName?' — '+m.listName:''}`
    }));
  }
  opts.sort((a,b)=>a.label.localeCompare(b.label));
  if (!kind) {
    sel.innerHTML = `<option value="">— Not linked —</option>`;
    sel.disabled = true;
  } else {
    sel.disabled = false;
    sel.innerHTML = `<option value="">— Pick a Square ${kind} —</option>` + opts.map(o => `<option value="${escHtml(o.id)}"${o.id===currentId?' selected':''}>${escHtml(o.label)}</option>`).join('');
  }
}
function onMarketItemSquareKindChange() {
  document.getElementById('mie-square-ref-id').value = '';
  _renderMarketSquareRefDropdown();
}
function onMarketItemSquareRefChange() {
  const sel = document.getElementById('mie-square-ref');
  document.getElementById('mie-square-ref-id').value = sel.value;
}

async function saveMarketItemEdit() {
  if (!isOwner()) return;
  const id = document.getElementById('mie-id').value;
  const title = document.getElementById('mie-title').value.trim();
  if (!title) { toast('err','Title is required'); return; }
  const fields = {
    Title:        title,
    Size:         document.getElementById('mie-size').value.trim(),
    Category:     document.getElementById('mie-category').value,
    SquareKind:   document.getElementById('mie-square-kind').value,
    SquareRefId:  document.getElementById('mie-square-ref-id').value,
    DisplayOrder: parseFloat(document.getElementById('mie-display-order').value) || 0,
    Active:       document.getElementById('mie-active').value || 'Yes'
  };
  try {
    if (id) {
      await updateListItem(LISTS.marketItems, id, fields);
      const row = cache.marketItems.find(r => r.id === id);
      if (row) Object.assign(row, fields);
    } else {
      const item = await addListItem(LISTS.marketItems, fields);
      cache.marketItems.push(item);
    }
    closeModal('modal-market-item-edit');
    _renderManageItemsList();
    renderMarketAnalysis();
    // After saving, also pull current BSC price from Square if linked
    await maybeSyncBscPriceFromSquare(fields, id || (cache.marketItems[cache.marketItems.length-1]?.id));
    toast('ok','✓ Item saved');
  } catch (e) { toast('err','Save failed: '+e.message); }
}

async function deleteMarketItem(id, name) {
  if (!confirm(`Delete "${name}" and ALL price rows for it?`)) return;
  const it = (cache.marketItems || []).find(x => x.id === id);
  if (!it) return;
  const key = _maItemKey(it);
  try {
    await deleteListItem(LISTS.marketItems, id);
    cache.marketItems = cache.marketItems.filter(r => r.id !== id);
    const orphans = cache.marketPrices.filter(p => p.ItemKey === key);
    for (const p of orphans) {
      await deleteListItem(LISTS.marketPrices, p.id).catch(()=>{});
    }
    cache.marketPrices = cache.marketPrices.filter(p => p.ItemKey !== key);
    _renderManageItemsList();
    renderMarketAnalysis();
    toast('ok','✓ Deleted');
  } catch (e) { toast('err','Delete failed: '+e.message); }
}

// ── Pull BSC's current price from Square when an item is linked ──
// Writes a single BSC price row (today's date) for the (item, BSC) cell
// if there isn't already one for today. Idempotent.
async function maybeSyncBscPriceFromSquare(fields, itemRecordId) {
  if (!fields.SquareKind || !fields.SquareRefId) return;
  let price = null;
  if (fields.SquareKind === 'item') {
    const m = (cache.menu || []).find(x => x.SquareId === fields.SquareRefId);
    if (m && m.Price != null) price = parseFloat(m.Price);
  } else if (fields.SquareKind === 'modifier') {
    const m = (cache.squareModifiers || []).find(x => x.id === fields.SquareRefId);
    if (m && m.price != null) price = m.price;
  }
  if (price == null) return;
  const itemKey = (fields.Size ? `${fields.Title} ${fields.Size}` : fields.Title).trim();
  const today = new Date().toISOString().slice(0,10);
  // Don't double-write if a BSC price already exists for today
  const dup = (cache.marketPrices || []).some(p =>
    p.ItemKey === itemKey && p.Competitor === 'BSC' &&
    (p.SurveyDate||'').slice(0,10) === today
  );
  if (dup) return;
  const row = {
    Title: `${itemKey} | BSC | ${today}`,
    ItemKey: itemKey,
    Competitor: 'BSC',
    Price: price,
    SurveyDate: today + 'T00:00:00Z',
    Notes: 'Auto-synced from Square',
    Source: 'square-sync'
  };
  try {
    const created = await addListItem(LISTS.marketPrices, row);
    cache.marketPrices.push(created);
  } catch (e) { console.warn('[maybeSyncBscPriceFromSquare] failed:', e); }
}

// ── Refresh BSC prices for all linked items (manual button) ──────
async function refreshAllBscPrices() {
  if (!isOwner()) return;
  const btn = document.getElementById('ma-refresh-bsc-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  try {
    // Make sure modifier cache is hot
    if (typeof syncSquareModifiers === 'function') await syncSquareModifiers();
    let n = 0;
    for (const it of (cache.marketItems || [])) {
      const before = (cache.marketPrices || []).length;
      await maybeSyncBscPriceFromSquare(it, it.id);
      if ((cache.marketPrices || []).length > before) n++;
    }
    toast('ok', n ? `✓ Refreshed ${n} BSC price${n!==1?'s':''}` : 'BSC prices already up to date for today');
    renderMarketAnalysis();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh BSC prices from Square'; }
  }
}

// ── Spreadsheet importer ─────────────────────────────────────────
// Parses the Summary sheet of the Menu Comps spreadsheet. Expected
// shape: row 5 is header (col A=size, col B=item, cols C+ = competitors;
// "BSC YYYY" columns are treated as historical BSC entries); rows 6+
// are item rows. We use SheetJS (xlsx) loaded from CDN on demand.
async function openMarketImport() {
  if (!isOwner()) return;
  _maImportFile = null;
  _maImportPlan = null;
  document.getElementById('mi-file-input').value = '';
  document.getElementById('mi-stage-upload').style.display = '';
  document.getElementById('mi-stage-confirm').style.display = 'none';
  document.getElementById('mi-stage-result').style.display = 'none';
  openModal('modal-market-import');
}

async function _ensureSheetJS() {
  if (window.XLSX) return window.XLSX;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load xlsx library'));
    document.head.appendChild(s);
  });
  return window.XLSX;
}

async function onMarketImportFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const XLSX = await _ensureSheetJS();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:'array' });
    const ws = wb.Sheets['Summary'] || wb.Sheets[wb.SheetNames[0]];
    if (!ws) { toast('err','No sheets found'); return; }
    // Convert to AoA, header:1 to keep blank cells
    const aoa = XLSX.utils.sheet_to_json(ws, { header:1, defval:null });
    // Find header row — first row whose col A or B is non-null and has another
    // non-null in cols C+. Falls back to row 5 (index 4) which matches the source.
    let headerIdx = aoa.findIndex((r, i) => i >= 3 && r && (r[0] || r[1]) === null && r.some((v,vi) => vi >= 2 && v));
    if (headerIdx < 0) headerIdx = 4;
    const header = aoa[headerIdx] || [];
    const dataRows = aoa.slice(headerIdx + 1).filter(r => r && (r[0] || r[1]));
    _maImportFile = { headerIdx, header, rows: dataRows };
    _renderImportConfirm();
    document.getElementById('mi-stage-upload').style.display = 'none';
    document.getElementById('mi-stage-confirm').style.display = '';
  } catch (e) {
    toast('err','Parse failed: '+e.message);
  }
}

function _renderImportConfirm() {
  if (!_maImportFile) return;
  const { header, rows } = _maImportFile;
  // Competitor columns = anything in cols 2+ that has a string header
  const compCols = [];
  for (let i = 2; i < header.length; i++) {
    if (header[i] != null && String(header[i]).trim()) {
      compCols.push({ idx:i, label:String(header[i]).trim() });
    }
  }
  // Existing competitors
  const existingComps = (cache.marketCompetitors || []).map(c => c.Title);
  const compRowsHtml = compCols.map(col => {
    const isBSC = /^BSC\s*\d{4}$/i.test(col.label);
    const yearMatch = col.label.match(/(\d{4})/);
    const dateGuess = yearMatch ? `${yearMatch[1]}-01-01` : '';
    const matchOption = existingComps.find(e => e.toLowerCase() === col.label.toLowerCase());
    return `
      <tr>
        <td style="padding:4px 8px;font-size:12px;font-weight:600;">${escHtml(col.label)}</td>
        <td style="padding:4px 8px;">
          <select class="field-input mi-comp-action" data-idx="${col.idx}" style="font-size:12px;padding:3px 6px;" onchange="_renderImportPreviewCount()">
            <option value="skip">Skip</option>
            ${isBSC
              ? `<option value="bsc-history" selected>BSC historical (date ${dateGuess})</option>`
              : `<option value="map" ${matchOption?'selected':''}>Map to existing</option>
                 <option value="create" ${!matchOption?'selected':''}>Create as new competitor</option>`
            }
          </select>
        </td>
        <td style="padding:4px 8px;">
          ${isBSC
            ? `<input class="field-input mi-comp-date" data-idx="${col.idx}" value="${dateGuess}" style="font-size:12px;padding:3px 6px;width:140px;" placeholder="YYYY-MM-DD">`
            : `<select class="field-input mi-comp-target" data-idx="${col.idx}" style="font-size:12px;padding:3px 6px;">${existingComps.map(c => `<option ${c.toLowerCase()===col.label.toLowerCase()?'selected':''}>${escHtml(c)}</option>`).join('')}</select>`
          }
        </td>
      </tr>`;
  }).join('');

  // Item rows
  const existingItems = cache.marketItems || [];
  const itemRowsHtml = rows.map((r, i) => {
    const size = (r[0] != null) ? String(r[0]).trim() : '';
    const name = (r[1] != null) ? String(r[1]).trim() : '';
    if (!name) return '';
    const guessedKey = (size ? `${name} ${size}` : name).trim().toLowerCase();
    const match = existingItems.find(it => _maItemKey(it).toLowerCase() === guessedKey);
    // Guess category: modifiers if size is blank AND name matches modifier-y words
    const modWords = /(extra shot|flavor|breve|alt milk|oat milk|syrup|whip|substitute)/i;
    const isModGuess = !size && modWords.test(name);
    const catGuess = isModGuess ? 'modifier'
                   : /espresso|latte|cappuccino|macchiato|mocha|americano|cortado/i.test(name) ? 'espresso'
                   : /drip|brew|coffee/i.test(name) ? 'brewed'
                   : /iced|cold|frapp/i.test(name) ? 'cold'
                   : /tea|matcha|chai/i.test(name) ? 'tea'
                   : 'other';
    return `
      <tr>
        <td style="padding:4px 8px;font-size:12px;">
          <input type="checkbox" class="mi-item-include" data-idx="${i}" checked onchange="_renderImportPreviewCount()" style="margin-right:6px;">
        </td>
        <td style="padding:4px 8px;font-size:12px;font-weight:600;">${escHtml(name)}</td>
        <td style="padding:4px 8px;font-size:12px;color:var(--muted);">${escHtml(size||'—')}</td>
        <td style="padding:4px 8px;">
          <select class="field-input mi-item-action" data-idx="${i}" style="font-size:12px;padding:3px 6px;" onchange="_renderImportPreviewCount()">
            ${match ? `<option value="map" selected>Map to existing</option>` : ''}
            <option value="create" ${match?'':'selected'}>Create new tracked item</option>
            <option value="skip">Skip</option>
          </select>
        </td>
        <td style="padding:4px 8px;">
          <select class="field-input mi-item-cat" data-idx="${i}" style="font-size:12px;padding:3px 6px;">
            ${MARKET_CATEGORIES.map(c => `<option value="${c.key}" ${c.key===catGuess?'selected':''}>${c.label}</option>`).join('')}
          </select>
        </td>
      </tr>`;
  }).join('');

  document.getElementById('mi-comp-table-body').innerHTML = compRowsHtml || `<tr><td colspan="3" style="padding:12px;color:var(--muted);font-size:12px;">No competitor columns detected.</td></tr>`;
  document.getElementById('mi-item-table-body').innerHTML = itemRowsHtml || `<tr><td colspan="5" style="padding:12px;color:var(--muted);font-size:12px;">No item rows detected.</td></tr>`;
  document.getElementById('mi-default-date').value = '2025-12-31';
  _renderImportPreviewCount();
}

function _renderImportPreviewCount() {
  if (!_maImportFile) return;
  const { rows } = _maImportFile;
  // Read selections
  const compCols = [...document.querySelectorAll('.mi-comp-action')].map(sel => {
    const idx = parseInt(sel.dataset.idx,10);
    const action = sel.value;
    let target = '';
    let date = '';
    if (action === 'map') {
      target = document.querySelector(`.mi-comp-target[data-idx="${idx}"]`)?.value || '';
    } else if (action === 'create') {
      target = document.querySelector(`.mi-comp-target[data-idx="${idx}"]`)?.value || '';
      // For create, pull label from header row
      const lbl = _maImportFile.header[idx];
      target = String(lbl||'').trim();
    } else if (action === 'bsc-history') {
      target = 'BSC';
      date = document.querySelector(`.mi-comp-date[data-idx="${idx}"]`)?.value || '';
    }
    return { idx, action, target, date };
  });
  const itemActions = [...document.querySelectorAll('.mi-item-action')].map(sel => {
    const idx = parseInt(sel.dataset.idx,10);
    const include = document.querySelector(`.mi-item-include[data-idx="${idx}"]`)?.checked;
    const action = sel.value;
    const cat = document.querySelector(`.mi-item-cat[data-idx="${idx}"]`)?.value || 'other';
    return { idx, include, action, cat };
  });
  // Count price rows that would be inserted
  const defaultDate = document.getElementById('mi-default-date')?.value || '2025-12-31';
  let priceCount = 0, itemCreate = 0;
  for (const ia of itemActions) {
    if (!ia.include || ia.action === 'skip') continue;
    if (ia.action === 'create') itemCreate++;
    const r = rows[ia.idx];
    for (const cc of compCols) {
      if (cc.action === 'skip') continue;
      const v = r[cc.idx];
      if (v == null || v === '' || isNaN(parseFloat(v))) continue;
      priceCount++;
    }
  }
  const compCreate = compCols.filter(c => c.action === 'create').length;
  document.getElementById('mi-preview-summary').textContent =
    `Preview: ${itemCreate} new tracked item${itemCreate!==1?'s':''}, ${compCreate} new competitor${compCreate!==1?'s':''}, ${priceCount} price row${priceCount!==1?'s':''} will be created.`;
  _maImportPlan = { compCols, itemActions, defaultDate, priceCount };
}

async function confirmMarketImport() {
  if (!_maImportPlan || !_maImportFile) { toast('err','Nothing to import'); return; }
  const btn = document.getElementById('mi-confirm-btn');
  btn.disabled = true; btn.textContent = 'Importing…';
  try {
    const { compCols, itemActions, defaultDate } = _maImportPlan;
    const { rows } = _maImportFile;

    // 1) Create new competitors first so their names exist
    for (const cc of compCols) {
      if (cc.action !== 'create') continue;
      if ((cache.marketCompetitors || []).some(c => (c.Title||'').toLowerCase() === cc.target.toLowerCase())) continue;
      const created = await addListItem(LISTS.marketCompetitors, { Title: cc.target, Active:'Yes' });
      cache.marketCompetitors.push(created);
    }

    // 2) Create / map items, build map idx → {itemKey, recordId}
    const idxToItem = {};
    let displayOrder = (cache.marketItems || []).reduce((m,i)=>Math.max(m, parseFloat(i.DisplayOrder)||0), 0);
    for (const ia of itemActions) {
      if (!ia.include || ia.action === 'skip') continue;
      const r = rows[ia.idx];
      const size = (r[0] != null) ? String(r[0]).trim() : '';
      const name = (r[1] != null) ? String(r[1]).trim() : '';
      if (!name) continue;
      const key = (size ? `${name} ${size}` : name).trim();
      if (ia.action === 'map') {
        const existing = (cache.marketItems || []).find(it => _maItemKey(it).toLowerCase() === key.toLowerCase());
        if (existing) idxToItem[ia.idx] = { key: _maItemKey(existing), id: existing.id };
        else continue; // shouldn't happen
      } else {
        displayOrder += 10;
        const fields = {
          Title: name,
          Size: size,
          Category: ia.cat,
          SquareKind: '',
          SquareRefId: '',
          DisplayOrder: displayOrder,
          Active: 'Yes'
        };
        const created = await addListItem(LISTS.marketItems, fields);
        cache.marketItems.push(created);
        idxToItem[ia.idx] = { key, id: created.id };
      }
    }

    // 3) Write price rows
    let written = 0;
    for (const ia of itemActions) {
      if (!ia.include || ia.action === 'skip') continue;
      const dest = idxToItem[ia.idx];
      if (!dest) continue;
      const r = rows[ia.idx];
      for (const cc of compCols) {
        if (cc.action === 'skip') continue;
        const v = r[cc.idx];
        if (v == null || v === '' || isNaN(parseFloat(v))) continue;
        const price = parseFloat(v);
        const date = (cc.action === 'bsc-history') ? cc.date : defaultDate;
        const competitor = cc.target || '';
        if (!competitor) continue;
        const fields = {
          Title: `${dest.key} | ${competitor} | ${date}`,
          ItemKey: dest.key,
          Competitor: competitor,
          Price: price,
          SurveyDate: date + 'T00:00:00Z',
          Notes: '',
          Source: 'import'
        };
        try {
          const created = await addListItem(LISTS.marketPrices, fields);
          cache.marketPrices.push(created);
          written++;
        } catch (e) {
          console.warn('Import row failed:', e);
        }
      }
    }
    document.getElementById('mi-stage-confirm').style.display = 'none';
    document.getElementById('mi-stage-result').style.display = '';
    document.getElementById('mi-result-summary').innerHTML =
      `<div style="font-size:14px;color:var(--dark-blue);"><b>${written}</b> price rows imported.</div>`;
    renderMarketAnalysis();
    toast('ok',`✓ Imported ${written} prices`);
  } catch (e) {
    toast('err','Import failed: '+e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Import';
  }
}
