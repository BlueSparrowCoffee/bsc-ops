/* ================================================================
 * BSC Ops — prices.js (PR 28)
 *
 * Event-based inventory price-change tracking + visual roll-up.
 *
 * Data flow:
 *   saveInventoryItem (js/inventory-form.js) reads the prior
 *   CostPerCase, then calls recordPriceChange() after the SP write
 *   lands. recordPriceChange appends to BSC_PriceHistory and pushes
 *   the row into cache.priceHistory so the chart updates without a
 *   refetch.
 *
 * UI:
 *   - openPriceHistoryFor(itemId) — modal with full line chart +
 *     full change log; opened from the inventory edit modal's
 *     "📈 History" button.
 *   - renderPrices() — sidebar Prices page; sortable table of all
 *     consumable items showing current cost, % change vs first
 *     recorded price, sparkline, change count. Row click opens the
 *     per-item modal.
 *
 * Lists touched:    BSC_PriceHistory (write/read), BSC_Inventory (read)
 * Depends on:       state.js, constants.js, utils.js, graph.js
 * ================================================================ */

let _pricesSort = { col: 'absDelta', dir: -1 }; // default: largest absolute change first

// ── Core helpers ────────────────────────────────────────────────
// Soft-fail by design: a failed history write must NOT block the
// user's primary save. We log + continue so the inventory edit
// still completes successfully.
async function recordPriceChange({ itemId, itemName, listKey = 'inventory', field = 'CostPerCase', oldVal, newVal, source = 'manual' }) {
  const oNum = (oldVal == null || oldVal === '') ? null : parseFloat(oldVal);
  const nNum = (newVal == null || newVal === '') ? null : parseFloat(newVal);
  if (oNum != null && nNum != null && oNum === nNum) return;
  if (oNum == null && nNum == null) return;
  try {
    const isoNow = new Date().toISOString();
    const fields = {
      Title:       `${(itemName || itemId)} ${isoNow}`.slice(0, 255),
      ItemId:      String(itemId),
      ItemName:    itemName || '',
      ItemListKey: listKey,
      Field:       field,
      ChangedBy:   currentUser?.name || currentUser?.username || '',
      ChangedAt:   isoNow,
      Source:      source
    };
    if (oNum != null) fields.OldValue = oNum;
    if (nNum != null) fields.NewValue = nNum;
    const rec = await addListItem(LISTS.priceHistory, fields);
    cache.priceHistory = cache.priceHistory || [];
    cache.priceHistory.push(rec);
    if (typeof renderPrices === 'function' && document.getElementById('page-prices')?.classList.contains('active')) {
      renderPrices();
    }
  } catch (e) {
    console.warn('[price history] write failed:', e?.message || e);
  }
}

// Returns history rows for an item, oldest → newest.
function getPriceHistoryFor(itemId, field = 'CostPerCase') {
  return (cache.priceHistory || [])
    .filter(r => String(r.ItemId) === String(itemId) && r.Field === field)
    .sort((a, b) => new Date(a.ChangedAt) - new Date(b.ChangedAt));
}

// ── Per-item modal chart ────────────────────────────────────────
// Builds the modal overlay on first call; subsequent opens just
// re-populate it. Mounted under document.body so it floats above
// the inventory edit modal (z-index inherits from .modal-overlay).
function openPriceHistoryFor(itemId) {
  const item = (cache.inventory || []).find(i => String(i.id) === String(itemId));
  if (!item) { toast('err', 'Item not found'); return; }
  const rows = getPriceHistoryFor(itemId, 'CostPerCase');
  const itemName = item.ItemName || item.Title || 'Item';
  const current  = rows.length ? Number(rows[rows.length-1].NewValue) : (item.CostPerCase != null ? Number(item.CostPerCase) : null);

  let overlay = document.getElementById('modal-price-history');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal-price-history';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="modal" style="max-width:760px;">
      <div class="modal-header">
        <div class="modal-title">📈 ${escHtml(itemName)} — Cost / Case</div>
        <button class="modal-close" aria-label="Close" onclick="closeModal('modal-price-history')">×</button>
      </div>
      <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:12px;">
        <div style="font-family:var(--mono);font-size:24px;font-weight:600;color:var(--ink);">${current != null ? '$'+current.toFixed(2) : '—'}</div>
        <div style="font-size:12px;color:var(--muted);">${rows.length === 0 ? 'No history yet — first price change will appear here.' : `${rows.length} change${rows.length===1?'':'s'} recorded`}</div>
      </div>
      <div id="ph-chart" style="height:260px;background:var(--bg-card-soft);border-radius:8px;padding:8px;"></div>
      <div id="ph-table" style="margin-top:14px;max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;"></div>
    </div>`;
  openModal('modal-price-history');
  document.getElementById('ph-chart').innerHTML = renderPriceLineSVG(rows);
  document.getElementById('ph-table').innerHTML = rows.length ? renderPriceTableHTML(rows) : '';
}

// Inline SVG line chart. Empty rows → empty-state message.
function renderPriceLineSVG(rows, { width = 700, height = 260, padX = 56, padY = 22 } = {}) {
  if (!rows.length) {
    return `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:var(--muted);">No price history yet</div>`;
  }
  const innerW = width - padX*2, innerH = height - padY*2;
  const xs = rows.map(r => +new Date(r.ChangedAt));
  const ys = rows.map(r => Number(r.NewValue));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yRaw = [...ys, ...rows.map(r => r.OldValue != null ? Number(r.OldValue) : Number(r.NewValue))];
  const yLo = Math.min(...yRaw), yHi = Math.max(...yRaw);
  // Pad y-range by 10% so the line doesn't kiss the top/bottom
  const yPad = (yHi - yLo) * 0.1 || (yHi * 0.1) || 1;
  const yMin = Math.max(0, yLo - yPad), yMax = yHi + yPad;
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;
  const xScale = (x) => padX + (innerW * (x - xMin) / xSpan);
  const yScale = (y) => padY + innerH - (innerH * (y - yMin) / ySpan);
  const points = rows.map(r => `${xScale(+new Date(r.ChangedAt)).toFixed(1)},${yScale(Number(r.NewValue)).toFixed(1)}`).join(' ');

  // Y-axis ticks (4 evenly spaced)
  const yTicks = [0, 1, 2, 3].map(i => yMin + (yMax - yMin) * (i / 3));
  const yTickHtml = yTicks.map(t => `
    <line x1="${padX}" x2="${width-padX/2}" y1="${yScale(t).toFixed(1)}" y2="${yScale(t).toFixed(1)}" stroke="rgba(2,61,74,0.08)" stroke-width="1"/>
    <text x="${padX-8}" y="${(yScale(t)+4).toFixed(1)}" text-anchor="end" font-family="var(--mono)" font-size="10" fill="#6b8a92">$${t.toFixed(2)}</text>
  `).join('');

  // X-axis labels — first / mid / last
  const fmtDate = (ms) => { const d = new Date(ms); return `${d.getMonth()+1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`; };
  const xLabelHtml = `
    <text x="${padX}" y="${height-6}" text-anchor="start" font-family="var(--mono)" font-size="10" fill="#6b8a92">${fmtDate(xMin)}</text>
    ${xMax !== xMin ? `<text x="${(width/2).toFixed(1)}" y="${height-6}" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="#6b8a92">${fmtDate((xMin+xMax)/2)}</text>` : ''}
    ${xMax !== xMin ? `<text x="${width-padX/2}" y="${height-6}" text-anchor="end" font-family="var(--mono)" font-size="10" fill="#6b8a92">${fmtDate(xMax)}</text>` : ''}
  `;

  // Dots — gold filled, navy outline
  const dots = rows.map(r => {
    const x = xScale(+new Date(r.ChangedAt));
    const y = yScale(Number(r.NewValue));
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="#c9a76d" stroke="#023d4a" stroke-width="1.2"><title>$${Number(r.NewValue).toFixed(2)} — ${fmtDate(+new Date(r.ChangedAt))}</title></circle>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block;">
      ${yTickHtml}
      ${rows.length > 1 ? `<polyline fill="none" stroke="#023d4a" stroke-width="2" points="${points}"/>` : ''}
      ${dots}
      ${xLabelHtml}
    </svg>`;
}

function renderPriceTableHTML(rows) {
  const sorted = [...rows].reverse(); // newest first
  const cells = sorted.map(r => {
    const d = new Date(r.ChangedAt);
    const date = `${d.getMonth()+1}/${d.getDate()}/${String(d.getFullYear()).slice(2)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const old = r.OldValue != null ? `$${Number(r.OldValue).toFixed(2)}` : '—';
    const nu  = r.NewValue != null ? `$${Number(r.NewValue).toFixed(2)}` : '—';
    let pill = '';
    if (r.OldValue != null && r.NewValue != null) {
      const delta = Number(r.NewValue) - Number(r.OldValue);
      const cls = delta > 0 ? 'badge-red' : delta < 0 ? 'badge-green' : 'badge-gray';
      pill = `<span class="badge ${cls}" style="font-size:10px;font-family:var(--mono);">${delta > 0 ? '+' : ''}$${delta.toFixed(2)}</span>`;
    } else if (r.NewValue != null && r.OldValue == null) {
      pill = `<span class="badge badge-gray" style="font-size:10px;">initial</span>`;
    }
    return `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:6px 10px;font-family:var(--mono);font-size:11px;white-space:nowrap;">${escHtml(date)}</td>
      <td style="padding:6px 10px;font-family:var(--mono);font-size:12px;color:var(--muted);">${old}</td>
      <td style="padding:6px 10px;font-family:var(--mono);font-size:12px;font-weight:600;">${nu}</td>
      <td style="padding:6px 10px;">${pill}</td>
      <td style="padding:6px 10px;font-size:11px;color:var(--muted);">${escHtml(r.ChangedBy||'')}</td>
      <td style="padding:6px 10px;font-size:11px;color:var(--muted);">${escHtml(r.Source||'')}</td>
    </tr>`;
  }).join('');
  return `
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead style="background:var(--bg-card-soft);text-align:left;position:sticky;top:0;">
        <tr>
          <th style="padding:8px 10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-size:10px;">When</th>
          <th style="padding:8px 10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-size:10px;">Old</th>
          <th style="padding:8px 10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-size:10px;">New</th>
          <th style="padding:8px 10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-size:10px;">Δ</th>
          <th style="padding:8px 10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-size:10px;">By</th>
          <th style="padding:8px 10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-size:10px;">Source</th>
        </tr>
      </thead>
      <tbody>${cells}</tbody>
    </table>`;
}

// ── Sparkline (tiny inline SVG for table rows) ──────────────────
function renderSparkline(rows, current, { width = 110, height = 28 } = {}) {
  // Build a series including the current price as the final point so
  // the sparkline reflects the live cache value (post any pending
  // history write that may not have landed yet).
  const series = rows.map(r => Number(r.NewValue));
  if (current != null && (!series.length || series[series.length-1] !== current)) series.push(current);
  if (series.length < 2) {
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><line x1="0" x2="${width}" y1="${height/2}" y2="${height/2}" stroke="rgba(2,61,74,0.18)" stroke-width="1" stroke-dasharray="3 3"/></svg>`;
  }
  const yMin = Math.min(...series), yMax = Math.max(...series);
  const ySpan = yMax - yMin || 1;
  const dx = width / (series.length - 1);
  const points = series.map((v, i) => {
    const x = (i * dx).toFixed(1);
    const y = (height - 2 - ((v - yMin) / ySpan) * (height - 4)).toFixed(1);
    return `${x},${y}`;
  }).join(' ');
  const trendUp = series[series.length-1] > series[0];
  const stroke = trendUp ? '#ad3a26' : series[series.length-1] < series[0] ? '#1f7a3a' : '#6b8a92';
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><polyline fill="none" stroke="${stroke}" stroke-width="1.5" points="${points}"/></svg>`;
}

// ── Roll-up page ────────────────────────────────────────────────
function renderPrices() {
  const container = document.getElementById('prices-container');
  if (!container) return;
  const items = (cache.inventory || []).filter(i => !i.Archived);
  const search = (document.getElementById('prices-search')?.value || '').toLowerCase().trim();

  // Build per-item rows with stats
  let rows = items.map(i => {
    const history = getPriceHistoryFor(i.id, 'CostPerCase');
    const current = i.CostPerCase != null ? Number(i.CostPerCase) : (history.length ? Number(history[history.length-1].NewValue) : null);
    const initial = history.length ? Number(history[0].OldValue ?? history[0].NewValue) : current;
    const absDelta = (current != null && initial != null) ? (current - initial) : null;
    const pctDelta = (current != null && initial != null && initial !== 0) ? ((current - initial) / initial * 100) : null;
    return { i, history, current, initial, absDelta, pctDelta, name: (i.ItemName || i.Title || ''), supplier: (i.Supplier || '') };
  }).filter(r => r.current != null);

  if (search) {
    rows = rows.filter(r => r.name.toLowerCase().includes(search) || r.supplier.toLowerCase().includes(search));
  }

  // Sort
  const dir = _pricesSort.dir;
  rows.sort((a, b) => {
    const col = _pricesSort.col;
    let av, bv;
    switch (col) {
      case 'name':     av = a.name.toLowerCase(); bv = b.name.toLowerCase(); return av < bv ? -dir : av > bv ? dir : 0;
      case 'supplier': av = a.supplier.toLowerCase(); bv = b.supplier.toLowerCase(); return av < bv ? -dir : av > bv ? dir : 0;
      case 'current':  av = a.current ?? 0; bv = b.current ?? 0; return (av - bv) * dir;
      case 'pctDelta': av = a.pctDelta ?? 0; bv = b.pctDelta ?? 0; return (av - bv) * dir;
      case 'changes':  av = a.history.length; bv = b.history.length; return (av - bv) * dir;
      case 'absDelta':
      default:         av = Math.abs(a.absDelta ?? 0); bv = Math.abs(b.absDelta ?? 0); return (av - bv) * dir;
    }
  });

  // Top-line stats
  const totalChanges = rows.reduce((s, r) => s + r.history.length, 0);
  const itemsWithHistory = rows.filter(r => r.history.length > 0).length;
  const topMover = [...rows].filter(r => r.absDelta != null).sort((a,b) => Math.abs(b.absDelta) - Math.abs(a.absDelta))[0];

  const sortIcon = (col) => _pricesSort.col === col ? (_pricesSort.dir === 1 ? ' ↑' : ' ↓') : '';

  const tableRows = rows.map(r => {
    const pctPill = r.pctDelta != null
      ? `<span class="badge ${r.pctDelta > 0 ? 'badge-red' : r.pctDelta < 0 ? 'badge-green' : 'badge-gray'}" style="font-size:10px;font-family:var(--mono);">${r.pctDelta > 0 ? '+' : ''}${r.pctDelta.toFixed(1)}%</span>`
      : `<span class="badge badge-gray" style="font-size:10px;">—</span>`;
    const deltaPill = r.absDelta != null
      ? `<span style="font-family:var(--mono);font-size:11px;color:${r.absDelta > 0 ? 'var(--bad)' : r.absDelta < 0 ? 'var(--good)' : 'var(--muted)'};">${r.absDelta > 0 ? '+' : ''}$${r.absDelta.toFixed(2)}</span>`
      : '<span style="color:var(--muted);">—</span>';
    return `<tr onclick="openPriceHistoryFor('${escHtml(r.i.id)}')" style="cursor:pointer;border-bottom:1px solid var(--border);">
      <td style="padding:9px 12px;">
        <div style="font-weight:600;font-size:13px;">${escHtml(r.name)}</div>
        ${r.supplier ? `<div style="font-size:11px;color:var(--muted);">${escHtml(r.supplier)}</div>` : ''}
      </td>
      <td style="padding:9px 12px;font-family:var(--mono);font-size:13px;font-weight:600;text-align:right;">$${r.current.toFixed(2)}</td>
      <td style="padding:9px 12px;text-align:right;">${deltaPill}</td>
      <td style="padding:9px 12px;text-align:right;">${pctPill}</td>
      <td style="padding:9px 12px;text-align:center;">${renderSparkline(r.history, r.current)}</td>
      <td style="padding:9px 12px;text-align:right;font-family:var(--mono);font-size:11px;color:var(--muted);">${r.history.length}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="cards-grid" style="grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
      <div class="card" style="padding:14px 18px;">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">Items tracked</div>
        <div style="font-family:var(--mono);font-size:22px;font-weight:600;color:var(--ink);">${rows.length}</div>
      </div>
      <div class="card" style="padding:14px 18px;">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">With recorded history</div>
        <div style="font-family:var(--mono);font-size:22px;font-weight:600;color:var(--ink);">${itemsWithHistory} <span style="font-size:13px;color:var(--muted);">/ ${totalChanges} change${totalChanges===1?'':'s'}</span></div>
      </div>
      <div class="card" style="padding:14px 18px;">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">Top mover</div>
        <div style="font-family:var(--mono);font-size:14px;font-weight:600;color:var(--ink);">${topMover ? `${escHtml(topMover.name)} <span style="color:${topMover.absDelta > 0 ? 'var(--bad)' : 'var(--good)'};">(${topMover.absDelta > 0 ? '+' : ''}$${topMover.absDelta.toFixed(2)})</span>` : '—'}</div>
      </div>
    </div>
    ${rows.length === 0
      ? `<div class="card" style="padding:40px;text-align:center;color:var(--muted);">No items match the current filter.</div>`
      : `<div class="card" style="padding:0;overflow:hidden;">
          <table style="width:100%;border-collapse:collapse;">
            <thead style="background:var(--bg-card-soft);text-align:left;">
              <tr>
                <th onclick="sortPricesBy('name')"     style="padding:10px 12px;cursor:pointer;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Item${sortIcon('name')}</th>
                <th onclick="sortPricesBy('current')"  style="padding:10px 12px;cursor:pointer;text-align:right;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Current${sortIcon('current')}</th>
                <th onclick="sortPricesBy('absDelta')" style="padding:10px 12px;cursor:pointer;text-align:right;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Δ $${sortIcon('absDelta')}</th>
                <th onclick="sortPricesBy('pctDelta')" style="padding:10px 12px;cursor:pointer;text-align:right;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Δ %${sortIcon('pctDelta')}</th>
                <th style="padding:10px 12px;text-align:center;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Trend</th>
                <th onclick="sortPricesBy('changes')"  style="padding:10px 12px;cursor:pointer;text-align:right;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">Changes${sortIcon('changes')}</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>`}
  `;
}

function sortPricesBy(col) {
  if (_pricesSort.col === col) _pricesSort.dir = -_pricesSort.dir;
  else { _pricesSort.col = col; _pricesSort.dir = (col === 'name' || col === 'supplier') ? 1 : -1; }
  renderPrices();
}
