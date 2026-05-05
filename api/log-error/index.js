/**
 * BSC Operations — Client Error Reporter
 *
 * Receives a compact error record from the browser and writes it to
 * BSC_ErrorLog via Microsoft Graph using the Function-app's app-only
 * service-principal credentials (same env vars as morning-clock-in-check:
 * AAD_CLIENT_ID, AAD_CLIENT_SECRET, TENANT_ID).
 *
 * The endpoint always returns 200 (even on internal failures) so the
 * client-side reporter can be fire-and-forget without amplifying
 * outages. Real failures show up in Function-app logs.
 *
 * Auth: caller must supply a valid AAD Bearer for the BSC tenant.
 *
 * Route: POST /api/log-error
 */

const https = require('https');
const { validateAadToken } = require('../shared/jwt');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SP_HOSTNAME = 'mainspringdevelopers.sharepoint.com';
const SP_SITE_PATH = '/sites/BlueSparrowCoffeeOps';
const SP_LIST = 'BSC_ErrorLog';

module.exports = async function (context, req) {
  // Always 200 — the reporter must not amplify outages
  const reply = (extra) => { context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: { ok: true, ...extra } }; };

  const tenantId = process.env.TENANT_ID || null;
  const auth = await validateAadToken(req.headers['authorization'], tenantId);
  if (!auth.ok) { reply({ skipped: 'unauthorized' }); return; }

  const body = req.body || {};
  const message = String(body.message || '').slice(0, 240);
  if (!message) { reply({ skipped: 'no message' }); return; }

  try {
    const token = await getGraphAppToken();
    const siteId = await resolveSiteId(token);
    const fields = {
      Title:     message.slice(0, 240),
      Source:    String(body.source    || '').slice(0, 60),
      Severity:  String(body.severity  || 'error').slice(0, 20),
      Url:       String(body.url       || '').slice(0, 500),
      UserAgent: String(body.userAgent || '').slice(0, 500),
      Username:  String(body.username  || '').slice(0, 200),
      Body:      String(body.body      || '').slice(0, 8000)
    };
    await graphPost(token, `/sites/${siteId}/lists/${SP_LIST}/items`, { fields });
    reply({ written: true });
  } catch (e) {
    context.log.warn('log-error failed:', e?.message || e);
    reply({ skipped: 'graph-error' });
  }
};

async function getGraphAppToken() {
  const tenantId = process.env.TENANT_ID;
  const clientId = process.env.AAD_CLIENT_ID;
  const clientSecret = process.env.AAD_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('AAD app credentials not configured (TENANT_ID/AAD_CLIENT_ID/AAD_CLIENT_SECRET)');
  }
  const body =
    `client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent('https://graph.microsoft.com/.default')}` +
    `&client_secret=${encodeURIComponent(clientSecret)}` +
    `&grant_type=client_credentials`;
  const r = await rawHttps('POST',
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    body);
  const parsed = JSON.parse(r.body);
  if (!parsed.access_token) throw new Error('No access_token in AAD response');
  return parsed.access_token;
}

async function resolveSiteId(token) {
  const r = await rawHttps('GET',
    `${GRAPH_BASE}/sites/${SP_HOSTNAME}:${SP_SITE_PATH}?$select=id`,
    { 'Authorization': 'Bearer ' + token });
  if (r.status >= 200 && r.status < 300) {
    const j = JSON.parse(r.body);
    return j.id;
  }
  throw new Error('Site lookup failed: ' + r.status + ' ' + r.body);
}

async function graphPost(token, path, payload) {
  const r = await rawHttps('POST', GRAPH_BASE + path,
    { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    JSON.stringify(payload));
  if (r.status < 200 || r.status >= 300) {
    throw new Error('Graph POST ' + path + ' → ' + r.status + ' ' + r.body);
  }
  return r.body ? JSON.parse(r.body) : null;
}

function rawHttps(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
