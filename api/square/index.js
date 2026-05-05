/**
 * BSC Operations — Square API Proxy
 * Securely proxies requests to Square APIs so the access token
 * never reaches the browser.
 *
 * Route: /api/square/{*restPath}
 * Examples:
 *   GET  /api/square/locations
 *   GET  /api/square/team-members?limit=200
 *   GET  /api/square/catalog/list?types=ITEM,CATEGORY
 *   POST /api/square/inventory/counts/batch-retrieve
 *
 * Auth: caller must supply a valid MSAL Bearer token in the
 * Authorization header. The token's tenant ID is checked against
 * TENANT_ID env var (defaults to BSC's tenant) and expiry is enforced.
 */

const https = require('https');
const { URL } = require('url');
const { validateAadToken } = require('../shared/jwt');

const SQUARE_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-10-17';

/**
 * AAD JWT validation lives in api/shared/jwt.js and prefers full
 * signature verification (jsonwebtoken + jwks-rsa) when those packages
 * are installed in api/. Without them, it falls back to the original
 * format/expiry/tenant check so existing deployments don't break.
 *
 * To turn on signature verification: add `jsonwebtoken` and `jwks-rsa`
 * to api/package.json, run `npm install` (or let SWA's automated build
 * pick them up on next deploy), and set TENANT_ID in Azure Portal.
 */

module.exports = async function (context, req) {
  // ── Auth check ────────────────────────────────────────────────────────────
  // TENANT_ID is optional — if not set, any valid non-expired MSAL JWT passes
  const tenantId = process.env.TENANT_ID || null;
  const authResult = await validateAadToken(req.headers['authorization'], tenantId);
  if (!authResult.ok) {
    context.log.warn('Square proxy: auth rejected —', authResult.reason);
    context.res = {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized', reason: authResult.reason })
    };
    return;
  }
  if (authResult._unverified) {
    context.log.warn('Square proxy: token signature NOT verified — install jsonwebtoken + jwks-rsa in api/ to close this gap.');
  }

  // ── Square token ──────────────────────────────────────────────────────────
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) {
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'SQUARE_ACCESS_TOKEN not configured in Azure environment variables.' })
    };
    return;
  }

  // ── Build upstream Square URL ─────────────────────────────────────────────
  const restPath = req.params.restPath || '';
  const qs = new URLSearchParams(req.query || {}).toString();
  const squareUrl = `${SQUARE_BASE}/${restPath}${qs ? '?' + qs : ''}`;

  const method = req.method.toUpperCase();
  const requestBody = (method !== 'GET' && req.rawBody) ? req.rawBody : null;

  context.log(`Square proxy: ${method} ${squareUrl}`);

  // ── Restrict CORS to the configured app origin only ───────────────────────
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  const requestOrigin = req.headers['origin'] || '';
  const corsOrigin = (allowedOrigin && requestOrigin === allowedOrigin) ? allowedOrigin : '';

  try {
    const result = await squareRequest(method, squareUrl, token, requestBody);
    const headers = { 'Content-Type': 'application/json' };
    if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
    context.res = {
      status: result.status,
      headers,
      body: result.body
    };
  } catch (e) {
    context.log.error('Square proxy error:', e.message);
    context.res = {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message })
    };
  }
};

function squareRequest(method, squareUrl, token, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(squareUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Square-Version': SQUARE_VERSION,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      }
    };

    const httpReq = https.request(options, (httpRes) => {
      let data = '';
      httpRes.on('data', chunk => { data += chunk; });
      httpRes.on('end', () => resolve({ status: httpRes.statusCode, body: data }));
    });

    httpReq.on('error', reject);
    if (body) httpReq.write(body);
    httpReq.end();
  });
}
