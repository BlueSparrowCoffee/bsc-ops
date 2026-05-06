/**
 * BSC Operations — Photo Evidence Upload (PR 19a)
 *
 * Receives a checklist task photo from the browser and stores it in
 * SharePoint via Microsoft Graph (drive uploads under the BSC ops
 * site's Documents library, organized by run/task). Returns the
 * sharing URL the client can stash in BSC_ChecklistTaskLogs.PhotoUrls.
 *
 * Auth: caller must supply a valid AAD Bearer for the BSC tenant
 * (same model as log-error). The Function then exchanges its own
 * app-only credentials for a Graph token to perform the upload.
 *
 * Body (raw application/octet-stream):
 *   - The image bytes themselves.
 *   Headers: x-bsc-runid, x-bsc-taskid, x-bsc-filename, content-type
 *
 * Or multipart/form-data with fields runId, taskId, file (browser-friendly).
 *
 * Route: POST /api/upload-photo
 *
 * Storage path:
 *   /sites/BlueSparrowCoffeeOps/Documents/checklist-photos/{runId}/{taskId}/{filename}
 *
 * Returns:
 *   200 { ok: true, url: "https://...", driveItemId: "..." }
 *   400 / 401 / 5xx with { ok: false, error: "..." }
 */

const https = require('https');
const { validateAadToken } = require('../shared/jwt');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SP_HOSTNAME = 'mainspringdevelopers.sharepoint.com';
const SP_SITE_PATH = '/sites/BlueSparrowCoffeeOps';
const PHOTO_FOLDER = 'checklist-photos';

module.exports = async function (context, req) {
  const reply = (status, body) => { context.res = { status, headers: { 'Content-Type': 'application/json' }, body }; };

  const tenantId = process.env.TENANT_ID || null;
  const auth = await validateAadToken(req.headers['authorization'], tenantId);
  if (!auth.ok) { reply(401, { ok: false, error: 'unauthorized' }); return; }

  // Accept either multipart/form-data (browser FormData) or raw bytes
  // with x-bsc-* headers (lighter-weight alternative).
  let runId, taskId, filename, contentType, fileBytes;
  const ctHeader = (req.headers['content-type'] || '').toLowerCase();
  try {
    if (ctHeader.startsWith('multipart/form-data')) {
      const parsed = parseMultipart(req.body, ctHeader);
      runId = parsed.fields.runId || '';
      taskId = parsed.fields.taskId || '';
      const file = parsed.files.file;
      if (!file) { reply(400, { ok: false, error: 'missing file field' }); return; }
      filename = sanitizeFilename(file.filename || `photo-${Date.now()}.jpg`);
      contentType = file.contentType || 'image/jpeg';
      fileBytes = file.bytes;
    } else {
      runId    = String(req.headers['x-bsc-runid']    || '').slice(0, 200);
      taskId   = String(req.headers['x-bsc-taskid']   || '').slice(0, 200);
      filename = sanitizeFilename(String(req.headers['x-bsc-filename'] || `photo-${Date.now()}.jpg`));
      contentType = ctHeader || 'image/jpeg';
      fileBytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    }
  } catch (e) {
    reply(400, { ok: false, error: 'bad request: ' + (e.message || e) });
    return;
  }

  if (!fileBytes || !fileBytes.length) { reply(400, { ok: false, error: 'empty file' }); return; }
  if (fileBytes.length > 10 * 1024 * 1024) { reply(413, { ok: false, error: 'file too large (>10 MB)' }); return; }

  try {
    const token = await getGraphAppToken();
    const driveId = await resolveDriveId(token);
    const path = `${PHOTO_FOLDER}/${cleanSegment(runId)}/${cleanSegment(taskId)}/${filename}`;
    const uploaded = await uploadToDrive(token, driveId, path, fileBytes, contentType);
    reply(200, { ok: true, url: uploaded.webUrl, driveItemId: uploaded.id });
  } catch (e) {
    context.log.warn('upload-photo failed:', e?.message || e);
    reply(500, { ok: false, error: e?.message || String(e) });
  }
};

// ── Helpers ───────────────────────────────────────────────────────
function sanitizeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || `photo-${Date.now()}.jpg`;
}
function cleanSegment(s) {
  return String(s || 'unsorted').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'unsorted';
}

// Minimal multipart/form-data parser — pulls fields + files into
// flat objects. Sufficient for the photo-upload use case (one
// `file` field plus a few text fields). Heavier libs would be
// overkill for an API with one endpoint.
function parseMultipart(body, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error('no multipart boundary');
  const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]).trim();
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const fields = {};
  const files  = {};
  // Split on boundary; each part is a header section + CRLF CRLF + body
  let start = 0;
  const boundaryBuf = Buffer.from('\r\n' + boundary);
  const headBuf     = Buffer.from(boundary + '\r\n');
  // Skip leading boundary
  let i = buf.indexOf(headBuf);
  if (i === -1) throw new Error('multipart: leading boundary not found');
  start = i + headBuf.length;
  while (true) {
    const next = buf.indexOf(boundaryBuf, start);
    if (next === -1) break;
    const part = buf.slice(start, next);
    const sep = part.indexOf(Buffer.from('\r\n\r\n'));
    if (sep === -1) break;
    const headers = part.slice(0, sep).toString('utf8');
    const content = part.slice(sep + 4);
    const dispMatch = headers.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (dispMatch) {
      const name = dispMatch[1];
      const fname = dispMatch[2];
      if (fname !== undefined) {
        const ctMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
        files[name] = {
          filename: fname,
          contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
          bytes: content
        };
      } else {
        fields[name] = content.toString('utf8');
      }
    }
    start = next + boundaryBuf.length;
    // bail on closing boundary "--"
    if (buf.slice(start, start + 2).toString() === '--') break;
    if (buf.slice(start, start + 2).toString() === '\r\n') start += 2;
  }
  return { fields, files };
}

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

let _cachedDriveId = null;
async function resolveDriveId(token) {
  if (_cachedDriveId) return _cachedDriveId;
  const r = await rawHttps('GET',
    `${GRAPH_BASE}/sites/${SP_HOSTNAME}:${SP_SITE_PATH}:/drive?$select=id`,
    { 'Authorization': 'Bearer ' + token });
  if (r.status >= 200 && r.status < 300) {
    _cachedDriveId = JSON.parse(r.body).id;
    return _cachedDriveId;
  }
  throw new Error('Drive lookup failed: ' + r.status + ' ' + r.body);
}

async function uploadToDrive(token, driveId, path, bytes, contentType) {
  // Direct PUT works for files <= 4 MB. For larger, would need an
  // upload session; capped at 10 MB above so a single PUT is always
  // valid here. Path-based PUT auto-creates intermediate folders.
  const url = `${GRAPH_BASE}/drives/${driveId}/root:/${encodeURI(path)}:/content`;
  const r = await rawHttpsBytes('PUT', url, {
    'Authorization': 'Bearer ' + token,
    'Content-Type': contentType
  }, bytes);
  if (r.status < 200 || r.status >= 300) {
    throw new Error('Drive PUT ' + path + ' → ' + r.status + ' ' + r.body);
  }
  return JSON.parse(r.body);
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

function rawHttpsBytes(method, urlStr, headers, bytes) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      headers: { ...headers, 'Content-Length': bytes.length }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(bytes);
    req.end();
  });
}
