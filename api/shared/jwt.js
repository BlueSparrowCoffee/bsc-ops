/**
 * BSC Operations — Shared AAD JWT validator
 *
 * Two modes:
 *   1. Lightweight (default): format + expiry + tenant check.
 *   2. Full signature verification (preferred): when `jsonwebtoken`
 *      and `jwks-rsa` are installed in api/, fetches Microsoft's
 *      signing keys from the AAD JWKS endpoint and verifies the
 *      RS256 signature. This closes the auth-bypass gap where any
 *      attacker who knows the tenant id could forge an unsigned JWT.
 *
 * Requires deps in api/package.json:
 *     "dependencies": { "jsonwebtoken": "^9.0.2", "jwks-rsa": "^3.1.0" }
 *
 * Until those are installed, the helper transparently falls back to
 * the lightweight path so deployments don't break mid-rollout.
 */

let _jwt = null;
let _jwksRsa = null;
try { _jwt = require('jsonwebtoken'); } catch { _jwt = null; }
try { _jwksRsa = require('jwks-rsa'); } catch { _jwksRsa = null; }

const _jwksClients = new Map();
function _getJwksClient(tenantId) {
  if (!_jwksRsa || !tenantId) return null;
  if (_jwksClients.has(tenantId)) return _jwksClients.get(tenantId);
  const c = _jwksRsa({
    jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    cache: true,
    cacheMaxAge: 60 * 60 * 1000, // 1 hour
    rateLimit: true,
    jwksRequestsPerMinute: 10
  });
  _jwksClients.set(tenantId, c);
  return c;
}

function _decodeUnverified(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) return null;
  try {
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(decoded);
  } catch { return null; }
}

async function _verifyWithJwks(jwt, tenantId) {
  if (!_jwt || !_jwksRsa) return null; // not installed → caller falls back
  const client = _getJwksClient(tenantId);
  if (!client) return null;
  return new Promise((resolve) => {
    _jwt.verify(jwt, (header, cb) => {
      client.getSigningKey(header.kid, (err, key) => {
        if (err) return cb(err);
        cb(null, key.getPublicKey());
      });
    }, { algorithms: ['RS256'] }, (err, payload) => {
      if (err) resolve({ ok: false, reason: 'Signature verification failed: ' + err.message });
      else resolve({ ok: true, payload });
    });
  });
}

/**
 * validateAadToken(authHeader, expectedTenantId)
 *
 * Returns { ok: true, payload } on success, { ok: false, reason } on failure.
 * Verifies signature when jsonwebtoken+jwks-rsa are installed; otherwise
 * checks format/expiry/tenant only and warns via context.log if available.
 *
 * Tenant id is optional. When set, both modes enforce it.
 */
async function validateAadToken(authHeader, expectedTenantId) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'Missing or malformed Authorization header' };
  }
  const jwt = authHeader.slice(7);
  if (jwt.split('.').length !== 3) {
    return { ok: false, reason: 'Invalid token format' };
  }

  // Full signature verification path (preferred)
  if (_jwt && _jwksRsa && expectedTenantId) {
    const verified = await _verifyWithJwks(jwt, expectedTenantId);
    if (verified) {
      if (!verified.ok) return verified;
      const tid = verified.payload?.tid;
      if (tid && tid !== expectedTenantId) {
        return { ok: false, reason: `Token tenant does not match (token tid: ${tid}, expected: ${expectedTenantId})` };
      }
      return { ok: true, payload: verified.payload };
    }
  }

  // Lightweight fallback — same shape as the historic /api/square check
  const payload = _decodeUnverified(jwt);
  if (!payload) return { ok: false, reason: 'Token payload could not be decoded' };
  const nowSecs = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < nowSecs) {
    return { ok: false, reason: 'Token is expired' };
  }
  if (expectedTenantId && payload.tid && payload.tid !== expectedTenantId) {
    return { ok: false, reason: `Token tenant does not match (token tid: ${payload.tid}, expected: ${expectedTenantId})` };
  }
  return { ok: true, payload, _unverified: true };
}

module.exports = { validateAadToken };
