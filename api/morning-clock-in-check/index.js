/**
 * BSC Operations — Morning Clock-In Check
 *
 * Triggered daily by GitHub Actions cron (HTTP POST). Static Web Apps
 * managed Functions don't support Timer triggers, so the scheduling lives
 * in .github/workflows/morning-clock-in-check.yml.
 *
 * Auth: caller must send `X-Cron-Key` header matching env var CRON_KEY.
 *
 * Self-gating: GitHub cron is UTC and doesn't observe DST. To run reliably
 * at 6:20 AM Mountain year-round, the workflow fires twice (12:20 and 13:20
 * UTC) and this function only acts when the local Mountain hour:minute is
 * 6:20 (with a small tolerance window). The other invocation no-ops.
 *
 * Flow:
 *   1. Acquire Microsoft Graph app-only token (client_credentials)
 *   2. Read BSC_Settings → clock_in_alert_recipients (per-loc emails) +
 *      square_loc_map (Square loc id → BSC loc name)
 *   3. Query Square Labor for shifts started today, group by location
 *   4. For each BSC location with no shifts AND configured recipients,
 *      DM each recipient via the Slack bot (lookupByEmail then postMessage)
 *   5. Return JSON summary for the workflow log
 */

const https = require('https');

const SQUARE_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-10-17';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SLACK_BASE = 'https://slack.com/api';

// ── Tiny request helper (no extra dependencies) ───────────────────
function httpsRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      method,
      hostname: url.hostname,
      path: url.pathname + (url.search || ''),
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

async function jsonRequest(method, url, headers, payload) {
  const body = payload ? JSON.stringify(payload) : null;
  const h = { ...headers };
  if (body && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const res = await httpsRequest(method, url, h, body);
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = { raw: res.body }; }
  return { status: res.status, data: parsed };
}

// ── Mountain-time gate ────────────────────────────────────────────
// Returns the current hour and minute in America/Denver, no extra deps.
function nowInMountain() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric',
    month: '2-digit', day: '2-digit'
  });
  const parts = fmt.formatToParts(new Date()).reduce((acc, p) => {
    acc[p.type] = p.value; return acc;
  }, {});
  return {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    isoDate: `${parts.year}-${parts.month}-${parts.day}`
  };
}

// ── Microsoft Graph (app-only) ────────────────────────────────────
async function getGraphAppToken() {
  const tenantId = process.env.AAD_TENANT_ID || process.env.TENANT_ID;
  const clientId = process.env.AAD_CLIENT_ID;
  const clientSecret = process.env.AAD_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Missing AAD_TENANT_ID / AAD_CLIENT_ID / AAD_CLIENT_SECRET app settings');
  }
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default'
  }).toString();
  const res = await httpsRequest('POST', tokenUrl, {
    'Content-Type': 'application/x-www-form-urlencoded'
  }, body);
  let parsed; try { parsed = JSON.parse(res.body); } catch { parsed = { raw: res.body }; }
  if (res.status !== 200 || !parsed.access_token) {
    throw new Error(`Graph token failed (${res.status}): ${parsed.error_description || res.body}`);
  }
  return parsed.access_token;
}

async function graphGet(token, path) {
  const url = `${GRAPH_BASE}${path}`;
  const { status, data } = await jsonRequest('GET', url, { Authorization: `Bearer ${token}` });
  if (status >= 400) throw new Error(`Graph ${status}: ${data?.error?.message || JSON.stringify(data)}`);
  return data;
}

// ── BSC_Settings reader ───────────────────────────────────────────
// Returns a map { Title: Value } for everything in the BSC_Settings list.
async function loadBscSettings(graphToken) {
  const siteId = process.env.GRAPH_SITE_ID;
  if (!siteId) throw new Error('Missing GRAPH_SITE_ID app setting');
  // Look up the BSC_Settings list id by name (handles display-name edits)
  const lists = await graphGet(graphToken, `/sites/${siteId}/lists?$select=id,name,displayName&$top=200`);
  const target = (lists.value || []).find(l => l.name === 'BSC_Settings' || l.displayName === 'BSC_Settings');
  if (!target) throw new Error('BSC_Settings list not found in target site');
  let url = `/sites/${siteId}/lists/${target.id}/items?$expand=fields(select=Title,Value)&$top=500`;
  const out = {};
  while (url) {
    const page = await graphGet(graphToken, url);
    (page.value || []).forEach(item => {
      const f = item.fields || {};
      if (f.Title) out[f.Title] = f.Value || '';
    });
    const next = page['@odata.nextLink'];
    url = next ? next.replace('https://graph.microsoft.com/v1.0', '') : null;
  }
  return out;
}

// ── Square Labor ──────────────────────────────────────────────────
async function fetchTodaysShifts(squareLocIds) {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error('SQUARE_ACCESS_TOKEN not configured');
  // "Today" in Mountain time → start at midnight MT, end now.
  const { isoDate } = nowInMountain();
  const startAt = new Date(`${isoDate}T00:00:00-06:00`).toISOString(); // -06:00 covers MDT; for MST -07:00 would be earlier — using earlier window is safe (broader filter)
  const endAt = new Date().toISOString();
  const body = {
    query: {
      filter: {
        location_ids: squareLocIds,
        start: { start_at: startAt, end_at: endAt }
      }
    },
    limit: 200
  };
  const url = `${SQUARE_BASE}/labor/shifts/search`;
  const { status, data } = await jsonRequest('POST', url, {
    Authorization: `Bearer ${token}`,
    'Square-Version': SQUARE_VERSION
  }, body);
  if (status >= 400) throw new Error(`Square labor ${status}: ${data?.errors?.[0]?.detail || JSON.stringify(data)}`);
  return data.shifts || [];
}

// ── Slack (bot token, DM via lookupByEmail) ───────────────────────
async function slackLookupUserByEmail(email) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN not configured');
  const url = `${SLACK_BASE}/users.lookupByEmail?email=${encodeURIComponent(email)}`;
  const { data } = await jsonRequest('GET', url, { Authorization: `Bearer ${token}` });
  if (!data?.ok) return null;
  return data.user?.id || null;
}

async function slackPostDM(userId, text) {
  const token = process.env.SLACK_BOT_TOKEN;
  const url = `${SLACK_BASE}/chat.postMessage`;
  const { data } = await jsonRequest('POST', url, { Authorization: `Bearer ${token}` }, {
    channel: userId,
    text
  });
  if (!data?.ok) throw new Error(`Slack postMessage failed: ${data?.error || JSON.stringify(data)}`);
  return data;
}

// ── Main entry ────────────────────────────────────────────────────
module.exports = async function (context, req) {
  // Auth
  const expected = process.env.CRON_KEY;
  const got = req.headers['x-cron-key'];
  if (!expected || got !== expected) {
    context.res = { status: 401, body: { error: 'Unauthorized' } };
    return;
  }

  // Time gate: only act at 6:20 AM Mountain (allow 6:18–6:25 window)
  const mt = nowInMountain();
  const force = req.query?.force === '1';
  const inWindow = mt.hour === 6 && mt.minute >= 18 && mt.minute <= 25;
  if (!force && !inWindow) {
    context.res = {
      status: 200,
      body: { skipped: true, reason: `local Mountain time ${mt.hour}:${String(mt.minute).padStart(2,'0')} not in 6:20 window` }
    };
    return;
  }

  const summary = {
    mountainTime: `${mt.hour}:${String(mt.minute).padStart(2,'0')}`,
    locationsChecked: 0,
    locationsWithNoClockIn: [],
    alertsSent: [],
    errors: []
  };

  try {
    // 1. Settings
    const graphToken = await getGraphAppToken();
    const settings = await loadBscSettings(graphToken);
    const recipientsByLoc = JSON.parse(settings.clock_in_alert_recipients || '{}');
    const squareLocMap   = JSON.parse(settings.square_loc_map || '{}'); // squareId → bscName

    const squareLocIds = Object.keys(squareLocMap);
    if (!squareLocIds.length) {
      summary.errors.push('No square_loc_map configured');
      context.res = { status: 200, body: summary };
      return;
    }

    // 2. Shifts
    const shifts = await fetchTodaysShifts(squareLocIds);

    // 3. Group: BSC location → has at least one shift today?
    const haveShifts = new Set();
    shifts.forEach(s => {
      const bsc = squareLocMap[s.location_id];
      if (bsc) haveShifts.add(bsc);
    });

    // 4. For each BSC loc with recipients but no shift, DM each recipient
    for (const [bscLoc, emails] of Object.entries(recipientsByLoc)) {
      summary.locationsChecked++;
      if (haveShifts.has(bscLoc)) continue; // somebody clocked in
      if (!Array.isArray(emails) || !emails.length) continue;
      summary.locationsWithNoClockIn.push(bscLoc);
      for (const email of emails) {
        try {
          const userId = await slackLookupUserByEmail(email);
          if (!userId) { summary.errors.push(`No Slack user for ${email}`); continue; }
          await slackPostDM(userId, `:warning: Nobody has clocked in at *${bscLoc}* yet (${summary.mountainTime} Mountain). Please check on the team or open the store.`);
          summary.alertsSent.push({ loc: bscLoc, email });
        } catch (e) {
          summary.errors.push(`DM failed for ${email} (${bscLoc}): ${e.message}`);
        }
      }
    }

    context.res = { status: 200, body: summary };
  } catch (e) {
    context.log.error('morning-clock-in-check failed:', e.message);
    summary.errors.push(e.message);
    context.res = { status: 500, body: summary };
  }
};
