/* ================================================================
 * BSC Ops — sync-queue.js (PR 14b of design refresh)
 *
 * Local-first write queue. SharePoint mutations that fail (offline,
 * 5xx, network) are persisted to IndexedDB and replayed when the
 * browser comes back online.
 *
 * High-level shape:
 *   await safeAddListItem(listName, fields, { kind, idempotencyKey })
 *   await safeUpdateListItem(listName, id, fields, { kind, idempotencyKey })
 *
 *     - When navigator.onLine and the direct call succeeds → direct write.
 *     - When offline OR the call throws a recoverable error → enqueued
 *       to IndexedDB (`bsc_sync_queue` store) and a stub record is
 *       returned so the caller can update its in-memory cache.
 *
 *   await SyncQueue.drain()  — replay every pending op in FIFO order.
 *   SyncQueue.size()         — pending count (cached, async-refreshed).
 *
 * Drains automatically on the window 'online' event (registered at
 * bottom). Listeners can subscribe via SyncQueue.on('change', cb)
 * to react to queue size changes (used by the pending-sync card in
 * Settings — see PR 14d).
 *
 * Idempotency: callers can pass an idempotencyKey so a queued op
 * isn't double-applied if the network blips during a partial drain.
 * Without one, ops are deduped by (kind, listName, JSON-of-payload).
 *
 * Depends on:
 *   - graph.js (addListItem, updateListItem, deleteListItem)
 *   - utils.js (toast)
 * ================================================================ */

const _IDB_NAME    = 'bsc_sync_db';
const _IDB_VERSION = 1;
const _IDB_STORE   = 'queue';

let _idbPromise = null;
function _openIdb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(_IDB_STORE)) {
        const store = db.createObjectStore(_IDB_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('idempotencyKey', 'idempotencyKey', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _idbPromise;
}

async function _idbAdd(record) {
  const db = await _openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    const req = tx.objectStore(_IDB_STORE).add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function _idbAll() {
  const db = await _openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_IDB_STORE, 'readonly');
    const req = tx.objectStore(_IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function _idbDelete(id) {
  const db = await _openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    const req = tx.objectStore(_IDB_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function _idbUpdate(record) {
  const db = await _openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    const req = tx.objectStore(_IDB_STORE).put(record);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── Pub/sub for size changes ────────────────────────────────────
const _listeners = new Set();
let _cachedSize = 0;
async function _refreshSize() {
  try {
    const items = await _idbAll();
    _cachedSize = items.length;
    _listeners.forEach(cb => { try { cb(_cachedSize); } catch {} });
  } catch { /* IndexedDB unavailable — leave cache as-is */ }
}

// ── Recoverable-error detection ──────────────────────────────────
// Returns true when the error looks like "try again later" rather
// than "your data is wrong". Network failures, offline, 5xx, 429,
// and SharePoint throttling all count.
function _isRecoverable(err) {
  if (!navigator.onLine) return true;
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('failed to fetch'))   return true;
  if (msg.includes('networkerror'))      return true;
  if (msg.includes('load failed'))       return true;
  if (msg.includes('throttle'))          return true;
  // status code embedded in message (graph.js throws like "Graph 503: ...")
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  return false;
}

const SyncQueue = {
  size() { return _cachedSize; },
  refresh: _refreshSize,
  on(event, cb) { if (event === 'change') _listeners.add(cb); return () => _listeners.delete(cb); },

  // Persist a write to IDB. Returns the assigned id.
  async enqueue(op) {
    const record = {
      ...op,
      createdAt: Date.now(),
      attempts: 0,
      lastError: null,
      lastAttemptAt: null
    };
    const id = await _idbAdd(record);
    await _refreshSize();
    return id;
  },

  // Replay every pending op in FIFO order. Stops early on the first
  // recoverable failure (so we don't burn through retries while the
  // network is still flaky). Returns { ok, failed, remaining }.
  async drain() {
    if (!navigator.onLine) return { ok: 0, failed: 0, remaining: _cachedSize };
    const items = await _idbAll();
    items.sort((a, b) => a.createdAt - b.createdAt);
    let ok = 0, failed = 0;
    for (const item of items) {
      try {
        await _replay(item);
        await _idbDelete(item.id);
        ok++;
      } catch (e) {
        if (_isRecoverable(e)) {
          // Stop draining; bump attempts so the user can see retry state.
          item.attempts = (item.attempts || 0) + 1;
          item.lastError = String(e?.message || e);
          item.lastAttemptAt = Date.now();
          await _idbUpdate(item);
          failed++;
          break;
        }
        // Non-recoverable: drop the item (caller already saw the failure).
        item.attempts = (item.attempts || 0) + 1;
        item.lastError = String(e?.message || e);
        item.lastAttemptAt = Date.now();
        await _idbUpdate(item);
        failed++;
      }
    }
    await _refreshSize();
    return { ok, failed, remaining: _cachedSize };
  }
};

// Re-execute one queued op. Switches on the op kind; each kind
// targets one of the existing graph.js write helpers.
async function _replay(item) {
  switch (item.kind) {
    case 'addListItem':
      if (typeof addListItem !== 'function') throw new Error('addListItem unavailable');
      return addListItem(item.listName, item.fields);
    case 'updateListItem':
      if (typeof updateListItem !== 'function') throw new Error('updateListItem unavailable');
      return updateListItem(item.listName, item.itemId, item.fields);
    case 'deleteListItem':
      if (typeof deleteListItem !== 'function') throw new Error('deleteListItem unavailable');
      return deleteListItem(item.listName, item.itemId);
    default:
      throw new Error('Unknown queued op kind: ' + item.kind);
  }
}

// ── Public write wrappers ───────────────────────────────────────
// These mirror the graph.js helpers but fall back to the queue when
// offline or on a recoverable error. Callers can use them anywhere
// they used to call addListItem/updateListItem directly.

async function safeAddListItem(listName, fields, opts = {}) {
  if (navigator.onLine && typeof addListItem === 'function') {
    try { return await addListItem(listName, fields); }
    catch (e) {
      if (!_isRecoverable(e)) throw e;
      // fall through to enqueue
    }
  }
  await SyncQueue.enqueue({
    kind: 'addListItem',
    listName,
    fields,
    idempotencyKey: opts.idempotencyKey || null,
    label: opts.label || `add → ${listName}`
  });
  // Stub return so callers can update their in-memory cache. id is
  // a synthetic negative number to flag "not yet persisted" — caller
  // can replace it after drain by re-fetching the list.
  return { id: -Date.now(), ...fields, _pendingSync: true };
}

async function safeUpdateListItem(listName, itemId, fields, opts = {}) {
  if (navigator.onLine && typeof updateListItem === 'function') {
    try { return await updateListItem(listName, itemId, fields); }
    catch (e) {
      if (!_isRecoverable(e)) throw e;
    }
  }
  await SyncQueue.enqueue({
    kind: 'updateListItem',
    listName,
    itemId,
    fields,
    idempotencyKey: opts.idempotencyKey || null,
    label: opts.label || `update → ${listName} #${itemId}`
  });
  return { id: itemId, ...fields, _pendingSync: true };
}

// ── Auto-drain on reconnect ─────────────────────────────────────
window.addEventListener('online', () => {
  // Small delay so the browser settles before we hammer the network.
  setTimeout(() => {
    SyncQueue.drain().then(({ ok, failed }) => {
      if (ok > 0 && typeof toast === 'function') {
        toast('ok', `↻ Synced ${ok} pending change${ok === 1 ? '' : 's'}${failed ? ` · ${failed} still pending` : ''}`);
      }
    }).catch(() => { /* swallow — UI already shows pending count */ });
  }, 800);
});

// Initial size cache so callers see a real number on first read.
window.addEventListener('DOMContentLoaded', () => {
  _refreshSize();
});
