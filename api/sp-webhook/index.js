/**
 * BSC Operations — SharePoint Webhook Receiver
 *
 * SharePoint sends a POST here whenever an item in a subscribed list changes.
 * This function immediately acknowledges the request (SharePoint requires a
 * 200 response within 5 seconds), then broadcasts which list changed to all
 * connected browser clients via SignalR so they can silently re-fetch data.
 *
 * Route: POST /api/sp-webhook
 *
 * Also handles the one-time validation challenge SharePoint sends when a
 * webhook subscription is first registered (GET with ?validationtoken=...).
 */
module.exports = async function (context, req) {
  // ── Validation challenge (sent once on subscription registration) ──────────
  // SharePoint sends a GET/POST with ?validationtoken=<token> and expects the
  // exact token echoed back as plain text within 5 seconds.
  const validationToken = req.query && req.query.validationtoken;
  if (validationToken) {
    context.log('SharePoint webhook validation challenge received');
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: validationToken
    };
    return;
  }

  // ── Normal change notification ─────────────────────────────────────────────
  const notifications = (req.body && req.body.value) || [];
  context.log(`Received ${notifications.length} SharePoint notification(s)`);

  if (!notifications.length) {
    context.res = { status: 200 };
    return;
  }

  // Extract list keys from clientState (set to "bscops-{listKey}" at registration)
  const messages = notifications
    .filter(n => n.clientState && n.clientState.startsWith('bscops-'))
    .map(n => ({
      target: 'listChanged',
      arguments: [{ listKey: n.clientState.replace('bscops-', '') }]
    }));

  // Deduplicate: if the same list fires multiple notifications in one batch,
  // only broadcast once per list key
  const seen = new Set();
  const deduped = messages.filter(m => {
    const key = m.arguments[0].listKey;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  context.bindings.signalRMessages = deduped;
  context.res = { status: 200 };
};
