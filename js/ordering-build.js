/* ================================================================
 * BSC Ops — ordering-build.js
 * The "real" ordering workflow on top of the existing free-text log:
 *
 *   Inventory → 🛒 Build Order   →  pick low items per vendor
 *                                    → creates BSC_Orders row with
 *                                      LineItems (JSON), Status=Pending
 *
 *   Ordering tab row click       →  Order Detail modal
 *                                    Pending  → Send / Cancel / Edit
 *                                    Ordered  → Mark Delivered
 *                                    Delivered/Cancelled → read-only
 *
 *   Send                          →  mailto: / sms: / tel: / Copy + flip
 *                                    Status to Ordered. Slack: order_sent.
 *
 *   Mark Delivered → Receive      →  per-line received qty (default = ordered).
 *                                    On confirm: writes a new count record
 *                                    per item at order.Location with
 *                                    StorageCount += receivedQty (audit trail
 *                                    via CountedBy = "Received: {user}").
 *                                    Slack: order_delivered.
 *
 * Legacy orders (no LineItems JSON) display the old Items free-text and skip
 * Send/Receive — read-only with a "Legacy order" badge.
 *
 * Depends on:
 *   - state.js (cache, currentUser, currentLocation)
 *   - constants.js (LISTS, INV_TYPE_CFG)
 *   - graph.js (addListItem, updateListItem, getSiteId)
 *   - utils.js (escHtml, toast, openModal, closeModal, setLoading)
 *   - inventory.js (suggestedOrderQty, getItemPar)
 *   - slack.js (sendSlackAlert)
 *   - settings.js (getSetting)
 * ================================================================ */

let _buildOrderModel  = null; // { loc, byVendor: {vendor: [{itemId, name, suggested, qty, unitCost, unit, checked}]} }
let _orderDetailId    = null;
let _receiveModel     = null; // { orderId, lines: [{itemId, name, qty, receivedQty, unit}], loc }

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

// Latest count map for the consumable counts list at a given location.
// Read directly from cache.countHistory (consumable cache key) — independent
// of which inventory type the user is currently viewing.
function _consumableCountsForLoc(loc) {
  const map = {};
  [...(cache.countHistory || [])]
    .filter(r => r.Location === loc)
    .sort((a,b) => {
      const aw = a.WeekOf||'', bw = b.WeekOf||'';
      return aw < bw ? -1 : aw > bw ? 1 : 0;
    })
    .forEach(r => {
      const name = (r.Title||r.ItemName||'').trim();
      if (name) map[name] = {
        store:   r.StoreCount   || 0,
        storage: r.StorageCount || 0,
        total:   r.TotalCount   || 0
      };
    });
  return map;
}

// Parse LineItems JSON; returns null if absent (legacy order).
function _orderLineItems(order) {
  if (!order?.LineItems) return null;
  try {
    const parsed = JSON.parse(order.LineItems);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function _orderReceivedItems(order) {
  if (!order?.ReceivedItems) return null;
  try {
    const parsed = JSON.parse(order.ReceivedItems);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function _isLegacyOrder(order) {
  return !_orderLineItems(order);
}

function _lineSubtotal(line) {
  return (parseFloat(line.qty)||0) * (parseFloat(line.unitCost)||0);
}

function _orderSubtotal(lines) {
  return (lines||[]).reduce((s,l) => s + _lineSubtotal(l), 0);
}

function _money(n) {
  return '$' + (Number(n)||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function _activeVendors() {
  return (cache.vendors||[])
    .filter(v => { const a = (v.Active||'').toString().toLowerCase(); return a===''||a==='yes'||a==='true'||a==='1'; })
    .reduce((m,v) => { const n = v.Title || v.VendorName || ''; if (n) m[n] = v; return m; }, {});
}

// Find a vendor record by name (case-insensitive).
function _vendorByName(name) {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  return (cache.vendors||[]).find(v => (v.Title||v.VendorName||'').toLowerCase().trim() === n) || null;
}

// First non-empty entry in a multi-line vendor field (Email/Phone are stored as \n-joined strings)
function _vendorFirst(vendor, field) {
  const raw = (vendor?.[field] || '').toString();
  return raw.split(/[\n,;]/).map(s => s.trim()).filter(Boolean)[0] || '';
}

// Format the order body — used for mailto/sms/copy
function _orderBody(order, lines) {
  const total = _orderSubtotal(lines);
  const itemsBlock = lines.map(l => `  • ${l.qty} × ${l.name}${l.unit ? ' ('+l.unit+')' : ''}`).join('\n');
  const expected = order.ExpectedDelivery
    ? new Date(order.ExpectedDelivery).toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})
    : 'ASAP';
  const orderedBy = order.OrderedBy || (currentUser?.name || currentUser?.username || '');
  return [
    `${order.Vendor} — Order from Blue Sparrow Coffee, ${order.Location}`,
    `Requested delivery: ${expected}`,
    `Ordered by: ${orderedBy}`,
    '',
    'Items:',
    itemsBlock,
    '',
    `Total: ${_money(total)}`,
    order.Notes ? `\nNotes: ${order.Notes}` : ''
  ].filter(Boolean).join('\n');
}

// ────────────────────────────────────────────────────────────────
// 1. Build Order modal — entry point from Inventory toolbar
// ────────────────────────────────────────────────────────────────

function openBuildOrderModal() {
  if (currentLocation === 'all') { toast('err','Select a location first'); return; }
  const loc = currentLocation;
  const counts = _consumableCountsForLoc(loc);

  // Find every consumable item with a non-null suggested qty at this location
  const lowItems = [];
  for (const item of (cache.inventory || [])) {
    if (item.Archived) continue;
    const total = counts[item.ItemName||'']?.total ?? null;
    const suggested = (typeof suggestedOrderQty === 'function')
      ? suggestedOrderQty(item, loc, total)
      : null;
    if (suggested == null) continue;
    const unitCost = (() => {
      const cpc = parseFloat(item.CostPerCase) || 0;
      const size = parseFloat(item.OrderSize)  || 1;
      return size > 0 ? cpc / size : cpc;
    })();
    lowItems.push({
      itemId:    item.id,
      name:      item.ItemName || '',
      vendor:    (item.Supplier || '').trim() || 'No Vendor',
      suggested,
      qty:       suggested,
      unitCost,
      unit:      item.OrderUnit || item.Unit || '',
      checked:   true
    });
  }

  if (!lowItems.length) {
    toast('warn', 'No items below par at ' + loc);
    return;
  }

  // Group by vendor, sort vendors alphabetically, items by name within each vendor
  const byVendor = {};
  for (const r of lowItems) {
    if (!byVendor[r.vendor]) byVendor[r.vendor] = [];
    byVendor[r.vendor].push(r);
  }
  for (const v of Object.keys(byVendor)) {
    byVendor[v].sort((a,b) => (a.name||'').localeCompare(b.name||''));
  }

  _buildOrderModel = { loc, byVendor };
  _renderBuildOrderModal();
  openModal('modal-build-order');
}

function _renderBuildOrderModal() {
  const body = document.getElementById('build-order-body');
  if (!body || !_buildOrderModel) return;
  const { loc, byVendor } = _buildOrderModel;
  const vendorNames = Object.keys(byVendor).sort();
  const activeVendors = _activeVendors();

  body.innerHTML = `
    <div style="font-size:13px;color:var(--muted);margin-bottom:16px;">
      Items below par at <b>${escHtml(loc)}</b>, grouped by vendor. Adjust quantities and click <b>Create Order</b> per vendor section. One PO per vendor.
    </div>
    ${vendorNames.map(vendor => _renderBuildOrderVendorSection(vendor, byVendor[vendor], !!activeVendors[vendor])).join('')}
  `;
  // Recompute subtotals on initial render
  vendorNames.forEach(v => _recalcBuildOrderVendorSubtotal(v));
}

function _renderBuildOrderVendorSection(vendor, items, hasVendorRecord) {
  const safeVendor = vendor.replace(/[^a-z0-9]+/gi, '_');
  const warning = !hasVendorRecord
    ? `<div style="font-size:11px;color:var(--orange);margin-bottom:6px;">⚠ "${escHtml(vendor)}" isn't an active vendor. Add them in Vendors first to enable Send actions on the order.</div>`
    : '';
  return `
    <div class="build-order-vendor-section" data-vendor="${escHtml(vendor)}" style="border:1.5px solid var(--border);border-radius:10px;margin-bottom:14px;overflow:hidden;">
      <div style="background:var(--cream);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <label style="display:flex;align-items:center;gap:8px;font-weight:700;cursor:pointer;">
          <input type="checkbox" checked onchange="_buildOrderToggleVendor('${escHtml(vendor)}', this.checked)">
          ${escHtml(vendor)} <span style="color:var(--muted);font-weight:400;">(${items.length} item${items.length===1?'':'s'})</span>
        </label>
        <div style="display:flex;align-items:center;gap:14px;">
          <span style="font-size:13px;color:var(--muted);">Subtotal: <b id="bo-subtotal-${safeVendor}" style="color:var(--dark-blue);">$0.00</b></span>
          <button class="btn btn-primary" style="font-size:12px;padding:6px 14px;" onclick="createOrderFromBuilder('${escHtml(vendor)}')">Create Order</button>
        </div>
      </div>
      ${warning}
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#fafafa;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;">
            <th style="width:32px;padding:6px 8px;"></th>
            <th style="text-align:left;padding:6px 10px;">Item</th>
            <th style="text-align:right;padding:6px 10px;">Suggested</th>
            <th style="text-align:right;padding:6px 10px;">Qty</th>
            <th style="text-align:left;padding:6px 6px;">Unit</th>
            <th style="text-align:right;padding:6px 10px;">Unit cost</th>
            <th style="text-align:right;padding:6px 10px;">Line</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((it, i) => `
            <tr data-vendor="${escHtml(vendor)}" data-item="${escHtml(it.itemId)}">
              <td style="padding:6px 8px;text-align:center;">
                <input type="checkbox" class="bo-row-cb" checked
                  onchange="_buildOrderRowToggle('${escHtml(vendor)}','${escHtml(it.itemId)}', this.checked)">
              </td>
              <td style="padding:6px 10px;font-weight:500;">${escHtml(it.name)}</td>
              <td style="padding:6px 10px;text-align:right;color:var(--muted);">${it.suggested}</td>
              <td style="padding:6px 10px;text-align:right;">
                <input type="number" min="0" step="0.1" value="${it.qty}" class="bo-row-qty"
                  oninput="_buildOrderRowQtyChange('${escHtml(vendor)}','${escHtml(it.itemId)}', this.value)"
                  style="width:72px;text-align:right;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;">
              </td>
              <td style="padding:6px 6px;color:var(--muted);font-size:12px;">${escHtml(it.unit||'')}</td>
              <td style="padding:6px 10px;text-align:right;color:var(--muted);">${_money(it.unitCost)}</td>
              <td style="padding:6px 10px;text-align:right;font-weight:600;" class="bo-row-line">${_money(_lineSubtotal(it))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function _buildOrderRowToggle(vendor, itemId, checked) {
  const items = _buildOrderModel?.byVendor?.[vendor];
  if (!items) return;
  const row = items.find(r => String(r.itemId) === String(itemId));
  if (row) row.checked = !!checked;
  _recalcBuildOrderVendorSubtotal(vendor);
}

function _buildOrderRowQtyChange(vendor, itemId, val) {
  const items = _buildOrderModel?.byVendor?.[vendor];
  if (!items) return;
  const row = items.find(r => String(r.itemId) === String(itemId));
  if (!row) return;
  row.qty = parseFloat(val) || 0;
  // Update line cell + vendor subtotal
  const tr = document.querySelector(`tr[data-vendor="${vendor.replace(/"/g,'\\"')}"][data-item="${String(itemId).replace(/"/g,'\\"')}"]`);
  const lineCell = tr?.querySelector('.bo-row-line');
  if (lineCell) lineCell.textContent = _money(_lineSubtotal(row));
  _recalcBuildOrderVendorSubtotal(vendor);
}

function _buildOrderToggleVendor(vendor, checked) {
  const items = _buildOrderModel?.byVendor?.[vendor];
  if (!items) return;
  items.forEach(r => r.checked = !!checked);
  // Update DOM checkboxes
  document.querySelectorAll(`tr[data-vendor="${vendor.replace(/"/g,'\\"')}"] .bo-row-cb`).forEach(cb => cb.checked = !!checked);
  _recalcBuildOrderVendorSubtotal(vendor);
}

function _recalcBuildOrderVendorSubtotal(vendor) {
  const items = _buildOrderModel?.byVendor?.[vendor] || [];
  const subtotal = items.filter(r => r.checked).reduce((s,r) => s + _lineSubtotal(r), 0);
  const safeVendor = vendor.replace(/[^a-z0-9]+/gi, '_');
  const el = document.getElementById('bo-subtotal-' + safeVendor);
  if (el) el.textContent = _money(subtotal);
}

async function createOrderFromBuilder(vendor) {
  const model = _buildOrderModel;
  if (!model) return;
  const items = (model.byVendor[vendor] || []).filter(r => r.checked && (parseFloat(r.qty)||0) > 0);
  if (!items.length) { toast('err','Check at least one item with a qty > 0'); return; }
  const loc = model.loc;
  const total = _orderSubtotal(items);
  const lineItemsJson = JSON.stringify(items.map(r => ({
    itemId:   String(r.itemId),
    name:     r.name,
    qty:      parseFloat(r.qty)||0,
    unitCost: parseFloat(r.unitCost)||0,
    unit:     r.unit||''
  })));

  setLoading(true,'Creating order…');
  try {
    const fields = {
      Vendor:           vendor,
      Location:         loc,
      Status:           'Pending',
      OrderedBy:        currentUser?.name || currentUser?.username || '',
      LineItems:        lineItemsJson,
      Total:            +total.toFixed(2),
      // Items left blank for new orders — LineItems is the source of truth.
      // Notes left for the user to fill in via Order Detail modal.
    };
    const order = await addListItem(LISTS.orders, fields);
    cache.orders.push(order);
    // Remove these items from the model so they don't get re-ordered into another vendor's PO
    delete _buildOrderModel.byVendor[vendor];
    if (typeof renderOrders === 'function') renderOrders();
    if (typeof renderDashboard === 'function') renderDashboard();
    toast('ok', `✓ Order created — ${vendor} (${items.length} item${items.length===1?'':'s'}, ${_money(total)})`);
    sendSlackAlert(`🛒 New order: *${vendor}* for ${loc} — ${items.length} items, ${_money(total)} (${currentUser?.name||currentUser?.username||''})`);
    // If no vendors remain, close the modal; else re-render
    if (Object.keys(_buildOrderModel.byVendor).length === 0) {
      closeModal('modal-build-order');
      _buildOrderModel = null;
    } else {
      _renderBuildOrderModal();
    }
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}

// ────────────────────────────────────────────────────────────────
// 2. Order Detail modal — entry from Ordering page row click
// ────────────────────────────────────────────────────────────────

function openOrderDetailModal(orderId) {
  const order = (cache.orders || []).find(o => String(o.id) === String(orderId));
  if (!order) { toast('err','Order not found'); return; }
  _orderDetailId = order.id;
  _renderOrderDetail(order);
  openModal('modal-order-detail');
}

function _renderOrderDetail(order) {
  const body = document.getElementById('order-detail-body');
  const footer = document.getElementById('order-detail-footer');
  if (!body || !footer) return;
  const lines = _orderLineItems(order);
  const isLegacy = !lines;
  const status = order.Status || 'Pending';
  const total  = isLegacy ? null : _orderSubtotal(lines);
  const expected = order.ExpectedDelivery
    ? new Date(order.ExpectedDelivery).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'})
    : '—';
  const created = order.Created ? new Date(order.Created).toLocaleDateString() : '—';
  const statusBadge = {Pending:'badge-gold',Ordered:'badge-blue',Delivered:'badge-green',Cancelled:'badge-gray'}[status] || 'badge-gray';
  const receivedInfo = (status === 'Delivered' && order.ReceivedAt)
    ? `<div style="font-size:12px;color:var(--muted);margin-top:6px;">Received ${new Date(order.ReceivedAt).toLocaleString()}${order.ReceivedBy ? ' by ' + escHtml(order.ReceivedBy) : ''}</div>`
    : '';

  body.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px;">
      <div><div style="font-size:11px;color:var(--muted);">Vendor</div><div style="font-weight:700;">${escHtml(order.Vendor||'—')}</div></div>
      <div><div style="font-size:11px;color:var(--muted);">Location</div><div style="font-weight:700;">${escHtml(order.Location||'—')}</div></div>
      <div><div style="font-size:11px;color:var(--muted);">Status</div><span class="badge ${statusBadge}">${escHtml(status)}</span>${isLegacy ? ' <span class="badge badge-gray" style="margin-left:6px;">Legacy</span>' : ''}</div>
      <div><div style="font-size:11px;color:var(--muted);">Expected delivery</div><div>${escHtml(expected)}</div></div>
      <div><div style="font-size:11px;color:var(--muted);">Created</div><div>${escHtml(created)}${order.OrderedBy ? ' · ' + escHtml(order.OrderedBy) : ''}</div></div>
      ${total != null ? `<div><div style="font-size:11px;color:var(--muted);">Total</div><div style="font-weight:700;color:var(--gold);">${_money(total)}</div></div>` : ''}
    </div>
    ${receivedInfo}
    <div style="margin-top:12px;">
      ${isLegacy
        ? `<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Items (legacy free-text)</div>
           <div style="background:#f9f9f9;border-radius:8px;padding:10px 14px;font-size:13px;white-space:pre-wrap;">${escHtml(order.Items||order.Notes||'(empty)')}</div>`
        : `<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Line items (${lines.length})</div>
           <div class="table-wrap" style="max-height:280px;overflow-y:auto;">
             <table style="width:100%;border-collapse:collapse;font-size:13px;">
               <thead><tr style="background:var(--opal);font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);">
                 <th style="text-align:left;padding:6px 10px;">Item</th>
                 <th style="text-align:right;padding:6px 10px;">Qty</th>
                 <th style="text-align:left;padding:6px 6px;">Unit</th>
                 <th style="text-align:right;padding:6px 10px;">Unit cost</th>
                 <th style="text-align:right;padding:6px 10px;">Line</th>
                 ${status === 'Delivered' ? '<th style="text-align:right;padding:6px 10px;">Received</th>' : ''}
               </tr></thead>
               <tbody>
                 ${lines.map(l => {
                   const recv = status === 'Delivered' ? (_orderReceivedItems(order)?.find(r => String(r.itemId)===String(l.itemId))?.receivedQty ?? '—') : null;
                   return `<tr>
                     <td style="padding:6px 10px;">${escHtml(l.name)}</td>
                     <td style="padding:6px 10px;text-align:right;">${l.qty}</td>
                     <td style="padding:6px 6px;color:var(--muted);">${escHtml(l.unit||'')}</td>
                     <td style="padding:6px 10px;text-align:right;color:var(--muted);">${_money(l.unitCost)}</td>
                     <td style="padding:6px 10px;text-align:right;font-weight:600;">${_money(_lineSubtotal(l))}</td>
                     ${status === 'Delivered' ? `<td style="padding:6px 10px;text-align:right;color:var(--gold);">${recv}</td>` : ''}
                   </tr>`;
                 }).join('')}
               </tbody>
             </table>
           </div>`}
    </div>
    <div style="margin-top:14px;">
      <label class="field-label">Notes</label>
      <textarea id="order-detail-notes" rows="2" class="field-input" ${status === 'Delivered' || status === 'Cancelled' ? 'disabled' : ''}>${escHtml(order.Notes||'')}</textarea>
    </div>
  `;

  // Action footer
  let footerHtml = '';
  if (isLegacy) {
    footerHtml = `<button class="btn btn-outline" onclick="closeModal('modal-order-detail')">Close</button>`;
  } else if (status === 'Pending') {
    footerHtml = `
      <button class="btn btn-outline" style="color:var(--red);" onclick="cancelOrder('${escHtml(order.id)}')">❌ Cancel Order</button>
      <button class="btn btn-primary" onclick="sendOrderToVendor('${escHtml(order.id)}')">📤 Send to Vendor</button>`;
  } else if (status === 'Ordered') {
    footerHtml = `
      <button class="btn btn-outline" style="color:var(--red);" onclick="cancelOrder('${escHtml(order.id)}')">❌ Cancel</button>
      <button class="btn btn-primary" onclick="openReceiveOrderModal('${escHtml(order.id)}')">📦 Mark Delivered</button>`;
  } else {
    footerHtml = `<button class="btn btn-outline" onclick="closeModal('modal-order-detail')">Close</button>`;
  }
  footer.innerHTML = footerHtml;
}

async function _saveOrderNotes(orderId) {
  const ta = document.getElementById('order-detail-notes');
  if (!ta || ta.disabled) return;
  const order = cache.orders.find(o => String(o.id) === String(orderId));
  if (!order) return;
  const newNotes = ta.value;
  if ((order.Notes||'') === newNotes) return;
  try {
    await updateListItem(LISTS.orders, orderId, { Notes: newNotes });
    order.Notes = newNotes;
  } catch(e) { console.warn('[order] notes save failed:', e.message); }
}

async function cancelOrder(orderId) {
  const order = cache.orders.find(o => String(o.id) === String(orderId));
  if (!order) return;
  if (!confirm(`Cancel this order to ${order.Vendor}?`)) return;
  setLoading(true,'Cancelling…');
  try {
    await _saveOrderNotes(orderId);
    await updateListItem(LISTS.orders, orderId, { Status: 'Cancelled' });
    order.Status = 'Cancelled';
    closeModal('modal-order-detail');
    if (typeof renderOrders === 'function') renderOrders();
    if (typeof renderDashboard === 'function') renderDashboard();
    toast('ok', '✓ Order cancelled');
  } catch(e) { toast('err','Cancel failed: '+e.message); }
  finally { setLoading(false); }
}

// ────────────────────────────────────────────────────────────────
// 3. Send to Vendor
// ────────────────────────────────────────────────────────────────

async function sendOrderToVendor(orderId) {
  const order = cache.orders.find(o => String(o.id) === String(orderId));
  if (!order) return;
  const lines = _orderLineItems(order);
  if (!lines) { toast('err','No line items to send'); return; }
  await _saveOrderNotes(orderId);
  // Pull latest order (Notes may have been saved)
  const liveOrder = cache.orders.find(o => String(o.id) === String(orderId));
  const body = _orderBody(liveOrder, lines);
  const vendor = _vendorByName(liveOrder.Vendor);
  const method = (vendor?.OrderMethod || '').trim();
  const subject = `Order from Blue Sparrow Coffee, ${liveOrder.Location}`;

  if (method === 'Email') {
    const to = _vendorFirst(vendor, 'Email');
    if (!to) { toast('err',`No email address on vendor "${liveOrder.Vendor}". Add one in Vendors.`); return; }
    window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    await _markOrderSent(orderId);
  } else if (method === 'Text') {
    const to = _vendorFirst(vendor, 'Phone');
    if (!to) { toast('err',`No phone number on vendor "${liveOrder.Vendor}". Add one in Vendors.`); return; }
    window.location.href = `sms:${to}?body=${encodeURIComponent(body)}`;
    await _markOrderSent(orderId);
  } else if (method === 'Phone') {
    const to = _vendorFirst(vendor, 'Phone');
    if (!to) { toast('err',`No phone number on vendor "${liveOrder.Vendor}". Add one in Vendors.`); return; }
    try { await navigator.clipboard.writeText(body); toast('ok','Order copied to clipboard'); } catch {}
    window.location.href = `tel:${to}`;
    await _markOrderSent(orderId);
  } else {
    // Portal / App / Fax / In Person / blank — show a confirmation modal with the body + Copy + Mark Sent
    _openSendFallbackModal(liveOrder, body);
  }
}

function _openSendFallbackModal(order, body) {
  const el = document.getElementById('send-fallback-body');
  if (!el) return;
  const vendor = _vendorByName(order.Vendor);
  const method = (vendor?.OrderMethod || '—').trim();
  el.innerHTML = `
    <div style="font-size:13px;color:var(--muted);margin-bottom:10px;">
      Vendor's preferred method: <b>${escHtml(method)}</b>. Copy the order text below and send it however you do.
    </div>
    <pre id="send-fallback-pre" style="background:#f9f9f9;border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.5;white-space:pre-wrap;max-height:280px;overflow-y:auto;">${escHtml(body)}</pre>
    <input type="hidden" id="send-fallback-order-id" value="${escHtml(order.id)}">
  `;
  openModal('modal-send-fallback');
}

async function copySendFallbackBody() {
  const pre = document.getElementById('send-fallback-pre');
  if (!pre) return;
  try {
    await navigator.clipboard.writeText(pre.textContent);
    toast('ok','Copied to clipboard');
  } catch {
    toast('err','Could not copy. Select the text manually.');
  }
}

async function confirmSendFallback() {
  const orderId = document.getElementById('send-fallback-order-id')?.value;
  if (!orderId) return;
  closeModal('modal-send-fallback');
  await _markOrderSent(orderId);
}

async function _markOrderSent(orderId) {
  const order = cache.orders.find(o => String(o.id) === String(orderId));
  if (!order) return;
  if (order.Status === 'Ordered' || order.Status === 'Delivered' || order.Status === 'Cancelled') return; // idempotent
  setLoading(true,'Updating order…');
  try {
    await updateListItem(LISTS.orders, orderId, {
      Status: 'Ordered',
      OrderedBy: currentUser?.name || currentUser?.username || ''
    });
    order.Status = 'Ordered';
    order.OrderedBy = currentUser?.name || currentUser?.username || order.OrderedBy;
    closeModal('modal-order-detail');
    if (typeof renderOrders === 'function') renderOrders();
    if (typeof renderDashboard === 'function') renderDashboard();
    toast('ok','✓ Order sent — status: Ordered');
    sendSlackAlert(`📤 Order sent to *${order.Vendor}* (${order.Location}) by ${currentUser?.name||currentUser?.username||''}`, 'order_sent');
  } catch(e) { toast('err','Status update failed: '+e.message); }
  finally { setLoading(false); }
}

// ────────────────────────────────────────────────────────────────
// 4. Receive
// ────────────────────────────────────────────────────────────────

function openReceiveOrderModal(orderId) {
  const order = cache.orders.find(o => String(o.id) === String(orderId));
  if (!order) return;
  if (order.Status === 'Delivered') { toast('warn','Already marked delivered'); return; }
  const lines = _orderLineItems(order);
  if (!lines) { toast('err','No line items to receive'); return; }
  _receiveModel = {
    orderId,
    loc: order.Location,
    lines: lines.map(l => ({ ...l, receivedQty: l.qty }))
  };
  _renderReceiveModal(order);
  openModal('modal-receive-order');
}

function _renderReceiveModal(order) {
  const body = document.getElementById('receive-order-body');
  if (!body || !_receiveModel) return;
  body.innerHTML = `
    <div style="font-size:13px;color:var(--muted);margin-bottom:14px;">
      Confirm received quantities for <b>${escHtml(order.Vendor)}</b> at <b>${escHtml(order.Location)}</b>. Defaults to ordered qty — adjust for partial deliveries. Received qty is added to the <b>Storage</b> column.
    </div>
    <div class="table-wrap" style="max-height:340px;overflow-y:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:var(--opal);font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);">
            <th style="text-align:left;padding:6px 10px;">Item</th>
            <th style="text-align:right;padding:6px 10px;">Ordered</th>
            <th style="text-align:right;padding:6px 10px;">Received</th>
            <th style="text-align:left;padding:6px 6px;">Unit</th>
          </tr>
        </thead>
        <tbody>
          ${_receiveModel.lines.map(l => `
            <tr data-item="${escHtml(l.itemId)}">
              <td style="padding:6px 10px;">${escHtml(l.name)}</td>
              <td style="padding:6px 10px;text-align:right;color:var(--muted);">${l.qty}</td>
              <td style="padding:6px 10px;text-align:right;">
                <input type="number" min="0" step="0.1" value="${l.receivedQty}" class="rcv-row-qty"
                  oninput="_receiveRowChange('${escHtml(l.itemId)}', this.value)"
                  style="width:80px;text-align:right;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;">
              </td>
              <td style="padding:6px 6px;color:var(--muted);font-size:12px;">${escHtml(l.unit||'')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function _receiveRowChange(itemId, val) {
  const line = _receiveModel?.lines.find(l => String(l.itemId) === String(itemId));
  if (line) line.receivedQty = parseFloat(val) || 0;
}

async function confirmReceiveOrder() {
  if (!_receiveModel) return;
  const { orderId, loc, lines } = _receiveModel;
  const order = cache.orders.find(o => String(o.id) === String(orderId));
  if (!order) return;
  if (order.Status === 'Delivered') { toast('warn','Already marked delivered'); return; } // idempotent guard

  const received = lines
    .map(l => ({ itemId: String(l.itemId), receivedQty: parseFloat(l.receivedQty)||0 }))
    .filter(r => r.receivedQty > 0);
  if (!received.length) { toast('err','No items received — set at least one qty'); return; }

  const byUser = currentUser?.name || currentUser?.username || '';
  const now    = new Date().toISOString();
  const cntList = `BSC_${(loc||'').replace(/[\s\/\\]/g,'_')}_InventoryCounts`;
  const countsMap = _consumableCountsForLoc(loc);

  setLoading(true, `Receiving ${received.length} item${received.length===1?'':'s'}…`);
  try {
    // 1. Write a new count record per received item — append-only, additive to Storage
    const writes = received.map(async r => {
      const line = lines.find(l => String(l.itemId) === String(r.itemId));
      const name = line?.name || '';
      if (!name) return null;
      const prev = countsMap[name] || { store: 0, storage: 0, total: 0 };
      const newStore   = prev.store;                              // unchanged — assume fresh shipments go to storage
      const newStorage = (prev.storage || 0) + r.receivedQty;
      const newTotal   = newStore + newStorage;
      const rec = await addListItem(cntList, {
        Title:        name,
        WeekOf:       now,
        StoreCount:   newStore,
        StorageCount: newStorage,
        TotalCount:   newTotal,
        Location:     loc,
        CountedBy:    `Received: ${byUser}`
      });
      cache.countHistory.push(rec);
      return name;
    });
    await Promise.all(writes);

    // 2. Patch the order
    await updateListItem(LISTS.orders, orderId, {
      Status:        'Delivered',
      ReceivedItems: JSON.stringify(received),
      ReceivedAt:    now,
      ReceivedBy:    byUser
    });
    order.Status        = 'Delivered';
    order.ReceivedItems = JSON.stringify(received);
    order.ReceivedAt    = now;
    order.ReceivedBy    = byUser;

    closeModal('modal-receive-order');
    closeModal('modal-order-detail');
    _receiveModel = null;
    if (typeof renderOrders === 'function') renderOrders();
    if (typeof renderInventory === 'function') renderInventory();
    if (typeof renderDashboard === 'function') renderDashboard();
    toast('ok', `✓ Received ${received.length} item${received.length===1?'':'s'} at ${loc}`);
    sendSlackAlert(`🚚 Order delivered: *${order.Vendor}* at ${loc} — ${received.length} items (by ${byUser})`, 'order_delivered');
  } catch(e) { toast('err','Receive failed: '+e.message); }
  finally { setLoading(false); }
}
