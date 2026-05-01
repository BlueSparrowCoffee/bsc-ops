/* ================================================================
 * BSC Ops — vendors.js
 * Vendor list page + generic column panel infrastructure.
 *
 * Contents:
 *   - Vendor tag filter UI (getAllVendorTags, populateVendorTagFilter,
 *     renderVendorTagPills, filterVendorsByTag)
 *   - Sort state + sortVendorBy
 *   - renderVendors / filterVendors
 *   - Generic column mgmt (getHiddenCols/setHiddenCols/getColOrder/
 *     setColOrder/moveCol/buildColPanel/toggleColPanel/toggleCol)
 *     — these are used only by the vendors table today but are
 *     generic enough that future list pages can reuse them
 *   - Form (openVendorForm, vendorFieldInput, syncDaysField,
 *     addVendorMultiRow, saveVendorForm)
 *   - Archive / delete (modalArchiveVendor, modalDeleteVendor,
 *     archiveVendor, restoreVendor, deleteVendor, cascadeVendorRename)
 *   - Edit-in-place mode (toggleVendorEditMode, cancelVendorEditMode,
 *     saveAllVendors)
 *   - Global autofill block (capture-phase focus listener)
 *
 * Depends on:
 *   state.js       — cache, currentUser
 *   constants.js   — LISTS, VENDOR_FORM_FIELDS, DAYS_OF_WEEK,
 *                    DEFAULT_HIDDEN_COLS, SP_SYSTEM_FIELDS,
 *                    MODAL_FOCUS_DELAY_MS
 *   utils.js       — escHtml, toast, openModal, closeModal, setLoading
 *   graph.js       — addListItem, updateListItem, deleteListItem,
 *                    isEditableField, spFieldLabel, spCellValue
 *   auth.js        — isOwner
 *   tags.js        — tagEditorHTML, initTagEditor, getTagEditorValue
 *   inventory.js   — renderInventory, populateSelects (still in index.html)
 * ================================================================ */

// ── Tag filter UI ─────────────────────────────────────────────────
let _vendorEditId = null;

function getAllVendorTags() {
  const tags = new Set();
  cache.vendors.forEach(v => {
    (v.Tags||'').split(',').map(t=>t.trim()).filter(Boolean).forEach(t=>tags.add(t));
  });
  return [...tags].sort((a,b)=>a.localeCompare(b));
}

function populateVendorTagFilter() {
  const sel = document.getElementById('vendor-tag-filter');
  if (!sel) return;
  const current = sel.value;
  const tags = getAllVendorTags();
  sel.innerHTML = '<option value="">All Tags</option>'
    + tags.map(t=>`<option value="${escHtml(t)}" ${t===current?'selected':''}>${escHtml(t)}</option>`).join('');
}

function renderVendorTagPills(tagsStr, vendorId) {
  const tags = (tagsStr||'').split(',').map(t=>t.trim()).filter(Boolean);
  if (!tags.length) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;">${
    tags.map(t=>`<span style="display:inline-block;padding:1px 7px;border-radius:10px;background:rgba(183,139,64,.12);color:var(--gold);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;" data-tag="${escHtml(t)}" onclick="filterVendorsByTag(this.dataset.tag)">${escHtml(t)}</span>`).join('')
  }</div>`;
}

function filterVendorsByTag(tag) {
  const sel = document.getElementById('vendor-tag-filter');
  if (sel) sel.value = tag;
  renderVendors(document.querySelector('#page-vendors .search-input')?.value||'');
}

// ── Sort state ────────────────────────────────────────────────────
let _vendorSort = { col: null, dir: 1 };

function sortVendorBy(col) {
  if (_vendorSort.col === col) { _vendorSort.dir *= -1; }
  else { _vendorSort.col = col; _vendorSort.dir = 1; }
  renderVendors(document.querySelector('#page-vendors .search-input')?.value||'');
}

// ── Main render ───────────────────────────────────────────────────
function renderVendors(query='') {
  const tab = document.getElementById('vendor-tab').value;
  const tagFilter = document.getElementById('vendor-tag-filter')?.value || '';
  const thead = document.getElementById('vendor-thead');
  const tbody = document.getElementById('vendor-body');
  const countEl = document.getElementById('vendor-count');
  const q = query.toLowerCase();

  if (!cache.vendors.length) {
    thead.innerHTML=''; tbody.innerHTML='';
    document.getElementById('vendor-empty').style.display='block';
    countEl.textContent='No vendors';
    return;
  }
  document.getElementById('vendor-empty').style.display='none';

  const sample = cache.vendors[0];
  const hiddenCols = getHiddenCols('vendors');

  const isArchived = v => { const val = (v.Active||'').toString().toLowerCase(); return val==='no'||val==='false'||val==='0'; };

  let rows = cache.vendors.filter(v => {
    if (!q) return true;
    const fieldMatch = Object.entries(v).some(([k, val]) =>
      !SP_SYSTEM_FIELDS.has(k) && typeof val === 'string' && val.toLowerCase().includes(q)
    );
    const tagMatch = (v.Tags||'').split(',').some(t => t.trim().toLowerCase().includes(q));
    return fieldMatch || tagMatch;
  });
  if (tab==='active')   rows = rows.filter(v => !isArchived(v));
  else if (tab==='archived') rows = rows.filter(v =>  isArchived(v));
  // Tag filter
  if (tagFilter) rows = rows.filter(v=>(v.Tags||'').split(',').map(t=>t.trim()).includes(tagFilter));
  const _vSortCol = _vendorSort.col || 'Title';
  const _vSortDir = _vendorSort.dir;
  rows = [...rows].sort((a,b) => {
    const av = (a[_vSortCol]||'').toString().toLowerCase();
    const bv = (b[_vSortCol]||'').toString().toLowerCase();
    return av.localeCompare(bv) * _vSortDir;
  });

  // Build the full ordered field list — union cache keys with known vendor fields
  // so columns appear even if all vendor items currently have empty custom fields.
  // Tags is now included so it shows in the column-hide panel and can be reordered.
  const KNOWN_VENDOR_FIELDS = ['Title','Active','ContactPerson','Email','Phone',
    'Website','OrderMethod','OrderDays','DeliveryDays','Terms','PaymentMethod','Tags'];
  const cacheFields = Object.keys(sample).filter(k=>!SP_SYSTEM_FIELDS.has(k)&&k!=='VendorName'&&k!=='Category'&&k!=='Product'&&k!=='Split');
  const allFields = [...new Set([...cacheFields, ...KNOWN_VENDOR_FIELDS])].filter(k=>!SP_SYSTEM_FIELDS.has(k)&&k!=='VendorName'&&k!=='Category'&&k!=='Product'&&k!=='Split');
  const ordered = getColOrder('vendors', allFields);
  // Apply hidden cols — show all known fields even if currently empty
  const fields = ordered.filter(k=>!hiddenCols.has(k));

  const isArchivedTab = tab === 'archived';
  thead.innerHTML = `<tr>${fields.map(f=>`<th onclick="sortVendorBy('${f}')" class="${_vendorSort.col===f?(_vendorSort.dir===1?'sort-asc':'sort-desc'):''}"${f==='Phone'?' style="min-width:130px"':''}>${spFieldLabel(f,LISTS.vendors)}</th>`).join('')}</tr>`;

  const vendorCellInput = (f, r) => {
    const val = escHtml((r[f]??'').toString());
    if (f === 'Active') return `<select data-vfield="${f}" style="font-size:12px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;width:70px;"><option value="Yes"${r[f]==='Yes'?' selected':''}>Yes</option><option value="No"${r[f]==='No'?' selected':''}>No</option></select>`;
    return `<input data-vfield="${escHtml(f)}" value="${val}" style="font-size:12px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;width:100%;min-width:80px;box-sizing:border-box;">`;
  };

  // Tags gets a custom pill renderer + stop-propagation so clicking a pill doesn't open the row modal.
  const vendorCellDisplay = (f, r) => {
    if (f === 'Tags') return renderVendorTagPills(r.Tags, r.id);
    return spCellValue(f, r[f]??'');
  };
  const tdAttrs = (f) => f === 'Tags' ? ' onclick="event.stopPropagation()"' : '';

  tbody.innerHTML = rows.map(r=>`<tr data-gs-id="${escHtml(r.id)}"${!_vendorEditMode?` onclick="openVendorForm('${escHtml(r.id)}')" style="cursor:pointer;"`:''}>
    ${fields.map(f=>`<td${tdAttrs(f)} style="${_vendorEditMode?'padding:4px 6px;':''}">${_vendorEditMode && f !== 'Tags' ? vendorCellInput(f,r) : vendorCellDisplay(f,r)}</td>`).join('')}
  </tr>`).join('');

  countEl.textContent = rows.length+' records';
  buildColPanel('vendors', allFields);
  populateVendorTagFilter();
}

// ── Column visibility (per-list, persisted in localStorage) ───────
function getHiddenCols(listKey) {
  const storageKey = 'hiddenCols_'+listKey;
  const defaults = DEFAULT_HIDDEN_COLS[listKey] || [];
  const stored = localStorage.getItem(storageKey);
  // Always union with defaults so system/compliance fields are always hidden
  // even if localStorage was saved before they were added to defaults
  if (stored !== null) {
    try {
      const userSet = new Set(JSON.parse(stored));
      defaults.forEach(f => userSet.add(f));
      return userSet;
    } catch { return new Set(defaults); }
  }
  // First visit — apply defaults
  setHiddenCols(listKey, new Set(defaults));
  return new Set(defaults);
}
function setHiddenCols(listKey, set) {
  localStorage.setItem('hiddenCols_'+listKey, JSON.stringify([...set]));
}

// ── Column ordering (per-list, persisted in localStorage) ─────────
function getColOrder(listKey, allFields) {
  const stored = localStorage.getItem('colOrder_'+listKey);
  if (stored) {
    try {
      const arr = JSON.parse(stored);
      // merge: keep stored order for known fields, append any new ones at end
      const ordered = arr.filter(f=>allFields.includes(f));
      allFields.forEach(f=>{ if (!ordered.includes(f)) ordered.push(f); });
      return ordered;
    } catch { /* fall through */ }
  }
  return [...allFields];
}
function setColOrder(listKey, arr) {
  localStorage.setItem('colOrder_'+listKey, JSON.stringify(arr));
}
function moveCol(listKey, field, direction) {
  const allFields = _colPanelFields[listKey] || [];
  const order = getColOrder(listKey, allFields);
  const idx = order.indexOf(field);
  if (idx < 0) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= order.length) return;
  [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
  setColOrder(listKey, order);
  renderVendors(document.querySelector('#page-vendors .search-input')?.value||'');
}

function buildColPanel(listKey, allFields) {
  const panel = document.getElementById('col-panel');
  if (!panel) return;
  _colPanelFields[listKey] = allFields; // store for moveCol
  const hidden = getHiddenCols(listKey);
  const ordered = getColOrder(listKey, allFields);
  const listName = listKey === 'vendors' ? LISTS.vendors : null;
  panel.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;font-size:12px;color:var(--muted);letter-spacing:.04em">COLUMNS</div>
    ${ordered.map((f, idx) => `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
      <div style="display:flex;flex-direction:column;gap:1px;">
        <button onclick="moveCol('${listKey}','${escHtml(f)}',-1)"
          style="background:none;border:none;cursor:pointer;font-size:10px;padding:0;line-height:1;color:var(--muted);${idx===0?'opacity:.25;pointer-events:none':''}"
          title="Move up">▲</button>
        <button onclick="moveCol('${listKey}','${escHtml(f)}',1)"
          style="background:none;border:none;cursor:pointer;font-size:10px;padding:0;line-height:1;color:var(--muted);${idx===ordered.length-1?'opacity:.25;pointer-events:none':''}"
          title="Move down">▼</button>
      </div>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">
        <input type="checkbox" ${hidden.has(f)?'':'checked'} onchange="toggleCol('${listKey}','${escHtml(f)}',this.checked)" style="accent-color:var(--gold)">
        <span style="font-size:13px">${spFieldLabel(f, listName)}</span>
      </label>
    </div>`).join('')}`;
}

function toggleColPanel() {
  const p = document.getElementById('col-panel');
  p.style.display = p.style.display==='none' ? 'block' : 'none';
}
document.addEventListener('click', e=>{ const p=document.getElementById('col-panel'); if(p&&!p.contains(e.target)&&!e.target.closest('[onclick="toggleColPanel()"]')) p.style.display='none'; });

// ── Global autofill block ─────────────────────────────────────────
// Block browser/extension autofill across all dynamic inputs by
// forcing autocomplete="new-password" on focus. Capture-phase so we
// stamp the attribute before any autofill plugin sees the element.
document.addEventListener('focus', e => {
  const el = e.target;
  if (el.matches('input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea')) {
    el.setAttribute('autocomplete', 'new-password');
  }
}, true);

function toggleCol(listKey, field, visible) {
  const hidden = getHiddenCols(listKey);
  visible ? hidden.delete(field) : hidden.add(field);
  setHiddenCols(listKey, hidden);
  renderVendors(document.querySelector('#page-vendors .search-input')?.value||'');
}

// ── Form field renderer ───────────────────────────────────────────
function vendorFieldInput(key, type, options, val, item) {
  const id = 'vf_' + key;
  const v = item ? (item[key]||'') : '';
  if (type === 'select') {
    const opts = options.map(o=>`<option ${(v||val)===o?'selected':''}>${escHtml(o)}</option>`).join('');
    return `<select id="${id}" class="filter" style="width:100%"><option value="">—</option>${opts}</select>`;
  }
  if (type === 'days') {
    // comma-separated day names stored as text; rendered as checkboxes
    const selected = new Set((v||'').split(',').map(d=>d.trim()).filter(Boolean));
    return `<div id="${id}" style="display:flex;flex-wrap:wrap;gap:6px;padding:4px 0">${
      DAYS_OF_WEEK.map(d=>`<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;white-space:nowrap;">
        <input type="checkbox" class="vf-day-check" data-field="${key}" value="${d}" ${selected.has(d)?'checked':''}
          onchange="syncDaysField('${key}')" style="accent-color:var(--gold)"> ${d.slice(0,3)}
      </label>`).join('')
    }</div>`;
  }
  if (type === 'textarea') {
    return `<textarea id="${id}" rows="3" style="width:100%;padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;resize:vertical">${escHtml(v)}</textarea>`;
  }
  if (type === 'multi') {
    const values = (v||'').split('\n').map(s=>s.trim()).filter(Boolean);
    if (!values.length) values.push('');
    const inputType = key.toLowerCase().includes('email') ? 'email' : key.toLowerCase().includes('phone') ? 'tel' : 'text';
    const rows = values.map(val=>`
      <div style="display:flex;gap:5px;align-items:center;">
        <input type="${inputType}" value="${escHtml(val)}" class="vf-multi-input field-input" style="flex:1;">
        <button type="button" onclick="this.closest('div').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:20px;line-height:1;padding:0 4px;" title="Remove">×</button>
      </div>`).join('');
    return `<div id="${id}" data-type="multi" style="display:flex;flex-direction:column;gap:5px;">
      ${rows}
      <button type="button" onclick="addVendorMultiRow(this)" style="align-self:flex-start;background:none;border:none;cursor:pointer;color:var(--gold);font-size:12px;font-weight:600;padding:2px 0;margin-top:2px;">+ add another</button>
    </div>`;
  }
  return `<input id="${id}" value="${escHtml(v)}" placeholder="${spFieldLabel(key,LISTS.vendors)}">`;
}

function syncDaysField(key) {
  // Collect checked days, write comma-separated value into hidden input
  const checks = document.querySelectorAll(`.vf-day-check[data-field="${key}"]:checked`);
  const val = [...checks].map(c=>c.value).join(',');
  // We use the checkbox container as the "field" — read it back in saveVendorForm via getDaysValue
  // Store in a hidden input alongside the div
  let hidden = document.getElementById('vf_hidden_'+key);
  if (!hidden) {
    hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.id = 'vf_hidden_'+key;
    document.getElementById('vf_'+key)?.after(hidden);
  }
  hidden.value = val;
}

function addVendorMultiRow(btn) {
  const container = btn.closest('[data-type="multi"]');
  const key = (container.id||'').replace('vf_','').toLowerCase();
  const inputType = key.includes('email') ? 'email' : key.includes('phone') ? 'tel' : 'text';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:5px;align-items:center;';
  row.innerHTML = `<input type="${inputType}" class="vf-multi-input field-input" style="flex:1;"><button type="button" onclick="this.closest('div').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:20px;line-height:1;padding:0 4px;" title="Remove">×</button>`;
  btn.before(row);
  row.querySelector('input').focus();
}

// ── Open form ─────────────────────────────────────────────────────
function openVendorForm(id) {
  _vendorEditId = id;
  const item = id ? cache.vendors.find(v=>v.id===id) : null;
  document.getElementById('vendor-modal-title').textContent = item ? 'Edit Vendor' : 'Add Vendor';

  // Build ordered field list: configured fields first, then any extra SP fields not in the list
  const spFields = cache.vendors.length
    ? Object.keys(cache.vendors[0]).filter(k=>isEditableField(k, LISTS.vendors) && k !== 'Tags' && k !== 'Title')
    : [];
  const configuredKeys = new Set(VENDOR_FORM_FIELDS.map(f=>f.key));
  const extraKeys = spFields.filter(k=>!configuredKeys.has(k));

  const formFields = [
    ...VENDOR_FORM_FIELDS,
    ...extraKeys.map(k=>({ key:k, span:false }))
  ];

  document.getElementById('vendor-form-fields').innerHTML = formFields.map(f=>`
    <div class="form-group" ${f.span?'style="grid-column:1/-1"':''}>
      <label>${spFieldLabel(f.key,LISTS.vendors)}</label>
      ${vendorFieldInput(f.key, f.type, f.options, '', item)}
    </div>`).join('')
    + `<div class="form-group" style="grid-column:1/-1">
      <label>Tags</label>
      ${tagEditorHTML('vendor')}
    </div>`;

  // (days checkboxes are populated directly in vendorFieldInput — no sync needed)

  initTagEditor('vendor', item?.Tags||'');
  // Show archive/delete in footer for edit mode
  const archBtn = document.getElementById('vendor-modal-archive-btn');
  const delBtn  = document.getElementById('vendor-modal-delete-btn');
  if (item) {
    const isArchived = item.Active === 'No';
    if (archBtn) { archBtn.style.display = ''; archBtn.textContent = isArchived ? '↩ Restore' : '🗃️ Archive'; }
    if (delBtn && isOwner())  { delBtn.style.display = ''; }
  } else {
    if (archBtn) archBtn.style.display = 'none';
    if (delBtn)  delBtn.style.display  = 'none';
  }
  openModal('modal-vendor');
  setTimeout(()=>document.getElementById('vf_ContactPerson')?.querySelector('input')?.focus(), MODAL_FOCUS_DELAY_MS);
}

// ── Save / cascade / archive / delete ─────────────────────────────
async function saveVendorForm() {
  const data = {};
  // Collect all rendered vf_ inputs / selects / textareas
  document.querySelectorAll('#vendor-form-fields [id^="vf_"]').forEach(el => {
    const key = el.id.replace('vf_','');
    if (el.tagName === 'DIV' && el.dataset.type === 'multi') {
      // multi-value field — collect all inputs, join with newlines
      data[key] = [...el.querySelectorAll('.vf-multi-input')].map(i=>i.value.trim()).filter(Boolean).join('\n');
    } else if (el.tagName === 'DIV') {
      // days checkbox container — read checked state directly
      data[key] = [...el.querySelectorAll('.vf-day-check:checked')].map(c=>c.value).join(',');
    } else {
      data[el.id.replace('vf_','')] = el.value;
    }
  });
  // Only send fields defined in VENDOR_FORM_FIELDS — prevents patching deleted/unknown SP columns
  const allowedKeys = new Set(VENDOR_FORM_FIELDS.map(f=>f.key));
  Object.keys(data).forEach(k => { if (!allowedKeys.has(k)) delete data[k]; });
  data.Tags = getTagEditorValue('vendor');
  setLoading(true,'Saving vendor…');
  try {
    if (_vendorEditId) {
      const oldName = cache.vendors.find(v=>v.id===_vendorEditId)?.Title || '';
      await updateListItem(LISTS.vendors, _vendorEditId, data);
      const i = cache.vendors.findIndex(v=>v.id===_vendorEditId);
      if (i!==-1) cache.vendors[i]={...cache.vendors[i],...data};
      // Cascade name change to all inventory items that reference this vendor
      if (data.Title && data.Title !== oldName) {
        await cascadeVendorRename(oldName, data.Title);
      }
      toast('ok','✓ Vendor updated');
    } else {
      const item = await addListItem(LISTS.vendors, data);
      cache.vendors.push(item);
      toast('ok','✓ Vendor added');
    }
    renderVendors(); populateSelects(); closeModal('modal-vendor');
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}

async function cascadeVendorRename(oldName, newName) {
  const targets = [
    { cacheKey: 'inventory',      listKey: 'inventory',      field: 'Supplier' },
    { cacheKey: 'merchInventory', listKey: 'merchInventory', field: 'Supplier' },
    { cacheKey: 'equipInventory', listKey: 'equipInventory', field: 'Supplier' },
    { cacheKey: 'foodInventory',  listKey: 'foodInventory',  field: 'Supplier' },
    { cacheKey: 'groceryInventory', listKey: 'groceryInventory', field: 'Supplier' },
    // Orders reference vendors by name in the Vendor field — keep them in sync
    // so historical orders don't orphan when a vendor is renamed.
    { cacheKey: 'orders',         listKey: 'orders',         field: 'Vendor'   }
  ];
  const tasks = [];
  for (const { cacheKey, listKey, field } of targets) {
    if (!LISTS[listKey]) continue;
    for (const item of (cache[cacheKey] || [])) {
      if (item[field] === oldName) {
        item[field] = newName;
        const patch = {}; patch[field] = newName;
        tasks.push(() => updateListItem(LISTS[listKey], item.id, patch));
      }
    }
  }
  for (let i = 0; i < tasks.length; i += 8) {
    await Promise.all(tasks.slice(i, i+8).map(t => t()));
  }
  if (tasks.length) {
    renderInventory();
    if (typeof renderOrders === 'function') renderOrders();
  }
}

function modalArchiveVendor() {
  if (!_vendorEditId) return;
  const v = cache.vendors.find(v=>v.id===_vendorEditId);
  if (!v) return;
  closeModal('modal-vendor');
  v.Active === 'No' ? restoreVendor(_vendorEditId) : archiveVendor(_vendorEditId);
}
function modalDeleteVendor() {
  if (!_vendorEditId) return;
  const v = cache.vendors.find(v=>v.id===_vendorEditId);
  closeModal('modal-vendor');
  deleteVendor(_vendorEditId, v?.Title||'');
}
async function archiveVendor(id) {
  setLoading(true,'Archiving…');
  try {
    await updateListItem(LISTS.vendors, id, { Active: 'No' });
    const v = cache.vendors.find(v=>v.id===id);
    if (v) v.Active = 'No';
    renderVendors(); populateSelects();
    toast('ok','✓ Vendor archived');
  } catch(e) { toast('err','Archive failed: '+e.message); }
  finally { setLoading(false); }
}

async function restoreVendor(id) {
  setLoading(true,'Restoring…');
  try {
    await updateListItem(LISTS.vendors, id, { Active: 'Yes' });
    const v = cache.vendors.find(v=>v.id===id);
    if (v) v.Active = 'Yes';
    renderVendors(); populateSelects();
    toast('ok','✓ Vendor restored');
  } catch(e) { toast('err','Restore failed: '+e.message); }
  finally { setLoading(false); }
}

async function deleteVendor(id, name) {
  if (!confirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
  setLoading(true,'Deleting…');
  try {
    await deleteListItem(LISTS.vendors, id);
    cache.vendors = cache.vendors.filter(v => v.id !== id);
    renderVendors(); populateSelects();
    toast('ok','✓ Vendor deleted');
  } catch(e) { toast('err','Delete failed: '+e.message); }
  finally { setLoading(false); }
}


function filterVendors(q) { renderVendors(q); }
document.getElementById('vendor-tab').addEventListener('change',()=>renderVendors());

// ── Edit-in-place mode (grid editor) ──────────────────────────────
let _vendorEditMode = false;
let _vendorOriginals = {};
let _colPanelFields = {}; // listKey -> allFields, set by buildColPanel

function toggleVendorEditMode() {
  _vendorEditMode = true;
  _vendorOriginals = {};
  cache.vendors.forEach(v => { _vendorOriginals[v.id] = { ...v }; });
  document.getElementById('vendor-edit-btn').style.display   = 'none';
  document.getElementById('vendor-add-btn').style.display    = 'none';
  document.getElementById('vendor-save-btn').style.display   = '';
  document.getElementById('vendor-cancel-btn').style.display = '';
  renderVendors(document.querySelector('#page-vendors .search-input')?.value||'');
}

function cancelVendorEditMode() {
  _vendorEditMode = false;
  _vendorOriginals = {};
  document.getElementById('vendor-edit-btn').style.display   = '';
  document.getElementById('vendor-add-btn').style.display    = '';
  document.getElementById('vendor-save-btn').style.display   = 'none';
  document.getElementById('vendor-cancel-btn').style.display = 'none';
  renderVendors(document.querySelector('#page-vendors .search-input')?.value||'');
}

async function saveAllVendors() {
  const rows = document.querySelectorAll('#vendor-body tr[data-gs-id]');
  const updates = [];
  rows.forEach(row => {
    const id = row.dataset.gsId;
    const orig = _vendorOriginals[id] || {};
    const changed = {};
    row.querySelectorAll('[data-vfield]').forEach(input => {
      const field = input.dataset.vfield;
      const newVal = input.tagName === 'SELECT' ? input.value : input.value;
      const origVal = (orig[field] ?? '').toString();
      if (newVal !== origVal) changed[field] = newVal;
    });
    if (Object.keys(changed).length) updates.push({ id, changed });
  });
  if (!updates.length) { toast('ok', 'No changes'); cancelVendorEditMode(); return; }
  setLoading(true, `Saving ${updates.length} vendor${updates.length>1?'s':''}…`);
  try {
    await Promise.all(updates.map(u => updateListItem(LISTS.vendors, u.id, u.changed)));
    updates.forEach(u => {
      const v = cache.vendors.find(v => v.id === u.id);
      if (v) Object.assign(v, u.changed);
    });
    toast('ok', `✓ Saved ${updates.length} vendor${updates.length>1?'s':''}`);
    cancelVendorEditMode();
  } catch(e) { toast('err', 'Save failed: ' + e.message); }
  finally { setLoading(false); }
}
