/* ================================================================
 * BSC Ops — signalr.js
 * Real-time sync: SharePoint webhooks → Azure Function → Azure
 * SignalR Service → this browser. When a SP list changes, the relevant
 * cache key is refreshed and the active page re-renders. If a modal is
 * open, the refresh is queued and flushed by closeModal() once the
 * user's edit is committed or cancelled.
 *
 * Depends on:
 *  - global `signalR` (@microsoft/signalr UMD from CDN, loaded with defer)
 *  - state.js (cache, _pendingRefreshKeys)
 *  - graph.js (getSiteId, getSpListCache, getListItems, graph)
 *  - constants.js (LISTS, LIST_PAGE_MAP, WEBHOOK_EXPIRY_DAYS)
 *  - various render* functions from feature modules (looked up at
 *    call time — PAGE_RENDER_FN uses arrow-wrappers so the bindings
 *    are resolved when fired, not when this file parses)
 *  - isOwner() from permissions code in index.html
 * ================================================================ */

// Page ID → re-render function. The arrow wrappers defer the lookup
// until the refresh fires, so function declarations in later-loading
// modules still work.
const PAGE_RENDER_FN = {
  dashboard:        () => renderDashboard(),
  inventory:        () => renderInventory(),
  ordering:         () => { renderOrders(); },
  checklists:       () => renderChecklists(),
  vendors:          () => renderVendors(),
  recipes:          () => renderRecipes(),
  staff:            () => renderStaff(),
  'prep-items':     () => renderPrepItems(),
  cogs:             () => renderCogs(),
  menu:             () => renderMenu(),
  'maint-schedule': () => { renderMaintSchedule(); if (typeof renderMaintContacts === 'function') renderMaintContacts(); },
  settings:         () => { renderRoles(); renderTagsSettings(); initColMgr(); },
  parking:          () => renderParking(),
};

// ── Connection state ─────────────────────────────────────────────
let _signalRConn        = null;
let _webhooksRegistered = false;

// ── Small DOM helpers used by the refresh pipeline ───────────────
function getActivePage() {
  const el = document.querySelector('.page.active');
  return el ? el.id.replace('page-', '') : null;
}

function isAnyModalOpen() {
  return !!document.querySelector('.modal-overlay.show');
}

// If the active page renders this list, re-render it. Otherwise no-op.
function triggerPageRefresh(listKey) {
  const activePage = getActivePage();
  if (!activePage) return;
  const affected = LIST_PAGE_MAP[listKey] || [];
  if (affected.includes(activePage)) {
    PAGE_RENDER_FN[activePage]?.();
  }
}

// Called when the SignalR hub delivers a listChanged event.
// Re-fetches the one list, then either triggers an immediate re-render
// (if no modal is open) or queues the refresh key for flushing by
// closeModal() — defined in the inline script.
async function handleListChanged(listKey) {
  if (!listKey || !LISTS[listKey]) return;
  try {
    const siteId = await getSiteId();
    cache[listKey] = await getListItems(siteId, LISTS[listKey]);
  } catch(e) {
    console.warn('[BSC] Real-time refresh failed for', listKey, e.message);
    return;
  }
  if (isAnyModalOpen()) {
    _pendingRefreshKeys.add(listKey);
  } else {
    triggerPageRefresh(listKey);
  }
}

// ── SignalR connection ───────────────────────────────────────────
// Automatic-reconnect retry schedule: immediate → 2s → 5s → 10s → 30s.
// After those are exhausted, onclose() schedules a fresh initSignalR()
// in 60s — the connection never permanently dies.
async function initSignalR() {
  if (typeof signalR === 'undefined') return;
  try {
    _signalRConn = new signalR.HubConnectionBuilder()
      .withUrl(`${window.location.origin}/api`)
      .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
      .configureLogging(signalR.LogLevel.None)
      .build();
    _signalRConn.on('listChanged', ({ listKey }) => handleListChanged(listKey));
    _signalRConn.onclose(() => {
      console.warn('[BSC] SignalR closed — will retry in 60 s');
      _signalRConn = null;
      setTimeout(initSignalR, 60_000);
    });
    _signalRConn.onreconnecting(() => {});
    _signalRConn.onreconnected(() => {});
    await _signalRConn.start();
  } catch(e) {
    console.warn('[BSC] SignalR unavailable — will retry in 60 s:', e.message);
    _signalRConn = null;
    setTimeout(initSignalR, 60_000);
  }
}

// ── SharePoint webhook registration (owner only) ─────────────────
// Idempotent: GET existing subscriptions, extend any near expiry,
// create missing ones. Runs at most every 12 h so we don't hammer
// Graph on every bootstrap.
async function registerWebhooks() {
  if (_webhooksRegistered || !isOwner()) return;
  _webhooksRegistered = true;
  const lastCheck = parseInt(localStorage.getItem('bsc_webhook_check') || '0');
  if (Date.now() - lastCheck < 12 * 60 * 60 * 1000) return;
  localStorage.setItem('bsc_webhook_check', String(Date.now()));
  const siteId    = await getSiteId();
  const listCache = await getSpListCache(siteId);
  const notifyUrl = `${window.location.origin}/api/sp-webhook`;
  const expiry    = new Date(Date.now() + WEBHOOK_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  for (const [listKey, listName] of Object.entries(LISTS)) {
    try {
      const listId = listCache[listName];
      if (!listId) continue;
      const subsRes  = await graph('GET', `/sites/${siteId}/lists/${listId}/subscriptions`);
      const existing = (subsRes.value || []).find(s => s.notificationUrl === notifyUrl);
      if (existing) {
        const daysLeft = (new Date(existing.expirationDateTime) - Date.now()) / 86400000;
        if (daysLeft < 30) {
          await graph('PATCH', `/sites/${siteId}/lists/${listId}/subscriptions/${existing.id}`, { expirationDateTime: expiry });
        }
      } else {
        await graph('POST', `/sites/${siteId}/lists/${listId}/subscriptions`, {
          notificationUrl: notifyUrl,
          expirationDateTime: expiry,
          clientState: `bscops-${listKey}`
        });
      }
    } catch(e) {
      // Non-fatal — some lists may not support webhooks
      console.warn(`[BSC] Webhook skipped for ${listKey}:`, e.message);
    }
  }
  console.log('[BSC] Webhook registration complete');
}
