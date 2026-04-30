/* ================================================================
 * BSC Ops — pastry-sync.js
 * Pushes pastry par values from SharePoint into the vendor order
 * spreadsheet on Google Sheets via a bound Apps Script Web App
 * (PASTRY_ORDER_SYNC_URL). Sends a flat BSC_Data table
 * (Item | Loc1 Mon … Loc1 Sun | Loc2 Mon … ) that each location
 * tab can VLOOKUP against.
 *
 * Uses the master BSC_FoodPars list (for item order + ExportName,
 * the vendor-facing label) combined with each per-location
 * BSC_<Loc>_FoodPars list (for the per-day par numbers).
 *
 * Apps Script source + deployment instructions live with the sheet
 * itself (Extensions -> Apps Script).
 *
 * Depends on:
 *   - state.js (cache)
 *   - constants.js (PASTRY_ORDER_SYNC_URL)
 *   - graph.js (getSiteId, getListItems)
 *   - utils.js (toast, openModal)
 *   - settings.js (getLocations)
 *   - foodpars.js (foodParsListName)
 * ================================================================ */

function openPastryOrderSync() {
  document.getElementById('pastry-sync-log').textContent = 'Starting sync…\n';
  document.getElementById('pastry-sync-again-btn').style.display = 'none';
  openModal('modal-pastry-sync');
  runPastryOrderSync();
}

// Convert 1-based column number to spreadsheet letter(s): 1→A, 26→Z, 27→AA, 29→AC
function excelCol(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

async function runPastryOrderSync() {
  const logEl    = document.getElementById('pastry-sync-log');
  const againBtn = document.getElementById('pastry-sync-again-btn');
  logEl.textContent = 'Building pastry par snapshot…\n';
  againBtn.style.display = 'none';
  const log = msg => { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; };

  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  try {
    const siteId    = await getSiteId();
    const locations = getLocations(); // e.g. ['Blake','Platte','Sherman','17th']

    const masterPastries = cache.foodPars
      .filter(p => p.Category === 'pastries')
      .sort((a,b) => ((a.SortOrder||999)-(b.SortOrder||999)) || (a.Title||'').localeCompare(b.Title||''));

    if (!masterPastries.length) { log('✗ No pastry items in master list.'); againBtn.style.display=''; return; }

    log(`Fetching par values for: ${locations.join(', ')}…`);

    // Fetch all location SharePoint lists in parallel
    const allLocVals = await Promise.all(
      locations.map(loc => {
        const ln = foodParsListName(loc);
        return ln ? getListItems(siteId, ln).catch(() => []) : Promise.resolve([]);
      })
    );

    // Build a value map per location: lowercase item name → row
    const locMaps = allLocVals.map(vals => {
      const m = {};
      for (const v of vals) m[(v.Title||'').toLowerCase().trim()] = v;
      return m;
    });

    // ── Build the BSC_Data table ──────────────────────────────────────────
    // Columns: Item | Blake Mon | Blake Tue | … | Blake Sun | Platte Mon | … | 17th Sun
    const headers = ['Item'];
    for (const loc of locations) for (const d of DAYS) headers.push(`${loc} ${d}`);

    const dataRows = masterPastries.map(p => {
      const key        = (p.Title||'').toLowerCase().trim();             // always look up pars by internal name
      const exportName = (p.ExportName||'').trim() || (p.Title||'').trim() || ''; // vendor-facing name in col A — trim both sides of the fallback so a stray space in BSC doesn't break VLOOKUP
      const row = [exportName];
      for (const m of locMaps) {
        const v = m[key] || {};
        for (const d of DAYS) row.push(typeof v[d]==='number' ? v[d] : (parseInt(v[d])||0));
      }
      return row;
    });

    // ── POST to Apps Script Web App ───────────────────────────────────────
    // Apps Script doPost reads e.postData.contents as a string regardless of
    // Content-Type. text/plain avoids a CORS preflight (script.google.com
    // doesn't return Access-Control-Allow-Headers).
    log(`Sending ${masterPastries.length} items × ${locations.length} locations to Google Sheet…`);
    const res = await fetch(PASTRY_ORDER_SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ headers, rows: dataRows })
    });
    if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
    const result = await res.json();
    if (!result.ok) throw new Error(result.error || 'Apps Script returned error');

    log(`\n✓ BSC_Data updated — ${result.rowsWritten} items, ${result.columns} columns.`);
    if (result.timestamp) log(`  Synced at ${new Date(result.timestamp).toLocaleString()}\n`);

    // ── Print VLOOKUP formulas for the user ───────────────────────────────
    const lastCol = excelCol(headers.length);
    log('─── VLOOKUP formulas (paste into each location tab) ───');
    log(`Range reference: BSC_Data!$A:$${lastCol}\n`);
    locations.forEach((loc, li) => {
      const baseIdx = 2 + li * 7; // 1-based column index for Mon of this location
      log(`${loc} tab  (replace hard-coded numbers in B, C, D, E, F, G, H):`);
      DAYS.forEach((d, di) => {
        log(`  ${d}: =IFERROR(VLOOKUP(TRIM($A4),BSC_Data!$A:$${lastCol},${baseIdx + di},0),0)`);
      });
      log('');
    });
    log('Note: change $A4 to match the row of your first item on each tab.');
    log('TRIM($A4) makes the lookup whitespace-tolerant — stray spaces in your label cell won\'t break it.');

    toast('ok', '✓ BSC_Data synced — see log for VLOOKUP formulas');
  } catch(e) {
    log(`\n✗ Error: ${e.message}`);
    toast('err', 'Sync failed: ' + e.message);
  }

  againBtn.style.display = '';
}
