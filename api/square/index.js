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
 */

const https = require('https');
const { URL } = require('url');

const SQUARE_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-10-17';

module.exports = async function (context, req) {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) {
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'SQUARE_ACCESS_TOKEN not configured in Azure environment variables.' })
    };
    return;
  }

  // Build upstream Square URL
  const restPath = req.params.restPath || '';
  const qs = new URLSearchParams(req.query || {}).toString();
  const squareUrl = `${SQUARE_BASE}/${restPath}${qs ? '?' + qs : ''}`;

  const method = req.method.toUpperCase();
  const requestBody = (method !== 'GET' && req.rawBody) ? req.rawBody : null;

  context.log(`Square proxy: ${method} ${squareUrl}`);

  try {
    const result = await squareRequest(method, squareUrl, token, requestBody);
    context.res = {
      status: result.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
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
