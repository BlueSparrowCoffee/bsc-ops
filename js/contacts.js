/* ================================================================
 * BSC Ops — contacts.js
 * Maintenance-contacts page (the "Contacts" nav entry — historically
 * called maint contacts because they share the BSC_MaintenanceContacts
 * SharePoint list and the maint* function prefix).
 *
 * Contents:
 *   - maintIcon  — service-type → emoji lookup
 *   - maintFieldRow — per-field row renderer with smart type detection
 *   - maintFields — list of editable keys on a maint contact
 *   - _maintTab state + setMaintTab (active / archived tabs)
 *   - renderMaintContacts / filterMaint
 *   - toggleMaintArchive — archive or restore by creating / deleting
 *     a BSC_ContactArchive pointer row
 *   - openMaintForm / archiveMaintFromModal
 *   - saveMaintForm / deleteMaintContact
 *
 * Depends on:
 *   state.js     — cache
 *   constants.js — LISTS, MAINT_ICONS, MAINT_FORM_FIELDS, CFG,
 *                  MODAL_FOCUS_DELAY_MS
 *   utils.js     — escHtml, toast, openModal, closeModal, setLoading
 *   graph.js     — addListItem, updateListItem, deleteListItem,
 *                  isEditableField, spFieldLabel
 *   tags.js      — tagEditorHTML, initTagEditor, getTagEditorValue
 * ================================================================ */

// ── Icon + smart field rendering ──────────────────────────────────
function maintIcon(service='') {
  const s = service.toLowerCase();
  const key = Object.keys(MAINT_ICONS).find(k=>s.includes(k));
  return MAINT_ICONS[key] || '🔧';
}

// Smart field-type detection for maintenance cards
function maintFieldRow(key, val, label) {
  if (!val || val === '') return '';
  const k = (key + label).toLowerCase();
  const safe = escHtml(String(val));
  const safeLabel = escHtml(String(label));
  if (k.includes('phone') || k.includes('tel'))
    return `<div>📞 <a href="tel:${val.toString().replace(/\D/g,'')}" onclick="event.stopPropagation()">${safe}</a></div>`;
  if (k.includes('email') || k.includes('mail'))
    return `<div>✉️ <a href="mailto:${safe}" onclick="event.stopPropagation()">${safe}</a></div>`;
  if (k.includes('website') || k.includes('url') || k.includes('link')) {
    const href = /^https?:\/\//i.test(val) ? escHtml(val) : 'https://'+safe;
    return `<div>🔗 <a href="${href}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${safe}</a></div>`;
  }
  if (k.includes('contact') || k.includes('person') || k.includes('rep'))
    return `<div>👤 ${safe}</div>`;
  if (k.includes('note') || k.includes('comment') || k.includes('info'))
    return `<div style="margin-top:4px;padding:6px 10px;background:var(--cream);border-radius:6px;font-size:11px;color:var(--muted)">${safe}</div>`;
  return `<div style="color:var(--muted);font-size:12px;">${safeLabel}: ${safe}</div>`;
}

function maintFields(item) {
  // Returns editable field keys (non-system, non-Title) for this list
  if (!cache.maintContacts.length) return [];
  return Object.keys(cache.maintContacts[0]).filter(k => k !== 'Title' && isEditableField(k, LISTS.maintContacts));
}

// ── Active / archived tabs ────────────────────────────────────────
let _maintTab = 'active';
function setMaintTab(tab) {
  _maintTab = tab;
  document.getElementById('mc-tab-active').classList.toggle('active', tab==='active');
  document.getElementById('mc-tab-archived').classList.toggle('active', tab==='archived');
  renderMaintContacts(document.querySelector('#page-maint-contacts .search-input')?.value||'');
}

function renderMaintContacts(query='') {
  const grid = document.getElementById('maint-grid');
  const empty = document.getElementById('maint-empty');
  const q = query.toLowerCase();
  const archivedIds = new Set(cache.contactArchive.map(a => a.ContactId));
  let rows = cache.maintContacts.filter(m => _maintTab === 'archived' ? archivedIds.has(m.id) : !archivedIds.has(m.id));
  if (q) rows = rows.filter(m=>Object.values(m).filter(Boolean).join(' ').toLowerCase().includes(q));
  rows = [...rows].sort((a,b) => (a.Title||'').localeCompare(b.Title||''));

  if (!rows.length) {
    grid.innerHTML=''; empty.style.display='block';
    empty.textContent = _maintTab === 'archived' ? 'No archived contacts.' : 'No contacts yet — add one above.';
    document.getElementById('maint-count').textContent='';
    return;
  }
  empty.style.display='none';
  document.getElementById('maint-count').textContent = rows.length + ' contacts';

  const extraFields = maintFields(rows[0]).filter(k => k !== 'Archived');

  // Detect which field is likely "service" for the subtitle and icon
  const serviceKey = extraFields.find(k => {
    const lbl = (spFieldLabel(k, LISTS.maintContacts)||k).toLowerCase();
    return lbl.includes('service') || lbl.includes('type') || lbl.includes('category') || lbl.includes('description');
  });

  grid.innerHTML = rows.map(m => {
    const serviceVal = serviceKey ? (m[serviceKey]||'') : '';
    const icon = maintIcon(serviceVal);
    const fieldRows = extraFields
      .filter(k => k !== serviceKey)
      .map(k => {
        const label = spFieldLabel(k, LISTS.maintContacts) || k;
        return maintFieldRow(k, m[k], label);
      }).filter(Boolean).join('');

    return `<div class="card" style="cursor:pointer;" data-id="${escHtml(m.id)}" data-gs-id="${escHtml(m.id)}" onclick="openMaintForm(this.dataset.id)">
      <div class="card-title">${icon} ${escHtml(m.Title||'Unnamed')}</div>
      ${serviceVal ? `<div style="font-size:12px;color:var(--muted);margin-top:-8px;margin-bottom:10px">${escHtml(serviceVal)}</div>` : ''}
      <div style="font-size:13px;display:flex;flex-direction:column;gap:6px;">${fieldRows}</div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="recipe-edit-btn" data-id="${escHtml(m.id)}" onclick="event.stopPropagation();openMaintForm(this.dataset.id)">✏️ Edit</button>
      </div>
    </div>`;
  }).join('');
}
function filterMaint(q) { renderMaintContacts(q); }

// ── Archive / restore (uses BSC_ContactArchive pointer list) ──────
async function toggleMaintArchive(id) {
  const archivedIds = new Set(cache.contactArchive.map(a => a.ContactId));
  const isArchived = archivedIds.has(id);
  setLoading(true, isArchived ? 'Restoring…' : 'Archiving…');
  try {
    if (isArchived) {
      const archiveEntry = cache.contactArchive.find(a => a.ContactId === id);
      if (archiveEntry) {
        await deleteListItem(LISTS.contactArchive, archiveEntry.id);
        cache.contactArchive = cache.contactArchive.filter(a => a.ContactId !== id);
      }
    } else {
      const entry = await addListItem(LISTS.contactArchive, { Title: id, ContactId: id });
      cache.contactArchive.push(entry);
    }
    renderMaintContacts(document.querySelector('#page-maint-contacts .search-input')?.value||'');
    toast('ok', isArchived ? '↩ Contact restored' : '📦 Contact archived');
  } catch(e) {
    toast('err', 'Archive failed: '+e.message);
  }
  finally { setLoading(false); }
}

// ── Form open / archive-from-modal ────────────────────────────────
let _maintEditId = null;
function openMaintForm(id) {
  _maintEditId = id || null;
  const m = id ? cache.maintContacts.find(x=>x.id===id) : null;
  document.getElementById('maint-modal-title').textContent = m ? 'Edit Contact' : 'Add Contact';

  const fields = MAINT_FORM_FIELDS;

  document.getElementById('maint-form-fields').innerHTML = fields.map(f => {
    const label = spFieldLabel(f, LISTS.maintContacts) || f;
    const val = m ? (m[f] || '') : '';
    const lk = f.toLowerCase();
    const isLong = lk.includes('note') || lk.includes('comment') || lk.includes('description');
    if (f === 'Location') {
      const opts = ['', ...CFG.locations].map(l =>
        `<option value="${escHtml(l)}" ${val===l?'selected':''}>${l||'—'}</option>`
      ).join('');
      return `<div class="form-group"><label>Location</label><select id="mf_Location" class="filter" style="width:100%;">${opts}</select></div>`;
    }
    if (f === 'Tags') {
      return `<div class="form-group" style="grid-column:1/-1"><label>Tags</label>${tagEditorHTML('maint-contact')}</div>`;
    }
    return `<div class="form-group">
      <label>${label}${f==='Title'?' *':''}</label>
      ${isLong
        ? `<textarea id="mf_${f}" rows="3" style="width:100%;font-family:inherit;font-size:13px;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;resize:vertical;">${escHtml(val)}</textarea>`
        : `<input id="mf_${f}" value="${escHtml(val)}" placeholder="${escHtml(label)}" ${lk.includes('email')?'type="email"':lk.includes('website')?'type="url"':''}>`
      }
    </div>`;
  }).join('');
  initTagEditor('maint-contact', m?.Tags||'');

  const archiveBtn = document.getElementById('maint-archive-btn');
  if (m) {
    archiveBtn.style.display = 'inline-flex';
    archiveBtn.textContent = cache.contactArchive.some(a => a.ContactId === m.id) ? '↩ Restore' : '📦 Archive';
  } else {
    archiveBtn.style.display = 'none';
  }
  document.getElementById('maint-delete-btn').style.display = m ? 'inline-flex' : 'none';
  openModal('modal-maint');
  setTimeout(()=>document.getElementById('mf_Title')?.focus(), MODAL_FOCUS_DELAY_MS);
}

async function archiveMaintFromModal() {
  if (!_maintEditId) return;
  closeModal('modal-maint');
  await toggleMaintArchive(_maintEditId);
}

// ── Save / delete ─────────────────────────────────────────────────
async function saveMaintForm() {
  const fields = MAINT_FORM_FIELDS;
  const data = {};
  fields.forEach(f => {
    if (f === 'Tags') { data.Tags = getTagEditorValue('maint-contact'); return; }
    const el = document.getElementById('mf_'+f); if (el) data[f] = el.value;
  });
  if (!data.Title?.trim()) { toast('err','Company/name is required'); return; }
  setLoading(true,'Saving…');
  try {
    if (_maintEditId) {
      await updateListItem(LISTS.maintContacts, _maintEditId, data);
      const i = cache.maintContacts.findIndex(m=>m.id===_maintEditId);
      if (i!==-1) cache.maintContacts[i] = {...cache.maintContacts[i], ...data};
      toast('ok','✓ Contact updated');
    } else {
      const item = await addListItem(LISTS.maintContacts, data);
      cache.maintContacts.push(item);
      toast('ok','✓ Contact added');
    }
    renderMaintContacts(document.querySelector('#page-maint-contacts .search-input')?.value||'');
    closeModal('modal-maint');
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}

async function deleteMaintContact() {
  if (!_maintEditId) return;
  const m = cache.maintContacts.find(x=>x.id===_maintEditId);
  if (!confirm(`Delete "${m?.Title}"?`)) return;
  setLoading(true,'Deleting…');
  try {
    await deleteListItem(LISTS.maintContacts, _maintEditId);
    cache.maintContacts = cache.maintContacts.filter(x=>x.id!==_maintEditId);
    renderMaintContacts();
    closeModal('modal-maint');
    toast('ok','✓ Contact deleted');
  } catch(e) { toast('err','Delete failed: '+e.message); }
  finally { setLoading(false); }
}
