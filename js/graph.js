/* ================================================================
 * BSC Ops — graph.js
 * Microsoft Graph + SharePoint wrappers. Everything that talks to
 * graph.microsoft.com/v1.0 goes through these helpers.
 *
 * Depends on: auth.js (getToken, getAdminToken, CFG), state.js
 * (_spListCache, _colDisplayNames, _colReadOnly), constants.js
 * (SP_PAGE_SIZE, SP_SYSTEM_FIELDS, LIST_FIELD_LABELS), utils.js
 * (escHtml).
 * ================================================================ */

// ── Core Graph fetch wrappers ────────────────────────────────────
// graph()      — standard scopes, used for 99% of calls
// graphAdmin() — admin scopes, used for staff sync / tenant ops
// Both throw "[status] message" on non-2xx, return parsed JSON on 2xx,
// and return null on 204 No Content.
async function graph(method, path, body = null) {
  const token = await getToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { 'Authorization':'Bearer '+token, 'Content-Type':'application/json' },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) {
    const e = await res.json().catch(()=>({}));
    // Dump full detail to console so 400s surface the exact field / reason
    console.error('[Graph error]', method, path, {status: res.status, error: e, requestBody: body});
    const inner = e?.error?.innerError?.message || e?.error?.innererror?.message;
    const msg = e?.error?.message || 'Graph error';
    throw new Error(`[${res.status}] ${msg}${inner ? ' — ' + inner : ''}`);
  }
  return res.status === 204 ? null : res.json();
}

async function graphAdmin(method, path, body = null) {
  const token = await getAdminToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { 'Authorization':'Bearer '+token, 'Content-Type':'application/json' },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) {
    const e = await res.json().catch(()=>({}));
    throw new Error(`[${res.status}] ${e?.error?.message || 'Graph error'}`);
  }
  return res.status === 204 ? null : res.json();
}

// ── SharePoint site resolution ───────────────────────────────────
async function getSiteId() {
  if (CFG.siteId) return CFG.siteId;
  const res = await graph('GET','/sites/mainspringdevelopers.sharepoint.com:/sites/BlueSparrowCoffeeOps?$select=id');
  CFG.siteId = res.id;
  return CFG.siteId;
}

// Session-level cache of existing SP list name → id. Populated once,
// avoids per-list GET 404s during provisioning.
async function getSpListCache(siteId) {
  if (_spListCache) return _spListCache;
  _spListCache = {};
  // Follow all pages so we never miss a list
  let url = `/sites/${siteId}/lists?$select=name,displayName,id&$top=${SP_PAGE_SIZE}`;
  while (url) {
    const res = await graph('GET', url);
    (res.value || []).forEach(l => {
      if (l.name)        _spListCache[l.name]        = l.id;
      if (l.displayName) _spListCache[l.displayName] = l.id;
    });
    // nextLink is a full URL — strip the base so graph() can use it
    const next = res['@odata.nextLink'];
    url = next ? next.replace('https://graph.microsoft.com/v1.0', '') : null;
  }
  return _spListCache;
}

// ── Provisioning: ensure a list exists and has all expected columns ─
async function ensureList(listName, columns) {
  const siteId = await getSiteId();
  const listCache = await getSpListCache(siteId);
  let listId = listCache[listName];

  if (!listId) {
    const token = await getToken();
    const base = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists`;
    // GET first — avoids a 409 when the list exists but the name cache missed
    const getRes = await fetch(
      `${base}/${encodeURIComponent(listName)}?$select=id`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    if (getRes.ok) {
      const r = await getRes.json();
      listId = r.id;
    } else if (getRes.status === 404) {
      // Genuinely doesn't exist — create it
      const createRes = await fetch(base, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: listName, list: { template: 'genericList' } })
      });
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        throw new Error(err.error?.message || `List create failed: ${createRes.status}`);
      }
      const r = await createRes.json();
      listId = r.id;
    } else {
      const err = await getRes.json().catch(() => ({}));
      throw new Error(err.error?.message || `List lookup failed: ${getRes.status}`);
    }
    listCache[listName] = listId;
  }

  // Add any missing columns one-by-one
  if (columns && columns.length) {
    const existing = await graph('GET', `/sites/${siteId}/lists/${listId}/columns?$select=name`);
    const existNames = new Set((existing.value || []).map(c => c.name));
    for (const col of columns) {
      if (existNames.has(col.name)) continue;
      const colDef = { name: col.name, enforceUniqueValues: false, hidden: false, indexed: false };
      if (col.text)     colDef.text     = col.text;
      if (col.dateTime) colDef.dateTime = col.dateTime;
      if (col.number)   colDef.number   = col.number;
      if (col.boolean)  colDef.boolean  = col.boolean;
      await graph('POST', `/sites/${siteId}/lists/${listId}/columns`, colDef);
    }
  }
  return listId;
}

// ── List item CRUD ───────────────────────────────────────────────
// All CRUD returns {id, ...fields} flattened. Pagination via @odata.nextLink
// is handled transparently for reads.
async function getListItems(siteId, listName) {
  try {
    const items = [];
    let url = `/sites/${siteId}/lists/${listName}/items?expand=fields&$top=${SP_PAGE_SIZE}`;
    while (url) {
      const res = await graph('GET', url);
      items.push(...(res.value||[]).map(i=>({id:i.id,...i.fields})));
      url = res['@odata.nextLink']?.replace('https://graph.microsoft.com/v1.0','') ?? null;
    }
    return items;
  } catch { return []; }
}

// Per-location count history lists are provisioned lazily. getCountHistoryForList
// skips the fetch entirely when we know the list doesn't exist — avoids 404
// console noise and wasted tokens.
async function getCountHistoryForList(siteId, listName) {
  if (!listName) return [];
  if (_spListCache && !_spListCache[listName]) return [];
  try {
    const items = [];
    let url = `/sites/${siteId}/lists/${listName}/items?expand=fields&$top=${SP_PAGE_SIZE}`;
    while (url) {
      const res = await graph('GET', url);
      items.push(...(res.value||[]).map(i=>({id:i.id,...i.fields})));
      url = res['@odata.nextLink']?.replace('https://graph.microsoft.com/v1.0','') ?? null;
    }
    return items;
  } catch { return []; }
}

// Filter a fields object against the list's known column map loaded by
// loadListColNames(). Any key not in the column map AND not a system
// field is dropped — prevents 400s from stale / missing columns.
// When no column map is loaded yet (first run before metadata arrived),
// the caller's object is returned unchanged so behavior is unchanged.
function _filterKnownFields(listName, fields) {
  const known = _colDisplayNames && _colDisplayNames[listName];
  if (!known || !Object.keys(known).length) return fields;
  const out = {};
  const dropped = [];
  Object.keys(fields || {}).forEach(k => {
    if (known[k] || (SP_SYSTEM_FIELDS && SP_SYSTEM_FIELDS.has(k))) out[k] = fields[k];
    else dropped.push(k);
  });
  if (dropped.length) console.warn('[SP write] dropped unknown fields on', listName, dropped);
  return out;
}

async function addListItem(listName, fields) {
  const siteId = await getSiteId();
  const safe = _filterKnownFields(listName, fields);
  const res = await graph('POST',`/sites/${siteId}/lists/${listName}/items`,{fields:safe});
  return {id:res.id,...res.fields};
}

async function updateListItem(listName, itemId, fields) {
  const siteId = await getSiteId();
  const safe = _filterKnownFields(listName, fields);
  await graph('PATCH',`/sites/${siteId}/lists/${listName}/items/${itemId}/fields`,safe);
}

async function deleteListItem(listName, itemId) {
  const siteId = await getSiteId();
  await graph('DELETE',`/sites/${siteId}/lists/${listName}/items/${itemId}`);
}

// ── Column metadata & dynamic form rendering helpers ────────────
// loadListColNames() fetches display names + read-only flags for a list
// so spFieldLabel() can render proper human labels.
async function loadListColNames(siteId, listName) {
  try {
    const res = await graph('GET',`/sites/${siteId}/lists/${listName}/columns?$select=name,displayName,readOnly,hidden&$top=200`);
    const map = {};
    const ro = new Set();
    (res.value||[]).forEach(c=>{
      if(c.name && c.displayName) map[c.name]=c.displayName;
      if(c.readOnly || c.hidden) ro.add(c.name);
    });
    _colDisplayNames[listName] = map;
    _colReadOnly[listName] = ro;
  } catch { _colDisplayNames[listName] = {}; _colReadOnly[listName] = new Set(); }
}

function isEditableField(key, listName) {
  if (SP_SYSTEM_FIELDS.has(key)) return false;
  if (_colReadOnly[listName] && _colReadOnly[listName].has(key)) return false;
  return true;
}

// Human label for a SharePoint internal field name.
// Priority: per-list override → SP display name → decoded internal name.
function spFieldLabel(key, listName) {
  if (listName && LIST_FIELD_LABELS[listName] && LIST_FIELD_LABELS[listName][key]) {
    return LIST_FIELD_LABELS[listName][key];
  }
  if (listName && _colDisplayNames[listName] && _colDisplayNames[listName][key]) {
    return _colDisplayNames[listName][key];
  }
  return key
    .replace(/_x([0-9a-f]{4})_/gi, (_,h)=>String.fromCharCode(parseInt(h,16))) // decode hex chars
    .replace(/([a-z])([A-Z])/g, '$1 $2')                                        // split camelCase
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Format a SP field value for table display. Handles phone/email/url
// auto-linking and newline-separated multi-values.
function spCellValue(key, val) {
  if (!val || val==='') return '—';
  const k = key.toLowerCase();
  if (String(val).includes('\n')) {
    const parts = String(val).split('\n').map(s=>s.trim()).filter(Boolean);
    return parts.map(p=>spCellValue(key, p)).join('<br>');
  }
  const safe = escHtml(String(val));
  if (k.includes('phone')||k.includes('tel')) return `<a href="tel:${val.toString().replace(/\D/g,'')}">${safe}</a>`;
  if (k.includes('email')||k.includes('mail')) return `<a href="mailto:${safe}">${safe}</a>`;
  if (k.includes('website')||k.includes('url')) {
    const href = /^https?:\/\//i.test(val) ? escHtml(val) : '#';
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">↗</a>`;
  }
  return safe;
}
