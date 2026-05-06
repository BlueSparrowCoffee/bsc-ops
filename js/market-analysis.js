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
 * Features: page shell, manage competitors/items, single-row edit,
 *   Survey Day batch entry, headline, per-item bar chart, heatmap,
 *   time-series chart, margin overlay, outlier review panel, change
 *   indicators, freshness coloring.
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

// Full sorted history (oldest → newest) for one (itemKey, competitor)
function _maHistoryFor(itemKey, competitor) {
  return (cache.marketPrices || [])
    .filter(r => r.ItemKey === itemKey && r.Competitor === competitor)
    .map(r => ({ ...r, _date: _maParseDate(r.SurveyDate) }))
    .filter(r => r._date)
    .sort((a,b) => a._date - b._date);
}

// Compare latest to prior survey for change indicators.
// Returns { delta, prevPrice, prevDate } or null when there's no prior.
function _maPriceChange(itemKey, competitor) {
  const h = _maHistoryFor(itemKey, competitor);
  if (h.length < 2) return null;
  const latest = h[h.length - 1];
  const prior  = h[h.length - 2];
  const delta = Number(latest.Price) - Number(prior.Price);
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.01) return null;
  return { delta, prevPrice: Number(prior.Price), prevDate: prior._date };
}

// Freshness coloring per survey date — applied to heatmap cells.
// fresh <60d (green), stale 60-180d (amber), very-stale >180d (red).
function _maFreshness(date) {
  if (!date) return null;
  const d = (typeof date === 'string') ? new Date(date) : date;
  if (isNaN(d.getTime())) return null;
  const days = (Date.now() - d.getTime()) / (24*60*60*1000);
  if (days < 60)  return { tier:'fresh',      color:'#16a34a', days };
  if (days < 180) return { tier:'stale',      color:'#d97706', days };
  return { tier:'very-stale', color:'#dc2626', days };
}

// Latest COG snapshot for a tracked item that's linked to a Square
// item variation. Snapshots come from cache.cogSnapshots (BSC_CogHistory)
// keyed by parent MenuItemId + VariationName, so we resolve the variation
// from cache.squareItemVariations first to get the parent id and the
// canonical variation name.
function _maLatestCogFor(item) {
  if (!item || item.SquareKind !== 'item' || !item.SquareRefId) return null;
  const variation = (cache.squareItemVariations || []).find(v => v.id === item.SquareRefId);
  if (!variation) return null;
  const all = (cache.cogSnapshots || []).filter(s => s.MenuItemId === variation.parentId);
  if (!all.length) return null;
  // Match the variation by name first; fall back to the tracked item's
  // Size field if the snapshot's VariationName doesn't match exactly.
  const wantName = (variation.name || '').toLowerCase();
  const wantSize = String(item.Size||'').toLowerCase();
  const matched = all.filter(s => {
    const vn = (s.VariationName||'').toLowerCase();
    return (wantName && vn === wantName) || (wantSize && vn.includes(wantSize));
  });
  const pool = matched.length ? matched : all;
  return pool
    .map(s => ({ ...s, _d: _maParseDate(s.SnapshotDate) || new Date(0) }))
    .sort((a,b) => b._d - a._d)[0];
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
  _renderMarketOutliers();
  _renderMarketCompetitorChips();
  _renderMarketItemPicker();
  _renderMarketBarChart();
  _renderMarketHeatmap();
  _renderMarketTimeSeries();
}

// ── Headline ─────────────────────────────────────────────────────
function _renderMarketHeadline() {
  const el = document.getElementById('ma-headline');
  if (!el) return;
  const items   = (cache.marketItems || []).filter(i => i.Active !== 'No');
  const comps   = (cache.marketCompetitors || []).filter(c => c.Active !== 'No').map(c => c.Title);
  const prices  = cache.marketPrices || [];
  if (!items.length || !prices.length) {
    el.innerHTML = `<span style="color:var(--muted)">Add tracked items + competitor prices to see how you compare.</span>`;
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
    el.innerHTML = `<div class="card" style="padding:32px 16px;text-align:center;color:var(--muted);font-size:13px;">No prices for "${escHtml(key)}" yet. Use <b>📅 Survey Day</b> or click a heatmap cell to add prices.</div>`;
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
    // Change indicator: ▲/▼ vs prior survey for this (item,competitor)
    const chg = _maPriceChange(key, r.name);
    const chgTxt = chg
      ? `<tspan dx="6" font-size="11" fill="${chg.delta >= 0 ? '#dc2626' : '#16a34a'}" font-weight="600">${chg.delta >= 0 ? '▲' : '▼'} ${chg.delta >= 0 ? '+' : '−'}${_maMoney(Math.abs(chg.delta))}</tspan>`
      : '';
    return `
      <g>
        <text x="${PAD_L - 8}" y="${y + ROW_H/2 + 4}" text-anchor="end" font-size="12" fill="${labelColor}" font-weight="${r.isBSC?'700':'500'}">${escHtml(r.name)}</text>
        <rect x="${PAD_L}" y="${y + 4}" width="${Math.max(2, w)}" height="${ROW_H - 8}" fill="${fill}" rx="3"></rect>
        <text x="${PAD_L + w + 6}" y="${y + ROW_H/2 + 4}" font-size="12" fill="#222" font-weight="${r.isBSC?'700':'500'}">${_maMoney(r.price)}${chgTxt}</text>
      </g>`;
  }).join('');

  // Avg reference line
  const avgLine = (avg != null) ? `
    <line x1="${xScale(avg)}" y1="${PAD_T - 2}" x2="${xScale(avg)}" y2="${PAD_T + rows.length*ROW_H + 2}" stroke="var(--dark-blue)" stroke-width="1.5" stroke-dasharray="4,4" opacity=".55"></line>
    <text x="${xScale(avg)}" y="${PAD_T + rows.length*ROW_H + 18}" text-anchor="middle" font-size="11" fill="var(--dark-blue)" opacity=".75">market avg ${_maMoney(avg)}</text>
  ` : '';

  // Margin overlay (uses cache.cogSnapshots when item is linked to a Square menu item)
  const cog = _maLatestCogFor(item);
  let marginRow = '';
  if (cog && bsc != null) {
    const cogVal = Number(cog.COG);
    if (Number.isFinite(cogVal) && cogVal > 0) {
      const bscMargin = bsc - cogVal;
      const bscMarginPct = bscMargin / bsc * 100;
      const marketMargin = (avg != null) ? (avg - cogVal) : null;
      const opportunity = (avg != null) ? (avg - bsc) : null;
      const oppTxt = (opportunity != null && Math.abs(opportunity) >= 0.05)
        ? (opportunity > 0
            ? ` · <span style="color:var(--gold);font-weight:600;">+${_maMoney(opportunity)} potential if you matched market</span>`
            : ` · <span style="color:#16a34a;font-weight:600;">${_maMoney(Math.abs(opportunity))} above market — premium captured</span>`)
        : '';
      marginRow = `
        <div style="margin-top:14px;padding:12px 14px;background:rgba(2,61,74,.05);border-radius:8px;font-size:12px;line-height:1.5;color:var(--dark-blue);">
          <span style="font-weight:700;">Margin:</span>
          BSC ${_maMoney(bsc)} · COG ${_maMoney(cogVal)} · margin ${_maMoney(bscMargin)} (${bscMarginPct.toFixed(0)}%)
          ${marketMargin != null ? `<br><span style="color:var(--muted);">Market avg ${_maMoney(avg)} → margin if matched: ${_maMoney(marketMargin)}${oppTxt}</span>` : ''}
        </div>`;
    }
  }

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
      ${marginRow}
    </div>
  `;
}

// ── Outlier review panel ─────────────────────────────────────────
// Items where BSC > 10% above market avg (potentially overpriced) or
// BSC < -15% below avg (potentially leaving money on table). Click a
// chip to focus that item in the bar chart.
function _renderMarketOutliers() {
  const el = document.getElementById('ma-outliers');
  if (!el) return;
  const items = (cache.marketItems || []).filter(i => i.Active !== 'No');
  const comps = (cache.marketCompetitors || []).filter(c => c.Active !== 'No').map(c => c.Title);
  const latest = _maLatestPriceMap(cache.marketPrices || []);

  const flags = [];
  for (const it of items) {
    const key = _maItemKey(it);
    const bsc = latest.get(`${key}||BSC`)?.Price;
    if (bsc == null) continue;
    const compPrices = comps.map(c => latest.get(`${key}||${c}`)?.Price).filter(p => p != null && p > 0);
    if (compPrices.length < 2) continue; // need at least 2 to mean anything
    const avg = compPrices.reduce((a,b)=>a+b,0) / compPrices.length;
    if (avg <= 0) return;
    const pct = (bsc - avg) / avg * 100;
    if (pct > 10) flags.push({ id:it.id, key, pct, kind:'over' });
    else if (pct < -15) flags.push({ id:it.id, key, pct, kind:'under' });
  }

  if (!flags.length) { el.style.display = 'none'; return; }
  flags.sort((a,b) => Math.abs(b.pct) - Math.abs(a.pct));

  el.style.display = '';
  el.innerHTML = `
    <div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px;">⚠ Review (${flags.length})</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;">
      ${flags.map(f => {
        const arrow = f.kind === 'over' ? '▲' : '▼';
        const bg    = f.kind === 'over' ? 'rgba(220,38,38,.10)' : 'rgba(183,139,64,.14)';
        const fg    = f.kind === 'over' ? '#991b1b' : '#7c5a1f';
        const tip   = f.kind === 'over' ? 'BSC priced above market — possible push-down opportunity' : 'BSC priced below market — possible upside';
        return `<span data-id="${escHtml(String(f.id))}" onclick="onMarketItemRowClick(this.dataset.id)" title="${escHtml(tip)}" style="display:inline-block;padding:4px 10px;background:${bg};color:${fg};border-radius:14px;font-size:12px;font-weight:600;cursor:pointer;">${arrow} ${escHtml(f.key)} ${f.pct >= 0 ? '+' : ''}${f.pct.toFixed(0)}%</span>`;
      }).join('')}
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
            const row = latest.get(`${key}||${c.Title}`);
            const p = row?.Price;
            if (p == null) {
              return `<td data-id="${it.id}" data-comp="${escHtml(c.Title)}" onclick="openMarketPriceEdit(this.dataset.id, this.dataset.comp)" style="text-align:right;padding:6px 10px;font-size:12px;color:var(--muted);cursor:pointer;">—</td>`;
            }
            // color vs BSC: green if cheaper than them, red if more expensive
            let bg = 'transparent', fg = '#222';
            if (bsc != null && p > 0) {
              const diff = (bsc - p) / p;
              if (diff <= -0.05) { bg = 'rgba(22,163,74,.12)'; fg = '#166534'; }
              else if (diff >= 0.05) { bg = 'rgba(220,38,38,.12)'; fg = '#991b1b'; }
            }
            const fresh = _maFreshness(row._date);
            const dot = fresh ? `<span title="surveyed ${Math.round(fresh.days)} days ago" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${fresh.color};margin-right:5px;vertical-align:middle;opacity:.85;"></span>` : '';
            const chg = _maPriceChange(key, c.Title);
            const chgInline = chg
              ? `<span style="font-size:10px;color:${chg.delta >= 0 ? '#dc2626' : '#16a34a'};font-weight:600;margin-left:4px;" title="vs prior survey ${_maFmtDate(chg.prevDate)}">${chg.delta >= 0 ? '▲' : '▼'}</span>`
              : '';
            return `<td data-id="${it.id}" data-comp="${escHtml(c.Title)}" onclick="openMarketPriceEdit(this.dataset.id, this.dataset.comp)" style="text-align:right;padding:6px 10px;font-size:12px;background:${bg};color:${fg};cursor:pointer;font-variant-numeric:tabular-nums;">${dot}${_maMoney(p)}${chgInline}</td>`;
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
  if (!await confirmModal({ title: 'Delete this price record?', confirmLabel: 'Delete', danger: true })) return;
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
  if (!await confirmModal({ title: `Delete "${name}"?`, body: 'All price rows for this competitor will also be deleted.\n\nThis cannot be undone.', confirmLabel: 'Delete', danger: true })) return;
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
    // Each option = a single ITEM_VARIATION (so a Latte with 12oz/16oz
    // shows two options with their own prices). SquareRefId stored on
    // BSC_MarketItems holds the variation id.
    opts = (cache.squareItemVariations || []).map(v => ({
      id:    v.id,
      label: `${v.parentName} — ${v.name}${v.price != null ? ' ('+_maMoney(v.price)+')' : ''}`,
      _sort: `${(v.parentName||'').toLowerCase()}|${(v.name||'').toLowerCase()}`
    }));
  } else if (kind === 'modifier') {
    opts = (cache.squareModifiers || []).map(m => ({
      id:    m.id,
      label: `${m.name}${m.price != null ? ' ('+_maMoney(m.price)+')' : ''}${m.listName?' — '+m.listName:''}`,
      _sort: (m.name||'').toLowerCase()
    }));
  }
  opts.sort((a,b)=>(a._sort||a.label).localeCompare(b._sort||b.label));
  if (!kind) {
    sel.innerHTML = `<option value="">— Not linked —</option>`;
    sel.disabled = true;
  } else {
    sel.disabled = false;
    // `kind` is constrained to 'item' | 'modifier' by the kind <select>,
    // but escape anyway — CodeQL flags any DOM-sourced text reinterpreted
    // as HTML, and the rule is right: don't trust the DOM.
    sel.innerHTML = `<option value="">— Pick a Square ${escHtml(kind)} —</option>` + opts.map(o => `<option value="${escHtml(String(o.id))}"${String(o.id)===String(currentId)?' selected':''}>${escHtml(String(o.label))}</option>`).join('');
  }
}
function onMarketItemSquareKindChange() {
  document.getElementById('mie-square-ref-id').value = '';
  _renderMarketSquareRefDropdown();
}
function onMarketItemSquareRefChange() {
  const sel = document.getElementById('mie-square-ref');
  const id = sel.value;
  document.getElementById('mie-square-ref-id').value = id;
  if (!id) return;
  // Auto-fill Title + Size when a variation is picked AND the title/size
  // fields are still blank (don't clobber what the user typed).
  const kind = document.getElementById('mie-square-kind').value;
  if (kind === 'item') {
    const v = (cache.squareItemVariations || []).find(x => x.id === id);
    if (!v) return;
    const titleInp = document.getElementById('mie-title');
    const sizeInp  = document.getElementById('mie-size');
    if (titleInp && !titleInp.value.trim()) titleInp.value = v.parentName || '';
    if (sizeInp  && !sizeInp.value.trim() && v.name && v.name !== 'Regular') sizeInp.value = v.name;
  }
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
  if (!await confirmModal({ title: `Delete "${name}"?`, body: 'All price rows for this item will also be deleted.', confirmLabel: 'Delete', danger: true })) return;
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
    // SquareRefId is a Square ITEM_VARIATION id — pull the variation's price
    const v = (cache.squareItemVariations || []).find(x => x.id === fields.SquareRefId);
    if (v && v.price != null) price = v.price;
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


// ── Time-series chart (collapsible) ──────────────────────────────
let _maTsExpanded = false;
function toggleMarketTimeSeries() {
  _maTsExpanded = !_maTsExpanded;
  _renderMarketTimeSeries();
}
function _renderMarketTimeSeries() {
  const wrap = document.getElementById('ma-timeseries-wrap');
  const body = document.getElementById('ma-timeseries-body');
  const arrow = document.getElementById('ma-timeseries-arrow');
  if (!wrap || !body) return;
  if (arrow) arrow.textContent = _maTsExpanded ? '▾' : '▸';
  if (!_maTsExpanded) { body.style.display = 'none'; return; }
  body.style.display = '';

  const item = (cache.marketItems || []).find(i => i.id === _maSelectedItemId);
  if (!item) {
    body.innerHTML = `<div class="card" style="padding:24px 16px;text-align:center;color:var(--muted);font-size:13px;">Pick an item above to see its price history.</div>`;
    return;
  }
  const key = _maItemKey(item);
  // Series = BSC + active competitors that have ≥1 price for this item
  const comps = ['BSC', ...(cache.marketCompetitors || []).filter(c => c.Active !== 'No').map(c => c.Title)];
  const series = comps
    .map(name => ({ name, history: _maHistoryFor(key, name) }))
    .filter(s => s.history.length);
  if (!series.length) {
    body.innerHTML = `<div class="card" style="padding:24px 16px;text-align:center;color:var(--muted);font-size:13px;">No price history yet for "${escHtml(key)}".</div>`;
    return;
  }

  // Find x range (dates) and y range (prices)
  const allDates  = series.flatMap(s => s.history.map(h => h._date.getTime()));
  const allPrices = series.flatMap(s => s.history.map(h => Number(h.Price))).filter(p => Number.isFinite(p));
  if (!allDates.length || !allPrices.length) {
    body.innerHTML = `<div class="card" style="padding:24px 16px;text-align:center;color:var(--muted);font-size:13px;">No usable history.</div>`;
    return;
  }
  let xMin = Math.min(...allDates), xMax = Math.max(...allDates);
  if (xMax === xMin) xMax = xMin + 24*60*60*1000;
  const yMinRaw = Math.min(...allPrices);
  const yMaxRaw = Math.max(...allPrices);
  const yPad = Math.max(0.5, (yMaxRaw - yMinRaw) * 0.12);
  const yMin = Math.max(0, yMinRaw - yPad), yMax = yMaxRaw + yPad;

  // SVG layout
  const VB_W = 720, VB_H = 280, PAD_L = 50, PAD_R = 18, PAD_T = 14, PAD_B = 36;
  const plotW = VB_W - PAD_L - PAD_R, plotH = VB_H - PAD_T - PAD_B;
  const xScale = t => PAD_L + ((t - xMin) / (xMax - xMin)) * plotW;
  const yScale = p => PAD_T + plotH - ((p - yMin) / (yMax - yMin)) * plotH;

  // Color palette — keep BSC gold, others pulled from a stable palette
  const COMP_PALETTE = ['#0c5772','#7c3aed','#0891b2','#65a30d','#dc2626','#a16207','#0d9488','#7e22ce','#b91c1c','#1d4ed8','#15803d','#9d174d'];
  const colorFor = (name, idx) => name === 'BSC' ? '#b78b40' : COMP_PALETTE[idx % COMP_PALETTE.length];

  // Y axis ticks
  const yStep = (yMax - yMin) > 8 ? 2 : (yMax - yMin) > 4 ? 1 : 0.5;
  const yTicks = [];
  for (let v = Math.ceil(yMin/yStep)*yStep; v <= yMax; v += yStep) yTicks.push(v);
  const yGrid = yTicks.map(v => `
    <line x1="${PAD_L}" y1="${yScale(v)}" x2="${PAD_L+plotW}" y2="${yScale(v)}" stroke="#e5e7eb" stroke-width="1"></line>
    <text x="${PAD_L-6}" y="${yScale(v)+4}" text-anchor="end" font-size="10" fill="var(--muted)">${_maMoney(v)}</text>
  `).join('');

  // X axis labels — first/last only to avoid clutter
  const fmt = t => new Date(t).toLocaleDateString('en-US',{month:'short',year:'2-digit'});
  const xLabels = `
    <text x="${PAD_L}" y="${PAD_T+plotH+18}" font-size="10" fill="var(--muted)" text-anchor="start">${escHtml(fmt(xMin))}</text>
    <text x="${PAD_L+plotW}" y="${PAD_T+plotH+18}" font-size="10" fill="var(--muted)" text-anchor="end">${escHtml(fmt(xMax))}</text>
  `;

  // Lines + dots
  let i = 0;
  const lines = series.map(s => {
    const color = colorFor(s.name, i++);
    const pts = s.history.map(h => `${xScale(h._date.getTime())},${yScale(Number(h.Price))}`).join(' ');
    const dots = s.history.map(h => `<circle cx="${xScale(h._date.getTime())}" cy="${yScale(Number(h.Price))}" r="3" fill="${color}"></circle>`).join('');
    const path = s.history.length > 1 ? `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${s.name==='BSC'?2.5:1.6}" stroke-linejoin="round" stroke-linecap="round"></polyline>` : '';
    return path + dots;
  }).join('');

  // Legend
  i = 0;
  const legend = series.map(s => {
    const color = colorFor(s.name, i++);
    return `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:12px;color:#222;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};"></span>${escHtml(s.name)}${s.name==='BSC'?' <span style="color:var(--muted);font-size:11px;">(you)</span>':''}</span>`;
  }).join('');

  body.innerHTML = `
    <div class="card" style="padding:14px 16px;">
      <div style="font-size:14px;font-weight:700;color:var(--dark-blue);margin-bottom:8px;">${escHtml(key)} — price over time</div>
      <svg viewBox="0 0 ${VB_W} ${VB_H}" style="width:100%;height:auto;display:block;">
        ${yGrid}
        ${xLabels}
        ${lines}
      </svg>
      <div style="margin-top:8px;line-height:1.8;">${legend}</div>
    </div>
  `;
}

// ── Survey Day batch entry ───────────────────────────────────────
// Pick a date + competitor → fill prices for every active tracked item
// in one form. Replaces 13+ separate edit clicks when running a survey.
//
// New mode: when called with (competitor, date), opens in EDIT mode
// pre-filled with that survey's existing prices, with both selects
// locked (so the user can't accidentally save to a different survey)
// and a Delete Survey button wired up.
function openSurveyDay(competitor, date) {
  if (!isOwner()) return;
  const isEdit = !!(competitor && date);
  // Competitor select = BSC + every active competitor
  // (include the locked one even if inactive so edit mode still resolves)
  const activeComps = (cache.marketCompetitors || []).filter(c => c.Active !== 'No').map(c => c.Title);
  const compsSet = new Set(activeComps);
  if (competitor) compsSet.add(competitor);
  const comps = [...compsSet].sort();
  const sel = document.getElementById('msd-competitor');
  sel.innerHTML = `<option value="BSC">BSC (your prices)</option>` + comps.filter(c => c !== 'BSC').map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
  if (isEdit) {
    sel.value = competitor;
    document.getElementById('msd-date').value = date;
  } else {
    sel.value = 'BSC';
    document.getElementById('msd-date').value = '';
  }
  // Lock the survey-key inputs in edit mode
  document.getElementById('msd-competitor').disabled = isEdit;
  document.getElementById('msd-date').disabled       = isEdit;
  // Title + buttons
  document.getElementById('msd-title').textContent = isEdit
    ? `📅 Edit Survey — ${competitor} · ${_maFmtDate(new Date(date+'T00:00:00'))}`
    : '📅 Survey Day';
  document.getElementById('msd-save-btn').textContent = isEdit ? 'Save Changes' : 'Save Survey';
  const delBtn = document.getElementById('msd-delete-btn');
  if (delBtn) {
    delBtn.style.display = isEdit ? '' : 'none';
    delBtn.dataset.competitor = competitor || '';
    delBtn.dataset.date       = date || '';
  }
  _renderSurveyDayBody();
  openModal('modal-market-survey-day');
}

function _renderSurveyDayBody() {
  const body = document.getElementById('msd-body');
  if (!body) return;
  const competitor = document.getElementById('msd-competitor')?.value || '';
  const date = document.getElementById('msd-date')?.value || '';
  const items = (cache.marketItems || []).filter(i => i.Active !== 'No');
  if (!items.length) {
    body.innerHTML = `<div style="padding:14px;color:var(--muted);font-size:13px;">No tracked items yet — add some first via Manage.</div>`;
    return;
  }
  // Show last known price as placeholder so user knows where they were
  const latest = _maLatestPriceMap(cache.marketPrices || []);
  // For edit mode: build a map of EXISTING rows for this (competitor, date)
  // so we can pre-fill the inputs with the survey's actual saved values.
  const exactByKey = {};
  if (competitor && date) {
    for (const r of (cache.marketPrices || [])) {
      if (r.Competitor === competitor && (r.SurveyDate||'').slice(0,10) === date) {
        exactByKey[r.ItemKey] = r;
      }
    }
  }
  // Group by category
  const groups = {};
  for (const it of items) (groups[it.Category||'other'] = groups[it.Category||'other'] || []).push(it);
  const html = MARKET_CATEGORIES.filter(c => groups[c.key]?.length).map(cat => {
    const rows = groups[cat.key]
      .sort((a,b)=>{
        const oa = parseFloat(a.DisplayOrder)||999, ob = parseFloat(b.DisplayOrder)||999;
        if (oa !== ob) return oa - ob;
        return _maItemKey(a).localeCompare(_maItemKey(b));
      })
      .map(it => {
        const key = _maItemKey(it);
        const exact = exactByKey[key];
        const last = competitor ? latest.get(`${key}||${competitor}`) : null;
        const ph = (last?.Price != null) ? `prev ${_maMoney(last.Price)}` : '';
        const valAttr   = exact ? `value="${escHtml(String(exact.Price))}"` : '';
        const notesAttr = exact ? `value="${escHtml(exact.Notes||'')}"` : '';
        return `
          <tr>
            <td style="padding:5px 8px;font-size:12px;font-weight:600;">${escHtml(key)}</td>
            <td style="padding:5px 8px;text-align:right;">
              <input type="number" step="0.01" min="0" class="field-input msd-price" data-id="${escHtml(String(it.id))}" data-key="${escHtml(key)}" ${valAttr} placeholder="${escHtml(ph)}" style="width:100px;font-size:12px;padding:3px 6px;text-align:right;">
            </td>
            <td style="padding:5px 8px;">
              <input type="text" class="field-input msd-notes" data-id="${escHtml(String(it.id))}" ${notesAttr} placeholder="notes (optional)" style="width:100%;font-size:12px;padding:3px 6px;">
            </td>
          </tr>`;
      }).join('');
    return `
      <tr><td colspan="3" style="padding:10px 8px 4px;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;">${cat.emoji} ${cat.label}</td></tr>
      ${rows}`;
  }).join('');
  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:var(--cream);">
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:var(--muted);">Item</th>
          <th style="text-align:right;padding:6px 8px;font-size:11px;color:var(--muted);">Price ($)</th>
          <th style="text-align:left;padding:6px 8px;font-size:11px;color:var(--muted);">Notes</th>
        </tr>
      </thead>
      <tbody>${html}</tbody>
    </table>
    <div style="margin-top:10px;font-size:11px;color:var(--muted);">Leave a row blank to skip it. Existing prices for this date+competitor will be overwritten.</div>
  `;
}

async function saveSurveyDay() {
  if (!isOwner()) return;
  const competitor = document.getElementById('msd-competitor').value;
  const date = document.getElementById('msd-date').value;
  if (!competitor) { toast('err','Pick a competitor'); return; }
  if (!date) { toast('err','Pick a survey date'); return; }
  const inputs = [...document.querySelectorAll('.msd-price')];
  // Build (itemKey → {price, notes})
  const entries = [];
  for (const inp of inputs) {
    const v = inp.value.trim();
    if (!v) continue;
    const price = parseFloat(v);
    if (!Number.isFinite(price) || price < 0) continue;
    const key = inp.dataset.key;
    const notes = document.querySelector(`.msd-notes[data-id="${inp.dataset.id}"]`)?.value.trim() || '';
    entries.push({ key, price, notes });
  }
  if (!entries.length) { toast('err','Nothing to save — fill at least one price'); return; }
  const btn = document.getElementById('msd-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    let written = 0, replaced = 0;
    for (const e of entries) {
      const fields = {
        Title: `${e.key} | ${competitor} | ${date}`,
        ItemKey: e.key,
        Competitor: competitor,
        Price: e.price,
        SurveyDate: date + 'T00:00:00Z',
        Notes: e.notes,
        Source: 'manual'
      };
      // Replace existing row with the same (item, competitor, date) so re-running a
      // Survey Day for the same date doesn't create duplicates.
      const dup = (cache.marketPrices || []).find(p =>
        p.ItemKey === e.key && p.Competitor === competitor &&
        (p.SurveyDate||'').slice(0,10) === date
      );
      try {
        if (dup) {
          await updateListItem(LISTS.marketPrices, dup.id, fields);
          Object.assign(dup, fields);
          replaced++;
        } else {
          const created = await addListItem(LISTS.marketPrices, fields);
          cache.marketPrices.push(created);
          written++;
        }
      } catch (err) { console.warn('survey-day save failed for', e.key, err); }
    }
    closeModal('modal-market-survey-day');
    toast('ok', `✓ ${written} new · ${replaced} updated`);
    renderMarketAnalysis();
  } finally {
    // Restore button label by re-deriving from current state
    const isEdit = document.getElementById('msd-competitor')?.disabled;
    btn.disabled = false;
    btn.textContent = isEdit ? 'Save Changes' : 'Save Survey';
  }
}

// ── Surveys list modal ───────────────────────────────────────────
// Aggregates BSC_MarketPrices by (Competitor, SurveyDate) so each
// "survey" (one Survey Day batch) appears as a single row with a count
// of priced items. Click any row → reopens Survey Day in edit mode.
function openSurveyList() {
  if (!isOwner()) return;
  _renderSurveyList();
  openModal('modal-market-survey-list');
}

function _renderSurveyList() {
  const body = document.getElementById('msl-body');
  if (!body) return;
  const rows = (cache.marketPrices || []);
  // Group by (competitor, date)
  const groups = new Map();
  for (const r of rows) {
    const date = (r.SurveyDate || '').slice(0, 10);
    if (!date || !r.Competitor) continue;
    const k = `${r.Competitor}||${date}`;
    if (!groups.has(k)) groups.set(k, { competitor: r.Competitor, date, count: 0, sources: new Set() });
    const g = groups.get(k);
    g.count++;
    if (r.Source) g.sources.add(r.Source);
  }
  const surveys = [...groups.values()].sort((a,b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date); // newest first
    return a.competitor.localeCompare(b.competitor);
  });
  if (!surveys.length) {
    body.innerHTML = `<div style="padding:18px;color:var(--muted);font-size:13px;text-align:center;">No surveys yet — start one with 📅 Survey Day.</div>`;
    return;
  }
  // Group rows under date headers for legibility
  const byDate = new Map();
  for (const s of surveys) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }
  const html = [...byDate.entries()].map(([date, items]) => {
    const niceDate = _maFmtDate(new Date(date+'T00:00:00'));
    const fresh = _maFreshness(new Date(date+'T00:00:00'));
    const dot = fresh ? `<span title="${Math.round(fresh.days)} days ago" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${fresh.color};margin-right:6px;vertical-align:middle;"></span>` : '';
    const rowsHtml = items.map(s => {
      const sources = [...s.sources].join(', ') || '—';
      return `
        <tr style="border-bottom:1px solid var(--opal);">
          <td style="padding:8px 10px;font-size:13px;font-weight:600;color:var(--dark-blue);">${escHtml(s.competitor)}</td>
          <td style="padding:8px 10px;font-size:12px;color:var(--muted);">${s.count} item${s.count!==1?'s':''}</td>
          <td style="padding:8px 10px;font-size:11px;color:var(--muted);">${escHtml(sources)}</td>
          <td style="padding:8px 10px;text-align:right;">
            <button class="btn btn-outline btn-sm" data-c="${escHtml(s.competitor)}" data-d="${escHtml(s.date)}" onclick="editSurveyFromList(this.dataset.c, this.dataset.d)">Edit</button>
          </td>
        </tr>`;
    }).join('');
    return `
      <tr><td colspan="4" style="padding:14px 10px 6px;font-size:12px;font-weight:700;color:var(--dark-blue);">${dot}${escHtml(niceDate)}</td></tr>
      ${rowsHtml}
    `;
  }).join('');
  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:var(--cream);">
          <th style="text-align:left;padding:6px 10px;font-size:11px;color:var(--muted);">Competitor</th>
          <th style="text-align:left;padding:6px 10px;font-size:11px;color:var(--muted);">Items</th>
          <th style="text-align:left;padding:6px 10px;font-size:11px;color:var(--muted);">Source</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${html}</tbody>
    </table>
  `;
}

function editSurveyFromList(competitor, date) {
  closeModal('modal-market-survey-list');
  // Small delay so the close animation doesn't clobber the open
  setTimeout(() => openSurveyDay(competitor, date), 30);
}

async function deleteCurrentSurvey() {
  if (!isOwner()) return;
  const btn = document.getElementById('msd-delete-btn');
  const competitor = btn?.dataset.competitor;
  const date = btn?.dataset.date;
  if (!competitor || !date) return;
  if (!await confirmModal({ title: 'Delete this survey?', body: `Survey for ${competitor} on ${date}. Every price row in it will be deleted.`, confirmLabel: 'Delete', danger: true })) return;
  const orphans = (cache.marketPrices || []).filter(p =>
    p.Competitor === competitor &&
    (p.SurveyDate||'').slice(0,10) === date
  );
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    for (const p of orphans) {
      await deleteListItem(LISTS.marketPrices, p.id).catch(()=>{});
    }
    cache.marketPrices = (cache.marketPrices || []).filter(p =>
      !(p.Competitor === competitor && (p.SurveyDate||'').slice(0,10) === date)
    );
    closeModal('modal-market-survey-day');
    toast('ok', `✓ Deleted ${orphans.length} price${orphans.length!==1?'s':''}`);
    renderMarketAnalysis();
  } finally {
    btn.disabled = false; btn.textContent = 'Delete Survey';
  }
}
