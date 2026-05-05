/**
 * BSC Operations — Slack Post Proxy
 *
 * Forwards `{ text, channel }` to the configured Slack incoming webhook.
 * The webhook URL lives in the SLACK_WEBHOOK_URL env var on the Function
 * app — never in page source. Caller must supply a valid AAD Bearer.
 *
 * Route: POST /api/slack-post
 *
 * Auth: same JWT shape as /api/square. Signature verification is added
 * by the helper in ../shared/jwt.js when AAD_JWKS_VERIFY=1; otherwise we
 * fall back to format/expiry/tenant validation.
 */

const https = require('https');
const { URL } = require('url');
const { validateAadToken } = require('../shared/jwt');

module.exports = async function (context, req) {
  const tenantId = process.env.TENANT_ID || null;
  const auth = await validateAadToken(req.headers['authorization'], tenantId);
  if (!auth.ok) {
    context.res = { status: 401, headers: { 'Content-Type': 'application/json' }, body: { error: 'Unauthorized', reason: auth.reason } };
    return;
  }

  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: 'SLACK_WEBHOOK_URL not configured' } };
    return;
  }

  const body = req.body || {};
  const text = String(body.text || '').slice(0, 4000);
  const channel = String(body.channel || '').slice(0, 80) || undefined;
  if (!text) {
    context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: { error: 'text required' } };
    return;
  }

  try {
    const result = await postJSON(webhook, channel ? { text, channel } : { text });
    context.res = {
      status: result.status >= 200 && result.status < 300 ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
      body: { ok: result.status >= 200 && result.status < 300, slackStatus: result.status }
    };
  } catch (e) {
    context.log.error('Slack post error:', e.message);
    context.res = { status: 502, headers: { 'Content-Type': 'application/json' }, body: { error: e.message } };
  }
};

function postJSON(urlStr, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
