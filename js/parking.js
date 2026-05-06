/* ================================================================
 * BSC Ops — parking.js
 * Parking list (page-parking): staff parking permits. Owners/accounting
 * only. Backed by BSC_Parking + PARKING_STATUS_BADGE/PARKING_LOCS.
 *
 * Contents:
 *   - renderParking(query)
 *   - _parkingEditId state
 *   - openParkingForm(id)
 *   - saveParkingEntry()
 *   - deleteParkingEntry(id)
 *
 * Depends on:
 *   state.js     — cache
 *   constants.js — LISTS, PARKING_STATUS_BADGE
 *   utils.js     — escHtml, toast, openModal, closeModal, setLoading
 *   graph.js     — addListItem, updateListItem, deleteListItem
 *   auth.js      — isOwnerOrAccounting
 * ================================================================ */

function renderParking(query='') {
  if (!isOwnerOrAccounting()) return;
  const tbody  = document.getElementById('parking-body');
  const empty  = document.getElementById('parking-empty');
  const countEl = document.getElementById('parking-count');
  if (!tbody) return;

  const q         = query.toLowerCase();
  const statusF   = document.getElementById('parking-status-filter')?.value || '';
  const locF      = document.getElementById('parking-loc-filter')?.value || '';

  let rows = [...cache.parking];
  // Hide Inactive by default; only show when explicitly filtered to Inactive
  if (statusF) {
    rows = rows.filter(r => (r.ParkingStatus||'') === statusF);
  } else {
    rows = rows.filter(r => (r.ParkingStatus||'') !== 'Inactive');
  }
  if (q) rows = rows.filter(r =>
    [r.FirstName,r.LastName,r.Email].filter(Boolean).join(' ').toLowerCase().includes(q));
  // Location is comma-separated — match if any stored location includes the filter
  if (locF) rows = rows.filter(r =>
    (r.Location||'').split(',').map(l=>l.trim()).includes(locF));

  // Sort: Add first (needs action), then Active, Inactive, Remove; within each alpha
  const statusOrder = { Add:0, Active:1, Inactive:2, Remove:3 };
  rows.sort((a,b) => {
    const so = (statusOrder[a.ParkingStatus||'']??3) - (statusOrder[b.ParkingStatus||'']??3);
    if (so !== 0) return so;
    const lc = (a.LastName||'').localeCompare(b.LastName||'');
    return lc !== 0 ? lc : (a.FirstName||'').localeCompare(b.FirstName||'');
  });

  if (!rows.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    countEl.textContent = '0 entries';
    return;
  }
  empty.style.display = 'none';
  countEl.textContent = rows.length + ' entries';

  tbody.innerHTML = rows.map(r => {
    const badge = PARKING_STATUS_BADGE[r.ParkingStatus||''] || 'badge-gray';
    const locPills = (r.Location||'').split(',').map(l=>l.trim()).filter(Boolean)
      .map(l=>`<span class="badge badge-teal" style="font-size:11px">${escHtml(l)}</span>`).join(' ') || '—';
    return `<tr>
      <td class="fw">${escHtml(r.FirstName||'—')}</td>
      <td>${escHtml(r.LastName||'')}</td>
      <td style="font-size:12px"><a href="mailto:${escHtml(r.Email||'')}" style="color:var(--gold)">${escHtml(r.Email||'—')}</a></td>
      <td style="white-space:nowrap">${locPills}</td>
      <td><span class="badge ${badge}">${escHtml(r.ParkingStatus||'—')}</span></td>
      <td style="white-space:nowrap">
        <button data-id="${escHtml(r.id)}" onclick="openParkingForm(this.dataset.id)"
          style="background:none;border:none;cursor:pointer;color:var(--gold);font-size:13px;padding:2px 6px;" title="Edit">✏️</button>
        <button data-id="${escHtml(r.id)}" onclick="deleteParkingEntry(this.dataset.id)"
          style="background:none;border:none;cursor:pointer;color:var(--red);font-size:13px;padding:2px 6px;" title="Delete">🗑</button>
      </td>
    </tr>`;
  }).join('');
}

let _parkingEditId = null;

function openParkingForm(id) {
  _parkingEditId = id;
  const item = id ? cache.parking.find(r=>r.id===id) : null;
  document.getElementById('parking-modal-title').textContent = item ? 'Edit Parking Entry' : 'Add Parking Entry';
  document.getElementById('pk-first').value  = item?.FirstName || '';
  document.getElementById('pk-last').value   = item?.LastName  || '';
  document.getElementById('pk-email').value  = item?.Email     || '';
  document.getElementById('pk-status').value = item?.ParkingStatus || 'Add';
  // Populate location checkboxes
  const savedLocs = new Set((item?.Location||'').split(',').map(l=>l.trim()).filter(Boolean));
  document.querySelectorAll('.pk-loc-check').forEach(cb => {
    cb.checked = savedLocs.has(cb.value);
  });
  openModal('modal-parking');
  setTimeout(()=>document.getElementById('pk-first')?.focus(), 80);
}

async function saveParkingEntry() {
  const first = document.getElementById('pk-first').value.trim();
  const email = document.getElementById('pk-email').value.trim();
  if (!first) { toast('err','First name is required'); return; }
  if (!email) { toast('err','Email is required'); return; }
  const checkedLocs = [...document.querySelectorAll('.pk-loc-check:checked')].map(c=>c.value).join(',');
  const data = {
    Title:         first + ' ' + document.getElementById('pk-last').value.trim(),
    FirstName:     first,
    LastName:      document.getElementById('pk-last').value.trim(),
    Email:         email,
    Location:      checkedLocs,
    ParkingStatus: document.getElementById('pk-status').value,
  };
  setLoading(true,'Saving…');
  try {
    if (_parkingEditId) {
      await updateListItem(LISTS.parking, _parkingEditId, data);
      const idx = cache.parking.findIndex(r=>r.id===_parkingEditId);
      if (idx!==-1) cache.parking[idx] = {...cache.parking[idx], ...data};
      toast('ok','✓ Entry updated');
    } else {
      const item = await addListItem(LISTS.parking, data);
      cache.parking.push(item);
      toast('ok','✓ Entry added');
    }
    renderParking(document.querySelector('#page-parking .search-input')?.value||'');
    closeModal('modal-parking');
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}

async function deleteParkingEntry(id) {
  const item = cache.parking.find(r=>r.id===id);
  if (!item) return;
  if (!await confirmModal({ title: `Remove "${item.FirstName} ${item.LastName||''}"?`, body: 'They will be removed from the parking list.', confirmLabel: 'Remove', danger: true })) return;
  setLoading(true,'Deleting…');
  try {
    await deleteListItem(LISTS.parking, id);
    cache.parking = cache.parking.filter(r=>r.id!==id);
    renderParking(document.querySelector('#page-parking .search-input')?.value||'');
    toast('ok','✓ Entry removed');
  } catch(e) { toast('err','Delete failed: '+e.message); }
  finally { setLoading(false); }
}
