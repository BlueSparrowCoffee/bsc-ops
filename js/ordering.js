/* ================================================================
 * BSC Ops — ordering.js
 * Orders list (page-ordering): table render + status filter + the
 * legacy "create manual order" modal (modal-order).
 *
 * The richer build/send/receive workflow lives in ordering-build.js.
 * Orders created via Build Order have a LineItems JSON column; legacy
 * free-text orders display from the older Items field.
 *
 * Contents:
 *   - renderOrders(query, statusFilter)
 *   - filterOrders(query)
 *   - saveOrder()  — adds one row from modal-order (manual entry path)
 *
 * Depends on:
 *   state.js     — cache, currentUser
 *   constants.js — LISTS
 *   utils.js     — escHtml, toast, closeModal, setLoading, debounceFilter
 *   graph.js     — addListItem
 *   dashboard.js — renderDashboard
 *   slack.js     — sendSlackAlert
 *   ordering-build.js — openOrderDetailModal (called on row click)
 * ================================================================ */

function renderOrders(query='', statusFilter='') {
  let orders = [...cache.orders].reverse();
  if (query) orders = orders.filter(o=>JSON.stringify(o).toLowerCase().includes(query.toLowerCase()));
  if (statusFilter) orders = orders.filter(o=>o.Status===statusFilter);
  const tbody = document.getElementById('order-body');
  tbody.innerHTML = orders.map(o=>{
    const badges = {Pending:'badge-gold',Ordered:'badge-blue',Delivered:'badge-green',Cancelled:'badge-gray'};
    // Line items badge — count from LineItems JSON if present, else fall back
    // to a truncated version of the legacy Items free-text blob.
    let itemsCell = '';
    let lineCount = 0;
    if (o.LineItems) {
      try {
        const parsed = JSON.parse(o.LineItems);
        if (Array.isArray(parsed)) {
          lineCount = parsed.length;
          const names = parsed.slice(0,3).map(p => `${p.qty}× ${p.name}`).join(', ');
          itemsCell = `<span style="font-weight:600;">${lineCount} item${lineCount===1?'':'s'}</span> <span style="color:var(--muted);font-size:11px;">${escHtml(names)}${parsed.length>3?` +${parsed.length-3} more`:''}</span>`;
        }
      } catch { /* fall through to legacy */ }
    }
    if (!itemsCell) {
      itemsCell = `<span style="color:var(--muted);">${escHtml(o.Items||o.Notes||'—')}</span>`;
    }
    const totalCell = (o.Total != null && o.Total !== '') ? '$'+Number(o.Total).toFixed(2) : '—';
    return `<tr data-order-id="${escHtml(o.id)}" onclick="openOrderDetailModal('${escHtml(o.id)}')" style="cursor:pointer;">
      <td>${o.Created?new Date(o.Created).toLocaleDateString():'—'}</td>
      <td class="fw">${escHtml(o.Vendor||'—')}</td>
      <td style="max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${itemsCell}</td>
      <td>${escHtml(o.Location||'—')}</td>
      <td><span class="badge ${badges[o.Status]||'badge-gray'}">${escHtml(o.Status||'—')}</span></td>
      <td style="color:var(--muted);font-size:12px;">${totalCell}</td>
      <td>${escHtml(o.OrderedBy||'—')}</td>
      <td>${o.ExpectedDelivery?new Date(o.ExpectedDelivery).toLocaleDateString():'—'}</td>
    </tr>`;
  }).join('');
  document.getElementById('order-empty').style.display = orders.length?'none':'block';
  document.getElementById('order-count').textContent = `${orders.length} orders`;
}

function filterOrders(query) {
  renderOrders(query, document.getElementById('order-status-filter').value);
}

async function saveOrder() {
  const vendor = document.getElementById('order-vendor-sel').value;
  if (!vendor) { toast('err','Select a vendor'); return; }
  setLoading(true,'Creating order…');
  try {
    const fields = {
      Vendor: vendor,
      Location: document.getElementById('order-loc-sel').value,
      Status: document.getElementById('order-status-sel').value,
      OrderedBy: currentUser.name||currentUser.username,
      Items: document.getElementById('order-notes').value,
      Notes: document.getElementById('order-notes').value,
      ExpectedDelivery: document.getElementById('order-delivery').value||null
    };
    const order = await addListItem(LISTS.orders, fields);
    cache.orders.push(order);
    renderOrders(); renderDashboard();
    closeModal('modal-order');
    toast('ok','✓ Order created');
    sendSlackAlert(`🛒 New order: *${vendor}* for ${fields.Location} — ${fields.Status} (${currentUser.name||currentUser.username})`);
  } catch(e) { toast('err','Save failed: '+e.message); }
  finally { setLoading(false); }
}
