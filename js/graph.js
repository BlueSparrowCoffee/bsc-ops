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
// Retry transient failures (429 throttling, 500/502/503/504 service
// blips). Honors Retry-After (seconds OR HTTP-date) when Microsoft
// sends one; otherwise 1s / 2s / 5s backoff. Caps every wait at 30s.
const _GRAPH_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const _GRAPH_MAX_RETRIES = 3;
function _graphBackoffMs(res, retriesLeft) {
  const raw = res.headers.get('Retry-After');
  if (raw) {
    // Try integer seconds first
    const secs = parseInt(raw, 10);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs, 30) * 1000;
    // Then try HTTP-date format ("Wed, 21 Oct 2026 07:28:00 GMT")
    const t = Date.parse(raw);
    if (Number.isFinite(t)) {
      const delta = t - Date.now();
      if (delta > 0) return Math.min(delta, 30 * 1000);
    }
  }
  return ((_GRAPH_MAX_RETRIES - retriesLeft) ** 2) * 1000 + 1000; // 1s, 2s, 5s
}

async function graph(method, path, body = null, _retries = _GRAPH_MAX_RETRIES, _extraHeaders = null) {
  const token = await getToken();
  const headers = { 'Authorization':'Bearer '+token, 'Content-Type':'application/json' };
  if (_extraHeaders) Object.assign(headers, _extraHeaders);
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : null
  });
  if (_GRAPH_RETRY_STATUSES.has(res.status) && _retries > 0) {
    const waitMs = _graphBackoffMs(res, _retries);
    console.warn(`[Graph ${res.status}] ${method} ${path} — retrying in ${waitMs}ms (${_retries} left)`);
    await new Promise(r => setTimeout(r, waitMs));
    return graph(method, path, body, _retries - 1, _extraHeaders);
  }
  if (!res.ok) {
    const e = await res.json().catch(()=>({}));
    const inner = e?.error?.innerError?.message || e?.error?.innererror?.message;
    const msg = e?.error?.message || 'Graph error';
    // Flat log — prints key fields inline so you don't need to expand Object
    console.error(`[Graph ${res.status}] ${method} ${path}\n  message: ${msg}${inner ? '\n  inner:   '+inner : ''}\n  body:    ${body ? JSON.stringify(body) : '(none)'}\n  raw:`, e);
    const err = new Error(`[${res.status}] ${msg}${inner ? ' — ' + inner : ''}`);
    err.status = res.status; // surface for 412 conflict-handling in callers
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function graphAdmin(method, path, body = null, _retries = _GRAPH_MAX_RETRIES) {
  const token = await getAdminToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { 'Authorization':'Bearer '+token, 'Content-Type':'application/json' },
    body: body ? JSON.stringify(body) : null
  });
  if (_GRAPH_RETRY_STATUSES.has(res.status) && _retries > 0) {
    const waitMs = _graphBackoffMs(res, _retries);
    console.warn(`[GraphAdmin ${res.status}] ${method} ${path} — retrying in ${waitMs}ms (${_retries} left)`);
    await new Promise(r => setTimeout(r, waitMs));
    return graphAdmin(method, path, body, _retries - 1);
  }
  if (!res.ok) {
    const e = await res.json().catch(()=>({}));
    const err = new Error(`[${res.status}] ${e?.error?.message || 'Graph error'}`);
    err.status = res.status;
    throw err;
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
    const existing = await graph('GET', `/sites/${siteId}/lists/${listId}/columns?$select=name,displayName`);
    const existNames = new Set((existing.value || []).map(c => c.name));
    const existDisplay = new Set((existing.value || []).filter(c=>c.displayName).map(c => String(c.displayName).toLowerCase()));
    for (const col of columns) {
      // Skip if a column already exists with this internal name OR the same display name
      if (existNames.has(col.name) || existDisplay.has(String(col.name).toLowerCase())) continue;
      const colDef = { name: col.name, enforceUniqueValues: false, hidden: false, indexed: false };
      if (col.text)     colDef.text     = col.text;
      if (col.dateTime) colDef.dateTime = col.dateTime;
      if (col.number)   colDef.number   = col.number;
      if (col.boolean)  colDef.boolean  = col.boolean;
      // Don't let one bad column (e.g. reserved name like "Tags") abort
      // provisioning for every column that follows — log and continue.
      try {
        await graph('POST', `/sites/${siteId}/lists/${listId}/columns`, colDef);
      } catch (err) {
        console.warn(`[ensureList] ${listName}: column "${col.name}" failed — ${err.message}`);
      }
    }
  }
  return listId;
}

// ── List item CRUD ───────────────────────────────────────────────
// All CRUD returns {id, ...fields} flattened. Pagination via @odata.nextLink
// is handled transparently for reads. The listItem-level @odata.etag is
// captured into a non-conflicting `_etag` slot so callers can pass it
// back into updateListItem({etag}) for optimistic-concurrency writes.
async function getListItems(siteId, listName) {
  try {
    const items = [];
    let url = `/sites/${siteId}/lists/${listName}/items?expand=fields&$top=${SP_PAGE_SIZE}`;
    while (url) {
      const res = await graph('GET', url);
      items.push(...(res.value||[]).map(i=>({
        id: i.id,
        _etag: i['@odata.etag'] || null,
        ...i.fields
      })));
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
      items.push(...(res.value||[]).map(i=>({
        id: i.id,
        _etag: i['@odata.etag'] || null,
        ...i.fields
      })));
      url = res['@odata.nextLink']?.replace('https://graph.microsoft.com/v1.0','') ?? null;
    }
    return items;
  } catch { return []; }
}

// Resolve field keys against the list's column map loaded by
// loadListColNames(). Handles three cases:
//
//   1. Exact internal-name match → pass through unchanged.
//   2. Display-name match (case-insensitive) → rewrite key to the
//      SP internal name. Fixes the common Location → Location0
//      reserved-word rename case.
//   3. No match at all → DROP with a console.warn. A missing column
//      should not 400 the entire write — the user's other fields
//      still save. Re-run provisioning to add the missing column.
//
// When no column map is loaded yet (pre-bootstrap), pass through
// everything — the original graph() error logger still surfaces
// any real failure.
function _remapFieldNames(listName, fields) {
  const known = _colDisplayNames && _colDisplayNames[listName];
  if (!known || !Object.keys(known).length) return fields;
  const displayToInternal = {};
  Object.entries(known).forEach(([internal, display]) => {
    if (display) displayToInternal[String(display).toLowerCase()] = internal;
  });
  const out = {};
  const remapped = {};
  const dropped = [];
  Object.keys(fields || {}).forEach(k => {
    if (known[k] || (SP_SYSTEM_FIELDS && SP_SYSTEM_FIELDS.has(k))) { out[k] = fields[k]; return; }
    const internal = displayToInternal[k.toLowerCase()];
    if (internal) {
      if (internal !== k) remapped[k] = internal;
      out[internal] = fields[k];
      return;
    }
    dropped.push(k);
  });
  if (Object.keys(remapped).length) console.warn('[SP write] remapped:', listName, remapped);
  if (dropped.length) console.warn('[SP write] dropped (no column on list):', listName, dropped);
  return out;
}

async function addListItem(listName, fields) {
  const siteId = await getSiteId();
  const safe = _remapFieldNames(listName, fields);
  const res = await graph('POST',`/sites/${siteId}/lists/${listName}/items`,{fields:safe});
  return {id:res.id,...res.fields};
}

// updateListItem(listName, itemId, fields)
//   — backward-compatible last-write-wins PATCH (legacy default).
//
// updateListItem(listName, itemId, fields, { etag })
//   — sends If-Match: <etag>. Throws an Error with .status === 412 when
//     the row was modified since the etag was captured. Caller is
//     responsible for refetching + retrying (or use updateListItemSafe).
async function updateListItem(listName, itemId, fields, opts = null) {
  const siteId = await getSiteId();
  const safe = _remapFieldNames(listName, fields);
  const headers = (opts && opts.etag) ? { 'If-Match': opts.etag } : null;
  await graph('PATCH',`/sites/${siteId}/lists/${listName}/items/${itemId}/fields`, safe, undefined, headers);
}

// Optimistic-concurrency wrapper for hot-contention rows (auto-sync lock,
// project status, etc.). Reads the current etag, PATCHes with If-Match.
// On 412 (someone else just modified the row), re-reads and retries once.
// After two conflicts, throws — caller decides whether to surface a toast.
async function updateListItemSafe(listName, itemId, fields) {
  const siteId = await getSiteId();
  let etag = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!etag) {
        const cur = await graph('GET', `/sites/${siteId}/lists/${listName}/items/${itemId}?$select=id`);
        etag = cur?.['@odata.etag'] || null;
      }
      await updateListItem(listName, itemId, fields, etag ? { etag } : null);
      return;
    } catch (e) {
      if (e?.status === 412 && attempt === 0) { etag = null; continue; }
      throw e;
    }
  }
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

// ── Microsoft Graph: send mail ───────────────────────────────────
// Sends an email from the signed-in user's mailbox via /me/sendMail.
// Requires the Mail.Send delegated scope (present in SCOPES).
// Splits multi-value `to` strings (one per newline OR comma) into
// individual recipients. Passes content as plain Text. Saves to the
// user's Sent Items by default.
//
// sendMail({ to, subject, body, cc, bcc })
//   to/cc/bcc — string (newline/comma-separated) or string[]
//   subject   — string
//   body      — plain text
async function sendMail({ to, subject, body, cc, bcc }) {
  const _toRecips = (v) => {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : String(v).split(/[\n,;]/);
    return arr.map(s => String(s).trim()).filter(Boolean)
      .map(addr => ({ emailAddress: { address: addr } }));
  };
  const recipients = _toRecips(to);
  if (!recipients.length) throw new Error('sendMail: no recipients');
  const token = await getToken();
  const payload = {
    message: {
      subject: subject || '(no subject)',
      body: { contentType: 'Text', content: body || '' },
      toRecipients: recipients,
      ccRecipients:  _toRecips(cc),
      bccRecipients: _toRecips(bcc),
    },
    saveToSentItems: true
  };
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { 'Authorization':'Bearer '+token, 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  // 202 Accepted = queued for delivery; no body returned
  if (res.status === 202) return true;
  const e = await res.json().catch(()=>({}));
  const msg = e?.error?.message || `sendMail failed (${res.status})`;
  throw new Error(msg);
}
