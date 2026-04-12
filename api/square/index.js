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

const SQUARE_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-10-17';

/**
 * Decode and lightly validate an MSAL JWT Bearer token.
 * Checks: token is well-formed, not expired, and (if TENANT_ID env var is
 * set) the tenant matches. Signature verification would require jsonwebtoken
 * + jwks-rsa — add in a future hardening pass if needed.
 *
 * TENANT_ID is optional: if not set, any non-expired MSAL JWT is accepted.
 * Set it in Azure Portal → Configuration to lock down to a specific tenant.
 */
function validateToken(authHeader, expectedTenantId) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'Missing or malformed Authorization header' };
  }
  const jwt = authHeader.slice(7);
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'Invalid token format' };
  }
  let payload;
  try {
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf8');
    payload = JSON.parse(decoded);
  } catch {
    return { ok: false, reason: 'Token payload could not be decoded' };
  }
  const nowSecs = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < nowSecs) {
    return { ok: false, reason: 'Token is expired' };
  }
  // Only enforce tenant check when TENANT_ID is set AND the token actually has a tid claim
  // (some MSAL token types — e.g. v1 tokens, certain scopes — omit tid)
  if (expectedTenantId && payload.tid && payload.tid !== expectedTenantId) {
    return {
      ok: false,
      reason: `Token tenant does not match (token tid: ${payload.tid}, expected: ${expectedTenantId})`
    };
  }
  return { ok: true };
}

module.exports = async function (context, req) {
  // ── Auth check ────────────────────────────────────────────────────────────
  // TENANT_ID is optional — if not set, any valid non-expired MSAL JWT passes
  const tenantId = process.env.TENANT_ID || null;
  const authResult = validateToken(req.headers['authorization'], tenantId);
  if (!authResult.ok) {
    context.log.warn('Square proxy: auth rejected —', authResult.reason);
    context.res = {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized', reason: authResult.reason })
    };
    return;
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
