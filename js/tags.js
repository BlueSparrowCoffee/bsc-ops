/* ================================================================
 * BSC Ops — tags.js
 * Central tag registry + reusable tag-editor widget + settings UI.
 *
 * BSC_Tags is the canonical list of tag names shared across vendors,
 * contacts, inventory, and maintenance. Every item that has tags
 * stores them as a comma-separated string in a "Tags" column; the
 * registry exists so autocomplete is union-across-sections and so
 * the Settings page can manage tags centrally.
 *
 * Usage from a form:
 *   container.innerHTML += tagEditorHTML('vendor');
 *   initTagEditor('vendor', existingTagsStr);
 *   // …later on save:
 *   const tagsStr = getTagEditorValue('vendor');
 *
 * Read-only display in tables:
 *   cell.innerHTML = renderTagPills(item.Tags);
 *
 * Depends on: state.js (cache), constants.js (LISTS), graph.js
 * (addListItem, deleteListItem), utils.js (escHtml, toast).
 * ================================================================ */

// ── Registry: union of BSC_Tags + any tags already on items ──────
// Catches pre-registry tags that haven't been migrated yet so the
// autocomplete list is never short-changed.
function getAllTagNames() {
  const set = new Set();
  (cache.tags||[]).forEach(t => { if (t.Title) set.add(t.Title.trim()); });
  [...(cache.vendors||[]), ...(cache.maintContacts||[]), ...(cache.inventory||[]),
   ...(cache.maintSchedule||[]), ...(cache.merchInventory||[]), ...(cache.equipInventory||[])]
    .forEach(item => (item.Tags||'').split(',').map(t=>t.trim()).filter(Boolean).forEach(t=>set.add(t)));
  return [...set].sort((a,b)=>a.localeCompare(b));
}

async function ensureTagExists(name) {
  const n = (name||'').trim();
  if (!n) return;
  if ((cache.tags||[]).some(t=>(t.Title||'').toLowerCase()===n.toLowerCase())) return;
  try {
    const item = await addListItem(LISTS.tags, { Title: n });
    cache.tags.push(item);
  } catch {}
}

// On first load: seeds BSC_Tags with any tags already on vendors/contacts.
// Fire-and-forget from bootstrap; re-renders the settings page if it added anything.
async function migrateTagsToRegistry() {
  const existing = new Set((cache.tags||[]).map(t=>(t.Title||'').toLowerCase().trim()));
  const toAdd = new Set();
  [...(cache.vendors||[]), ...(cache.maintContacts||[])]
    .forEach(item => (item.Tags||'').split(',').map(t=>t.trim()).filter(Boolean)
      .forEach(t=>{ if(t && !existing.has(t.toLowerCase())) toAdd.add(t); }));
  for (const tag of toAdd) await ensureTagExists(tag);
  if (toAdd.size) renderTagsSettings();
}

// ── Reusable tag-editor widget ───────────────────────────────────
// Each instance is keyed by instanceId (e.g. 'vendor', 'inv-item',
// 'maint-task') so multiple editors can coexist on one page.
const _tagEditorState = {};

function tagEditorHTML(instanceId) {
  const eid = escHtml(instanceId);
  return `
    <div id="te-pills-${eid}" style="display:flex;flex-wrap:wrap;gap:5px;min-height:22px;margin-bottom:6px;"></div>
    <div style="display:flex;gap:6px;position:relative;">
      <input id="te-input-${eid}" class="field-input" placeholder="Add tag…" style="flex:1;"
        oninput="tagEditorShowSuggestions('${eid}',this.value)"
        onkeydown="tagEditorKeydown(event,'${eid}')">
      <button type="button" class="btn btn-outline" style="padding:6px 12px;font-size:12px;"
        onclick="tagEditorCommitInput('${eid}')">Add</button>
      <div id="te-sug-${eid}" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1.5px solid var(--border);border-radius:8px;box-shadow:var(--shadow);z-index:300;max-height:160px;overflow-y:auto;font-size:13px;margin-top:2px;"></div>
    </div>`;
}

function initTagEditor(instanceId, tagsStr) {
  _tagEditorState[instanceId] = { tags: (tagsStr||'').split(',').map(t=>t.trim()).filter(Boolean) };
  tagEditorRenderPills(instanceId);
}

function getTagEditorValue(instanceId) {
  return (_tagEditorState[instanceId]?.tags||[]).join(',');
}

function tagEditorRenderPills(instanceId) {
  const c = document.getElementById('te-pills-'+instanceId);
  if (!c) return;
  const tags = _tagEditorState[instanceId]?.tags||[];
  c.innerHTML = tags.map(t=>`
    <span class="badge badge-gold" style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;font-size:12px;">
      ${escHtml(t)}
      <button type="button" data-id="${escHtml(instanceId)}" data-tag="${escHtml(t)}"
        onclick="tagEditorRemoveTag(this.dataset.id,this.dataset.tag)"
        style="background:none;border:none;cursor:pointer;color:var(--gold-deep);font-size:14px;line-height:1;padding:0;margin-left:2px;">×</button>
    </span>`).join('');
}

function tagEditorAddTag(instanceId, tag) {
  const t = (tag||'').trim().replace(/,/g,'');
  if (!t) return;
  const state = _tagEditorState[instanceId];
  if (!state || state.tags.includes(t)) return;
  state.tags.push(t);
  tagEditorRenderPills(instanceId);
  ensureTagExists(t); // fire-and-forget: keep registry current
}

function tagEditorRemoveTag(instanceId, tag) {
  const state = _tagEditorState[instanceId];
  if (!state) return;
  state.tags = state.tags.filter(t=>t!==tag);
  tagEditorRenderPills(instanceId);
}

function tagEditorCommitInput(instanceId) {
  const input = document.getElementById('te-input-'+instanceId);
  if (!input) return;
  tagEditorAddTag(instanceId, input.value);
  input.value = '';
  const sug = document.getElementById('te-sug-'+instanceId);
  if (sug) sug.style.display = 'none';
}

function tagEditorKeydown(e, instanceId) {
  if (e.key==='Enter'||e.key===',') { e.preventDefault(); tagEditorCommitInput(instanceId); }
  else if (e.key==='Escape') { const s=document.getElementById('te-sug-'+instanceId); if(s) s.style.display='none'; }
}

function tagEditorShowSuggestions(instanceId, val) {
  const box = document.getElementById('te-sug-'+instanceId);
  if (!box) return;
  const v = (val||'').trim().toLowerCase();
  if (!v) { box.style.display='none'; return; }
  const current = _tagEditorState[instanceId]?.tags||[];
  const matches = getAllTagNames().filter(t=>t.toLowerCase().includes(v)&&!current.includes(t));
  if (!matches.length) { box.style.display='none'; return; }
  box.style.display = 'block';
  box.innerHTML = matches.slice(0,10).map(t=>`
    <div style="padding:8px 14px;cursor:pointer;" data-id="${escHtml(instanceId)}" data-tag="${escHtml(t)}"
      onmousedown="tagEditorAddTag(this.dataset.id,this.dataset.tag);document.getElementById('te-input-'+this.dataset.id).value='';document.getElementById('te-sug-'+this.dataset.id).style.display='none';">
      ${escHtml(t)}</div>`).join('');
}

// ── Read-only pill display (tables, cards) ───────────────────────
function renderTagPills(tagsStr) {
  const tags = (tagsStr||'').split(',').map(t=>t.trim()).filter(Boolean);
  if (!tags.length) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;">${
    tags.map(t=>`<span class="badge badge-gold" style="padding:1px 7px;font-size:11px;white-space:nowrap;">${escHtml(t)}</span>`).join('')
  }</div>`;
}

// ── Settings page: global tag management card ────────────────────
function renderTagsSettings() {
  const list = document.getElementById('tags-list');
  if (!list) return;
  const tags = getAllTagNames();
  if (!tags.length) {
    list.innerHTML = '<span style="font-size:13px;color:var(--muted);">No tags yet — add one below</span>';
    return;
  }
  list.innerHTML = tags.map(t=>`
    <span class="badge badge-gold" style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;font-size:13px;">
      ${escHtml(t)}
      <button type="button" data-tag="${escHtml(t)}" onclick="deleteGlobalTag(this.dataset.tag)"
        style="background:none;border:none;cursor:pointer;color:var(--gold-deep);font-size:16px;line-height:1;padding:0;margin-left:2px;">×</button>
    </span>`).join('');
}

async function addGlobalTag() {
  const input = document.getElementById('new-tag-input');
  const name = (input?.value||'').trim();
  if (!name) return;
  await ensureTagExists(name);
  if (input) input.value = '';
  renderTagsSettings();
  toast('ok', `✓ Tag "${name}" added`);
}

async function deleteGlobalTag(name) {
  const item = cache.tags.find(t=>(t.Title||'').toLowerCase()===name.toLowerCase());
  if (item) {
    try {
      await deleteListItem(LISTS.tags, item.id);
      cache.tags = cache.tags.filter(t=>t.id!==item.id);
    } catch(e) { toast('err','Delete failed: '+e.message); return; }
  } else {
    cache.tags = cache.tags.filter(t=>(t.Title||'').toLowerCase()!==name.toLowerCase());
  }
  renderTagsSettings();
  toast('ok', `✓ Tag "${name}" removed`);
}
