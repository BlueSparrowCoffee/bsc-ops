/* ================================================================
 * BSC Ops — timeclock.js
 * Dashboard "Currently Clocked In" card. Reads currently-open
 * shifts from the Square Labor API (proxied via /api/square/...)
 * and groups by BSC location.
 *
 * Depends on:
 *   - state.js (cache)
 *   - square.js (squareAPI, getSquareLocMap)
 *   - utils.js (escHtml)
 * ================================================================ */

let _teamMemberCache = null;
let _teamMemberCacheLoadedAt = 0;
const _TEAM_MEMBER_CACHE_TTL_MS = 10 * 60 * 1000;

// Load Square team member ID → display name. Cached for 10 min so
// the dashboard card doesn't paginate on every refresh.
async function _loadTeamMemberMap() {
  const now = Date.now();
  if (_teamMemberCache && (now - _teamMemberCacheLoadedAt) < _TEAM_MEMBER_CACHE_TTL_MS) {
    return _teamMemberCache;
  }
  const map = {};
  try {
    let cursor = null;
    do {
      const body = { limit: 200, ...(cursor ? { cursor } : {}) };
      const data = await squareAPI('POST', 'team-members/search', body);
      (data.team_members || []).forEach(m => {
        const name = [m.given_name, m.family_name].filter(Boolean).join(' ')
          || m.email_address
          || m.id;
        map[m.id] = name;
      });
      cursor = data.cursor || null;
    } while (cursor);
    _teamMemberCache = map;
    _teamMemberCacheLoadedAt = now;
  } catch (e) {
    console.warn('[BSC] team-members fetch failed:', e.message);
  }
  return _teamMemberCache || map;
}

async function loadActiveShifts() {
  const locMap = getSquareLocMap();
  const locIds = Object.keys(locMap);
  if (!locIds.length) return [];
  const body = {
    query: { filter: { location_ids: locIds, status: 'OPEN' } },
    limit: 100
  };
  const data = await squareAPI('POST', 'labor/shifts/search', body);
  const shifts = data.shifts || [];
  if (!shifts.length) return [];
  const memberMap = await _loadTeamMemberMap();
  return shifts.map(s => {
    const tmId = s.team_member_id || s.employee_id;
    return {
      shiftId:        s.id,
      teamMemberId:   tmId,
      teamMemberName: memberMap[tmId] || 'Unknown',
      locationId:     s.location_id,
      locationName:   locMap[s.location_id] || s.location_id,
      startedAt:      s.start_at,
    };
  });
}

async function renderClockedInCard() {
  const card = document.getElementById('dash-clocked-in-card');
  const body = document.getElementById('dash-clocked-in-body');
  if (!card || !body) return;
  // Hide entirely if Square isn't configured for this tenant.
  const locMap = getSquareLocMap();
  if (!Object.keys(locMap).length) { card.style.display = 'none'; return; }
  card.style.display = '';

  body.innerHTML = '<div class="no-data" style="padding:16px">Loading…</div>';
  try {
    const shifts = await loadActiveShifts();
    if (!shifts.length) {
      body.innerHTML = '<div class="no-data" style="padding:16px">No one is clocked in right now.</div>';
      return;
    }
    const byLoc = {};
    shifts.forEach(s => { (byLoc[s.locationName] = byLoc[s.locationName] || []).push(s); });
    Object.values(byLoc).forEach(arr => arr.sort((a,b) =>
      (a.startedAt||'').localeCompare(b.startedAt||'')
    ));
    const fmt = ts => {
      try { return new Date(ts).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }); }
      catch { return ''; }
    };
    body.innerHTML = Object.keys(byLoc).sort().map(loc => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0 6px;margin-top:6px;border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;">
        <span>${escHtml(loc)}</span>
        <span style="margin-left:auto;font-weight:600;color:var(--muted);">${byLoc[loc].length}</span>
      </div>
      ${byLoc[loc].map(s => `
        <div class="alert-item">
          <div class="alert-dot" style="background:#16a34a"></div>
          <span>${escHtml(s.teamMemberName)}</span>
          <span style="margin-left:auto;font-size:11px;color:var(--muted);">in @ ${fmt(s.startedAt)}</span>
        </div>`).join('')}
    `).join('');
  } catch (e) {
    body.innerHTML = `<div class="no-data" style="padding:16px;color:var(--red);">Could not load active shifts: ${escHtml(e.message)}</div>`;
  }
}
