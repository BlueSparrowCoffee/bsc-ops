/* ================================================================
 * BSC Ops — ordering.js
 * Orders list (page-ordering): render + status filter + create-order
 * flow. Backed by BSC_Orders.
 *
 * Contents:
 *   - renderOrders(query, statusFilter)
 *   - filterOrders(query)
 *   - saveOrder()  — adds one row from modal-order
 *
 * Depends on:
 *   state.js     — cache, currentUser
 *   constants.js — LISTS
 *   utils.js     — escHtml, toast, closeModal, setLoading, debounceFilter
 *   graph.js     — addListItem
 *   dashboard.js — renderDashboard
 *   slack.js     — sendSlackAlert
 * ================================================================ */

function renderOrders(query='', statusFilter='') {
  let orders = [...cache.orders].reverse();
  if (query) orders = orders.filter(o=>JSON.stringify(o).toLowerCase().includes(query.toLowerCase()));
  if (statusFilter) orders = orders.filter(o=>o.Status===statusFilter);
  const tbody = document.getElementById('order-body');
  tbody.innerHTML = orders.map(o=>{
    const badges = {Pending:'badge-gold',Ordered:'badge-blue',Delivered:'badge-green',Cancelled:'badge-gray'};
    return `<tr>
      <td>${o.Created?new Date(o.Created).toLocaleDateString():'—'}</td>
      <td class="fw">${escHtml(o.Vendor||'—')}</td>
      <td style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(o.Items||o.Notes||'—')}</td>
      <td>${escHtml(o.Location||'—')}</td>
      <td><span class="badge ${badges[o.Status]||'badge-gray'}">${escHtml(o.Status||'—')}</span></td>
      <td>${escHtml(o.OrderedBy||'—')}</td>
      <td>${o.ExpectedDelivery?new Date(o.ExpectedDelivery).toLocaleDateString():'—'}</td>
      <td style="color:var(--muted);font-size:12px">${escHtml(o.Notes||'')}</td>
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
