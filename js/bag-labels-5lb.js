/* ================================================================
 * BSC Ops — bag-labels-5lb.js
 * 5 LB bag labels — manual-entry tracker. Same per-location pattern
 * as the 12oz labels module, but with no Square integration:
 *   - StartBalance: manual entry
 *   - Adjustment:   manual entry (user types whatever was used/wasted)
 *   - EndBalance:   StartBalance − Adjustment (computed at save time)
 *
 * Per-location: BSC_<Loc>_FiveLbBagLabels (lazy-provisioned via
 * ensureList on first save). cache.fiveLbLabels holds rows for the
 * current scope, tagged with `_loc` so 'all' mode aggregates correctly.
 *
 * Depends on:
 *   - state.js (cache, currentUser, currentLocation)
 *   - constants.js (FIVE_LB_BAG_LABELS_LIST_COLS)
 *   - graph.js (ensureList, addListItem, getListItems, getSiteId)
 *   - settings.js (getLocations)
 *   - utils.js (escHtml, toast, setLoading, openModal, closeModal)
 * ================================================================ */

function fiveLbLabelsListName(loc) {
  const l = loc || currentLocation;
  if (!l || l === 'all') return null;
  return 'BSC_' + l.replace(/[\s\/\\]/g, '_') + '_FiveLbBagLabels';
}

async function loadFiveLbLabelsForLocation() {
  const siteId = await getSiteId();
  const tag = (rows, loc) => rows.map(r => ({ ...r, _loc: loc }));
  if (currentLocation === 'all') {
    const arrays = await Promise.all(
      getLocations().map(l => {
        const ln = fiveLbLabelsListName(l);
        return ln ? getListItems(siteId, ln).catch(() => []).then(rows => tag(rows, l))
                  : Promise.resolve([]);
      })
    );
    cache.fiveLbLabels = arrays.flat();
  } else {
    const ln = fiveLbLabelsListName(currentLocation);
    const rows = ln ? await getListItems(siteId, ln).catch(() => []) : [];
    cache.fiveLbLabels = tag(rows, currentLocation);
  }
}

function renderFiveLbLabelsPage() {
  const summaryBar = document.getElementById('five-lb-labels-summary-bar');
  const toolbar    = document.getElementById('five-lb-labels-toolbar');
  const wrap       = document.getElementById('five-lb-labels-history-wrap');
  if (!summaryBar || !toolbar || !wrap) return;

  const allMode = currentLocation === 'all';

  // ── Summary cards ─────────────────────────────────────────────
  let balanceNum, valueNum, lastMonthLabel;
  if (allMode) {
    const byLoc = {};
    for (const r of cache.fiveLbLabels) {
      const l = r._loc || '—';
      if (!byLoc[l]) byLoc[l] = [];
      byLoc[l].push(r);
    }
    let totalBal = 0, totalVal = 0, anyVal = false, latestOverall = null;
    for (const l of Object.keys(byLoc)) {
      const sorted = byLoc[l].sort((a,b) => (a.Month||'') > (b.Month||'') ? -1 : 1);
      const latest = sorted[0];
      if (!latest) continue;
      totalBal += parseFloat(latest.EndBalance) || 0;
      if (latest.TotalValue != null) { totalVal += parseFloat(latest.TotalValue) || 0; anyVal = true; }
      if (!latestOverall || (latest.Month||'') > (latestOverall.Month||'')) latestOverall = latest;
    }
    balanceNum     = totalBal.toLocaleString();
    valueNum       = anyVal ? '$' + totalVal.toFixed(2) : '—';
    lastMonthLabel = latestOverall ? (latestOverall.Month || '—') : 'None yet';
  } else {
    const rows = [...cache.fiveLbLabels].sort((a,b) => (a.Month||'') > (b.Month||'') ? -1 : 1);
    const latest = rows[0];
    balanceNum     = latest ? (+latest.EndBalance).toLocaleString() : '—';
    valueNum       = latest && latest.TotalValue != null ? '$' + (+latest.TotalValue).toFixed(2) : '—';
    lastMonthLabel = latest ? (latest.Month || '—') : 'None yet';
  }
  const balLabel = allMode ? 'Total Current Balance' : 'Current Balance';
  const valLabel = allMode ? 'Total Estimated Value' : 'Estimated Value';
  summaryBar.innerHTML = `
    <div class="card" style="flex:1;min-width:140px;text-align:center;padding:18px 12px;">
      <div style="font-size:26px;font-weight:700;color:var(--dark-blue)">${balanceNum}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">${balLabel}</div>
    </div>
    <div class="card" style="flex:1;min-width:140px;text-align:center;padding:18px 12px;">
      <div style="font-size:26px;font-weight:700;color:var(--gold)">${valueNum}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">${valLabel}</div>
    </div>
    <div class="card" style="flex:1;min-width:140px;text-align:center;padding:18px 12px;">
      <div style="font-size:20px;font-weight:700;color:var(--muted)">${escHtml(lastMonthLabel)}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">Last Entry</div>
    </div>`;

  // ── Toolbar ───────────────────────────────────────────────────
  if (allMode) {
    toolbar.innerHTML = `<span style="font-size:13px;color:var(--muted);">📍 Aggregate view across all locations — pick a location to add an entry.</span>`;
  } else {
    toolbar.innerHTML = `<button class="btn btn-primary" onclick="openFiveLbLabelsEntryModal()">+ Add Entry</button>`;
  }

  // ── History table ─────────────────────────────────────────────
  const rows = [...cache.fiveLbLabels].sort((a,b) => {
    const am = a.Month || '', bm = b.Month || '';
    if (am !== bm) return am > bm ? -1 : 1;
    return (a._loc || '').localeCompare(b._loc || '');
  });

  if (!rows.length) {
    wrap.innerHTML = `<div class="no-data" style="padding:24px 0;">No 5 LB label records yet${allMode ? '' : '. Click "Add Entry" to record your first entry'}.</div>`;
    return;
  }

  const headLoc = allMode ? '<th>Location</th>' : '';
  const bodyHtml = rows.map(r => {
    const locCell = allMode ? `<td>${escHtml(r._loc || '—')}</td>` : '';
    return `<tr>
      <td><b>${escHtml(r.Month||'—')}</b></td>
      ${locCell}
      <td>${r.StartBalance != null ? (+r.StartBalance).toLocaleString() : '—'}</td>
      <td>${r.Adjustment != null ? (+r.Adjustment).toLocaleString() : '—'}</td>
      <td><b>${r.EndBalance != null ? (+r.EndBalance).toLocaleString() : '—'}</b></td>
      <td>${r.CostPerLabel != null ? '$'+parseFloat(r.CostPerLabel).toFixed(4) : '—'}</td>
      <td>${r.TotalValue != null ? '$'+parseFloat(r.TotalValue).toFixed(2) : '—'}</td>
      <td class="text-hint">${escHtml(r.Notes||'')}</td>
      <td class="text-hint">${escHtml(r.ReconcileBy||'')}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>Month</th>${headLoc}<th>Start</th><th>Adjusted</th><th>End Balance</th><th>Cost/Label</th><th>Total Value</th><th>Notes</th><th>By</th>
        </tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>`;
}

function openFiveLbLabelsEntryModal() {
  if (currentLocation === 'all') { toast('err','Select a location first'); return; }
  const latest = [...cache.fiveLbLabels].sort((a,b)=>(a.Month||'')>(b.Month||'')?-1:1)[0];
  document.getElementById('five-lb-labels-balance-input').value = '';
  document.getElementById('five-lb-labels-adjustment-input').value = '';
  document.getElementById('five-lb-labels-cost-input').value =
    latest?.CostPerLabel ? parseFloat(latest.CostPerLabel).toFixed(4) : '';
  const now = new Date();
  document.getElementById('five-lb-labels-date-input').value =
    now.toLocaleDateString('en-US', {month:'long', year:'numeric'});
  document.getElementById('five-lb-labels-notes-input').value = '';
  updateFiveLbLabelsEndPreview();
  openModal('modal-5lb-labels-entry');
}

// Live-updates the "End Balance" preview line in the modal as the user types.
function updateFiveLbLabelsEndPreview() {
  const start = parseFloat(document.getElementById('five-lb-labels-balance-input').value);
  const adj   = parseFloat(document.getElementById('five-lb-labels-adjustment-input').value);
  const preview = document.getElementById('five-lb-labels-end-preview');
  if (!preview) return;
  if (isNaN(start)) { preview.textContent = 'End Balance: —'; return; }
  const end = Math.max(0, start - (isNaN(adj) ? 0 : adj));
  preview.textContent = `End Balance: ${end.toLocaleString()}`;
}

async function saveFiveLbLabelsEntry() {
  const listName = fiveLbLabelsListName(currentLocation);
  if (!listName) { toast('err','Select a location first'); return; }
  const start = parseFloat(document.getElementById('five-lb-labels-balance-input').value);
  const adjRaw = document.getElementById('five-lb-labels-adjustment-input').value;
  const adj = adjRaw === '' ? 0 : parseFloat(adjRaw);
  const cost = parseFloat(document.getElementById('five-lb-labels-cost-input').value) || 0;
  const month = document.getElementById('five-lb-labels-date-input').value.trim();
  const notes = document.getElementById('five-lb-labels-notes-input').value.trim();
  if (isNaN(start) || start < 0) { toast('err','Enter a valid starting balance'); return; }
  if (isNaN(adj) || adj < 0) { toast('err','Enter a valid adjustment (0 if none)'); return; }
  if (!month) { toast('err','Enter a month/date label'); return; }
  const end = Math.max(0, start - adj);
  setLoading(true,'Saving…');
  try {
    await ensureList(listName, FIVE_LB_BAG_LABELS_LIST_COLS);
    const fields = {
      Title: month, Month: month,
      StartBalance: start,
      Adjustment: adj,
      EndBalance: end,
      CostPerLabel: cost || null,
      TotalValue: cost > 0 ? +(end * cost).toFixed(2) : null,
      Notes: notes,
      ReconcileBy: currentUser?.name || currentUser?.username || ''
    };
    const item = await addListItem(listName, fields);
    cache.fiveLbLabels.push({ ...item, _loc: currentLocation });
    renderFiveLbLabelsPage();
    closeModal('modal-5lb-labels-entry');
    toast('ok','✓ Entry saved');
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}
