/* ================================================================
 * BSC Ops — auto-sync.js
 * Daily client-side auto-sync from Square → SharePoint.
 *
 * Fired from bootstrapApp() after initial data load. Checks a lock
 * + last-run timestamp in BSC_Settings; if conditions are met, runs
 * the 4 Square syncs sequentially in the background. SignalR
 * propagates the resulting SP changes to every connected browser.
 *
 * Owner-only — non-owner users silently skip (they can't write to
 * SP anyway). Disabled by default; users opt in via Settings.
 *
 * Lock pattern:
 *   1. Read auto_sync_lock from BSC_Settings (JSON: {owner, ts})
 *   2. If lock exists AND age < AUTO_SYNC_LOCK_TTL_MS → bail
 *   3. Write lock with current user + now()
 *   4. Run syncs (skip-and-continue if individual sync throws)
 *   5. Stamp auto_sync_last_run, clear lock
 *   6. On unexpected throw, leave lock to TTL out naturally
 *
 * Race-condition note: BSC_Settings has no compare-and-swap, so two
 * users opening at the exact same second could both pass the lock
 * check. Mitigated by random startup jitter. Even if both run, the
 * sync functions are idempotent — same Square data → same SP writes.
 * Only cost is duplicated API calls.
 *
 * Depends on:
 *   - state.js (cache, currentUser)
 *   - constants.js (AUTO_SYNC_INTERVAL_HOURS, AUTO_SYNC_LOCK_TTL_MS)
 *   - settings.js (getSetting, saveSetting)
 *   - auth.js (isOwner)
 *   - cogs.js (syncInvPricesFromSquare)
 *   - square.js (syncSquareCatalog)
 *   - utils.js (toast)
 * ================================================================ */

let _autoSyncRunning = false;

// Public entry — call from bootstrapApp after initial render. No-op if
// disabled, recently run, locked, or user lacks permissions.
async function tryAutoSync() {
  // Don't double-run within the same tab session
  if (_autoSyncRunning) return;

  // Disabled by setting (default off)
  if (getSetting('auto_sync_enabled') !== '1') return;

  // Owner-only — non-owners can't write to SP. Silent skip; the next
  // owner who opens the app will trigger the sync.
  if (typeof isOwner !== 'function' || !isOwner()) return;

  // Cooldown check — bail if last run < interval ago
  const last  = parseSettingDate(getSetting('auto_sync_last_run'));
  const now   = Date.now();
  const intMs = (typeof AUTO_SYNC_INTERVAL_HOURS === 'number' ? AUTO_SYNC_INTERVAL_HOURS : 24) * 3600 * 1000;
  if (last && now - last < intMs) return;

  // Lock check — bail if another browser is mid-sync
  const lockTtl = (typeof AUTO_SYNC_LOCK_TTL_MS === 'number' ? AUTO_SYNC_LOCK_TTL_MS : 5 * 60 * 1000);
  const lock    = parseSettingJSON(getSetting('auto_sync_lock'));
  if (lock && lock.ts && now - lock.ts < lockTtl) {
    console.log(`[auto-sync] Skip — another browser is syncing (${lock.owner || 'unknown'})`);
    return;
  }

  // Random jitter (0-3s) so two browsers opening simultaneously don't
  // hit the lock-write at the same instant
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 3000)));

  // Re-check the lock after the jitter — narrows the race window from
  // the bootstrap-to-write span (~seconds) down to the recheck-to-write
  // span (~ms). Doesn't fully eliminate (no compare-and-swap), but
  // greatly reduces the chance of two tabs both passing.
  const lockAfter = parseSettingJSON(getSetting('auto_sync_lock'));
  if (lockAfter && lockAfter.ts && Date.now() - lockAfter.ts < lockTtl) {
    console.log(`[auto-sync] Skip after jitter — another browser acquired the lock (${lockAfter.owner || 'unknown'})`);
    return;
  }

  await _runAutoSync(/* manualOverride */ false);
}

// Manual "Run Now" — bypasses the cooldown but still respects the lock
// and the same skip-and-continue per-sync error handling.
async function runAutoSyncNow() {
  if (_autoSyncRunning) { toast('err', 'Sync already running'); return; }
  if (!isOwner()) { toast('err', 'Owner access required'); return; }
  await _runAutoSync(/* manualOverride */ true);
}

async function _runAutoSync(manual) {
  _autoSyncRunning = true;
  const me = currentUser?.username || currentUser?.name || 'unknown';
  const startTs = Date.now();
  console.log(`[auto-sync] Starting${manual ? ' (manual)' : ''} as ${me}`);

  // Acquire lock (best-effort — see race note in header)
  try {
    await saveSetting('auto_sync_lock', JSON.stringify({ owner: me, ts: startTs }));
  } catch (e) {
    console.warn('[auto-sync] Could not acquire lock:', e.message);
    _autoSyncRunning = false;
    return;
  }

  // Status indicator in topbar
  const statusEl = document.getElementById('sync-label');
  const prevText = statusEl?.textContent || '';
  if (statusEl) statusEl.textContent = '🔄 Auto-syncing…';

  // Sequential syncs — one at a time, skip-and-continue. Each underlying
  // function already has its own try/catch + retry, but we wrap one more
  // time so a hard throw on one sync doesn't kill the others.
  const targets = [
    { label: 'catalog → menu', fn: () => typeof syncSquareCatalog === 'function' ? syncSquareCatalog() : null },
    { label: 'merchandise',    fn: () => typeof syncInvPricesFromSquare === 'function' ? syncInvPricesFromSquare('merch')   : null },
    { label: 'food',           fn: () => typeof syncInvPricesFromSquare === 'function' ? syncInvPricesFromSquare('food')    : null },
    { label: 'grocery',        fn: () => typeof syncInvPricesFromSquare === 'function' ? syncInvPricesFromSquare('grocery') : null },
  ];

  let okCount = 0, failCount = 0;
  const failedLabels = [];
  for (const t of targets) {
    try {
      await t.fn();
      okCount++;
      console.log(`[auto-sync] ✓ ${t.label}`);
    } catch (e) {
      failCount++;
      failedLabels.push(t.label);
      console.warn(`[auto-sync] ✗ ${t.label}:`, e.message);
    }
  }

  // Stamp completion ONLY when every target succeeded. A partial-failure
  // run (e.g. catalog ok, food threw) used to stamp last_run anyway, which
  // suppressed the next 24 h's retry and left food/grocery silently 24 h
  // stale. Now we keep last_run unset on partial failure so the next
  // browser opening rolls the dice again. The failed-target list is also
  // saved so the Settings UI can surface "last run had failures".
  if (failCount === 0 && okCount > 0) {
    try { await saveSetting('auto_sync_last_run', new Date().toISOString()); }
    catch(e) { console.warn('[auto-sync] Could not write last-run:', e.message); }
    try { await saveSetting('auto_sync_last_failed', ''); } catch {}
  } else if (failCount > 0) {
    const failed = failedLabels.join(', ');
    try { await saveSetting('auto_sync_last_failed', failed); } catch {}
    console.warn(`[auto-sync] Partial failure — not stamping last_run. Failed targets: ${failed}`);
  }

  // Always clear lock
  try { await saveSetting('auto_sync_lock', ''); } catch {}

  // Restore topbar status
  if (statusEl) {
    const elapsed = Math.round((Date.now() - startTs) / 1000);
    if (manual) {
      toast(failCount ? 'err' : 'ok',
        `${failCount ? '⚠' : '✓'} Auto-sync done in ${elapsed}s · ${okCount} ok${failCount ? `, ${failCount} failed` : ''}`);
    }
    statusEl.textContent = prevText;
  }

  // Refresh Settings UI if it's currently visible
  if (typeof renderAutoSyncCard === 'function') renderAutoSyncCard();

  _autoSyncRunning = false;
  console.log(`[auto-sync] Done — ${okCount} ok, ${failCount} failed, ${Math.round((Date.now()-startTs)/1000)}s`);
}

// ── Settings parsing helpers ─────────────────────────────────────
function parseSettingDate(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function parseSettingJSON(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

// ── Settings page: render the Auto-Sync card ─────────────────────
// Called by Settings page render + after auto-sync finishes.
function renderAutoSyncCard() {
  const container = document.getElementById('auto-sync-card-body');
  if (!container) return;

  const enabled  = getSetting('auto_sync_enabled') === '1';
  const lastRun  = parseSettingDate(getSetting('auto_sync_last_run'));
  const lock     = parseSettingJSON(getSetting('auto_sync_lock'));
  const lockTtl  = AUTO_SYNC_LOCK_TTL_MS || 5*60*1000;
  const lockHot  = lock && lock.ts && Date.now() - lock.ts < lockTtl;

  const lastLabel = lastRun ? _relativeTime(lastRun) + ' (' + new Date(lastRun).toLocaleString([], {dateStyle:'short', timeStyle:'short'}) + ')' : 'Never';
  const ownerOnly = !isOwner();

  container.innerHTML = `
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px;">
      Pull Square catalog, merchandise, food, and grocery into SharePoint automatically once per day.
      Runs in the background when the first owner-level user opens the app each morning.
      SignalR then propagates the changes to every connected browser within seconds.
    </p>
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500;margin-bottom:12px;${ownerOnly?'opacity:.5;cursor:not-allowed;':'cursor:pointer;'}">
      <input type="checkbox" id="auto-sync-enabled" ${enabled?'checked':''} ${ownerOnly?'disabled':''} onchange="toggleAutoSyncEnabled(this.checked)">
      Enable daily auto-sync from Square
    </label>
    <div style="font-size:12px;color:var(--muted);margin-bottom:14px;">
      Last synced: <strong>${escHtml(lastLabel)}</strong>
      ${lockHot ? `<br><span style="color:var(--gold);">🔄 Currently syncing in another tab (${escHtml(lock.owner || 'unknown')})</span>` : ''}
    </div>
    <button class="btn btn-outline" onclick="runAutoSyncNow()" ${ownerOnly||lockHot?'disabled':''}>
      🔄 Run Now
    </button>
    ${ownerOnly ? '<div style="font-size:11px;color:var(--muted);margin-top:10px;">Owner access required to enable or run.</div>' : ''}
  `;
}

async function toggleAutoSyncEnabled(checked) {
  if (!isOwner()) { toast('err','Owner access required'); renderAutoSyncCard(); return; }
  try {
    await saveSetting('auto_sync_enabled', checked ? '1' : '');
    toast('ok', checked ? '✓ Auto-sync enabled' : '✓ Auto-sync disabled');
  } catch (e) {
    toast('err', 'Failed: ' + e.message);
  }
  renderAutoSyncCard();
}

// Compact relative-time formatter — "8 hours ago", "3 days ago", "just now"
function _relativeTime(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.round(diff / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m} minute${m===1?'':'s'} ago`;
  const h = Math.round(m / 60);
  if (h < 24)  return `${h} hour${h===1?'':'s'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d===1?'':'s'} ago`;
}
