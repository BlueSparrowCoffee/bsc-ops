/* ================================================================
 * BSC Ops — pastry-sync.js
 * Pushes pastry par values from SharePoint into the vendor order
 * spreadsheet on OneDrive. Produces a flat BSC_Data table
 * (Item | Loc1 Mon … Loc1 Sun | Loc2 Mon … ) that each location
 * tab can VLOOKUP against.
 *
 * Uses the master BSC_FoodPars list (for item order + ExportName,
 * the vendor-facing label) combined with each per-location
 * BSC_<Loc>_FoodPars list (for the per-day par numbers).
 *
 * Depends on:
 *   - state.js (cache)
 *   - constants.js (PASTRY_ORDER_SHEET_URL)
 *   - graph.js (graph, getSiteId, getListItems)
 *   - utils.js (toast, openModal)
 *   - settings.js (getLocations)
 *   - foodpars.js (foodParsListName)
 * ================================================================ */

let _pastryWorkbookCache = null;

function _encodeShareUrl(url) {
  // Graph API shares endpoint requires u! + base64url(url)
  return 'u!' + btoa(url).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

async function getPastryOrderWorkbook() {
  if (_pastryWorkbookCache) return _pastryWorkbookCache;
  const encoded = _encodeShareUrl(PASTRY_ORDER_SHEET_URL);
  const item = await graph('GET', `/shares/${encoded}/driveItem`);
  _pastryWorkbookCache = {
    driveId: item.parentReference.driveId,
    itemId:  item.id,
    base:    `/drives/${item.parentReference.driveId}/items/${item.id}/workbook/worksheets`
  };
  return _pastryWorkbookCache;
}

function openPastryOrderSync() {
  document.getElementById('pastry-sync-log').textContent = 'Starting sync…\n';
  document.getElementById('pastry-sync-again-btn').style.display = 'none';
  openModal('modal-pastry-sync');
  runPastryOrderSync();
}

// Convert 1-based column number to Excel letter(s): 1→A, 26→Z, 27→AA, 29→AC
function excelCol(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

async function runPastryOrderSync() {
  const logEl   = document.getElementById('pastry-sync-log');
  const againBtn = document.getElementById('pastry-sync-again-btn');
  logEl.textContent = 'Connecting to order spreadsheet…\n';
  againBtn.style.display = 'none';
  const log = msg => { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; };

  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  try {
    const wb      = await getPastryOrderWorkbook();
    const siteId  = await getSiteId();
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
      const key        = (p.Title||'').toLowerCase().trim();          // always look up pars by internal name
      const exportName = (p.ExportName||'').trim() || p.Title || ''; // vendor-facing name in col A
      const row = [exportName];
      for (const m of locMaps) {
        const v = m[key] || {};
        for (const d of DAYS) row.push(typeof v[d]==='number' ? v[d] : (parseInt(v[d])||0));
      }
      return row;
    });

    const allRows  = [headers, ...dataRows];
    const numCols  = headers.length;           // 1 + locations.length * 7
    const lastCol  = excelCol(numCols);        // e.g. 'AC' for 4 locations

    // ── Ensure BSC_Data sheet exists ─────────────────────────────────────
    const DATA_SHEET = 'BSC_Data';
    const sheetEnc   = encodeURIComponent(DATA_SHEET);
    let sheetExists  = false;
    try {
      await graph('GET', `${wb.base}/${sheetEnc}`);
      sheetExists = true;
    } catch(_) {
      log('Creating BSC_Data tab…');
      await graph('POST', `${wb.base}/add`, { name: DATA_SHEET });
    }

    // Clear old content if sheet already existed
    if (sheetExists) {
      try {
        const used = await graph('GET', `${wb.base}/${sheetEnc}/usedRange`);
        const oldRows = (used.values||[]).length;
        const oldCols = ((used.values||[[]])[0]||[]).length;
        if (oldRows > 0) {
          await graph('POST',
            `${wb.base}/${sheetEnc}/range(address='A1:${excelCol(oldCols)}${oldRows}')/clear`, {});
        }
      } catch(_) { /* sheet was empty */ }
    }

    // Write the flat table in one call
    log(`Writing ${masterPastries.length} items × ${locations.length} locations to BSC_Data…`);
    await graph('PATCH',
      `${wb.base}/${sheetEnc}/range(address='A1:${lastCol}${allRows.length}')`,
      { values: allRows }
    );

    log(`\n✓ BSC_Data updated — ${masterPastries.length} items, ${locations.length} locations.\n`);

    // ── Print VLOOKUP formulas for the user ───────────────────────────────
    log('─── VLOOKUP formulas (paste into each location tab) ───');
    log(`Range reference: BSC_Data!$A:$${lastCol}\n`);
    locations.forEach((loc, li) => {
      const baseIdx = 2 + li * 7; // 1-based column index for Mon of this location
      log(`${loc} tab  (replace hard-coded numbers in B, C, D, E, F, G, H):`);
      DAYS.forEach((d, di) => {
        log(`  ${d}: =IFERROR(VLOOKUP($A4,BSC_Data!$A:$${lastCol},${baseIdx + di},0),0)`);
      });
      log('');
    });
    log('Note: change $A4 to match the row of your first item on each tab.');

    toast('ok', '✓ BSC_Data synced — see log for VLOOKUP formulas');
  } catch(e) {
    log(`\n✗ Error: ${e.message}`);
    toast('err', 'Sync failed: ' + e.message);
  }

  againBtn.style.display = '';
}
