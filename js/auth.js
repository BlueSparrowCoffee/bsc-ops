/* ================================================================
 * BSC Ops — auth.js
 * Microsoft identity / MSAL v2. Holds app configuration (CFG),
 * OAuth scopes, the MSAL client instance, and the sign-in / token
 * acquisition helpers.
 *
 * Requires window.msal (the official MSAL.js v2 UMD) to be loaded
 * before this script. Depends on state.js (currentUser/cache) and
 * utils.js (toast).
 * ================================================================ */

// ── App configuration ───────────────────────────────────────────
// clientId/tenantId point at the BSC Ops AAD app registration.
// locations is the canonical list of physical BSC sites.
// internalDomains gates staff-access provisioning (direct grant vs B2B
// invite). Any email ending in one of these is treated as a tenant
// member — the auto-grant flow adds them to the SharePoint members
// group directly. Other emails get a B2B guest invite.
//
// Slack webhooks are no longer baked into the page at deploy time. All
// Slack posts now route through /api/slack-post, which reads
// SLACK_WEBHOOK_URL from the Function-app environment. This keeps the
// webhook out of page source (it was readable to any AAD-authenticated
// user via "View Source" before this change).
const CFG = {
  clientId:        'a466e07b-68f4-4881-bdcc-d3adeb356799',
  tenantId:        'b808062f-1ca4-4f25-a2eb-8998fac8dc52',
  locations:       ['Blake','Platte','Sherman','17th'],
  internalDomains: ['bluesparrowcoffee.com', 'mainspringco.com']
};

// True when the email belongs to one of CFG.internalDomains. Used by
// the staff-grant + sync-access flows so all our verified-tenant
// domains are treated as internal (no B2B invite needed).
function isInternalEmail(email) {
  const e = String(email || '').toLowerCase();
  if (!e) return false;
  return CFG.internalDomains.some(d => e.endsWith('@' + String(d).toLowerCase()));
}

// ── OAuth scopes ────────────────────────────────────────────────
// SCOPES       — requested on every login/token call
// ADMIN_SCOPES — requested only when the owner runs Staff Access Sync
// Mail.Send is delegated, user-consentable (no admin consent needed).
// Used by ordering-build.js when "auto-send orders by email" is enabled.
const SCOPES       = ['Sites.ReadWrite.All','Files.ReadWrite','User.Read','Mail.Send'];
const ADMIN_SCOPES = [...SCOPES, 'Sites.FullControl.All','User.Invite.All','User.Read.All','User.ReadWrite.All'];

// ── MSAL client ─────────────────────────────────────────────────
// sessionStorage cache so an accidental tab close doesn't leave a
// stale token around; redirectUri is whatever origin we're loaded from.
const msal = new window.msal.PublicClientApplication({
  auth: {
    clientId:    CFG.clientId,
    authority:   `https://login.microsoftonline.com/${CFG.tenantId}`,
    redirectUri: window.location.origin + '/'
  },
  cache: { cacheLocation: 'sessionStorage' }
});

// ── Sign-in / sign-out ──────────────────────────────────────────
async function signIn() {
  try {
    // Trigger the welcome splash on the post-redirect page load. sessionStorage
    // survives the round-trip to login.microsoftonline.com.
    sessionStorage.setItem('bsc_force_splash', '1');
    await msal.loginRedirect({ scopes: SCOPES });
  }
  catch(e) { toast('err','Sign-in failed: '+e.message); }
}

async function signOut() {
  await msal.logoutRedirect({ account: currentUser });
}

// ── Staff / user resolution ─────────────────────────────────────
// applyUser() shows the Microsoft name immediately after login.
// resolveCurrentStaffMember() runs after cache.staff is populated to
// link the signed-in Microsoft account to a BSC_Staff record (for
// role/location access decisions).
function applyUser() {
  const displayName = currentUser.name || currentUser.username || '';
  const firstName = displayName.split(' ')[0];
  document.getElementById('user-label').textContent = firstName;
  document.getElementById('user-avatar').textContent = firstName.charAt(0).toUpperCase();
  document.getElementById('auth-screen').classList.remove('show');
}

function resolveCurrentStaffMember() {
  if (!currentUser || !cache.staff.length) return;
  const email = (currentUser.username || currentUser.mail || '').toLowerCase();
  currentStaffMember = cache.staff.find(s => (s.Email||'').toLowerCase() === email) || null;
  updateTopbarStaffInfo();
}

function updateTopbarStaffInfo() {
  const nameEl   = document.getElementById('user-label');
  const roleEl   = document.getElementById('user-role-label');
  const avatarEl = document.getElementById('user-avatar');

  if (currentStaffMember) {
    const name  = currentStaffMember.Title || currentUser?.name || currentUser?.username || '';
    const first = name.split(' ')[0];
    const realRole = currentStaffMember.Role || '';
    const displayRole = _roleOverride || realRole;
    const loc   = currentStaffMember.LocationAccess === 'All' || !currentStaffMember.LocationAccess
      ? 'All locations'
      : currentStaffMember.LocationAccess;

    if (nameEl) nameEl.textContent = first;
    if (roleEl) {
      const ownerCanSwitch = _realIsOwner();
      const testingSuffix = _roleOverride ? ` <span style="color:var(--orange);font-weight:600;">🧪</span>` : '';
      const baseLabel = displayRole ? `${escHtml(displayRole)} · ${escHtml(loc)}` : escHtml(loc);
      roleEl.innerHTML = baseLabel + testingSuffix;
      if (ownerCanSwitch) {
        roleEl.style.cursor = 'pointer';
        roleEl.style.textDecoration = 'underline dotted rgba(185,223,227,.3)';
        roleEl.title = 'Click to test as another role';
        roleEl.onclick = openRoleSwitcher;
      } else {
        roleEl.style.cursor = '';
        roleEl.style.textDecoration = '';
        roleEl.title = '';
        roleEl.onclick = null;
      }
    }
    if (avatarEl) {
      avatarEl.textContent = first.charAt(0).toUpperCase();
    }
  } else if (currentUser) {
    // Logged in via Microsoft but no matching staff record
    const displayName = currentUser.name || currentUser.username || '';
    const first = displayName.split(' ')[0];
    if (nameEl)   nameEl.textContent = first;
    if (roleEl)   roleEl.innerHTML = `<span style="color:var(--orange);">⚠ Not linked</span>`;
    if (avatarEl) avatarEl.textContent = '?';
    // Show the unlinked banner
    const banner = document.getElementById('unlinked-banner');
    const emailEl = document.getElementById('unlinked-email');
    if (banner)  banner.style.display = 'flex';
    if (emailEl) emailEl.textContent = currentUser.username || currentUser.mail || '';
  }
}

// ── Permission helpers ──────────────────────────────────────────
// Role gates used all over the app (inventory, nav, signalr, cogs…).
// Defined here so every downstream module can rely on them at call
// time. Unlinked logins are treated as permissive during setup —
// once a staff record exists the real role string governs access.
//
// Owners can temporarily simulate other roles via the topbar role
// switcher (for testing). _roleOverride holds the simulated role name;
// _effectiveRole() returns the simulated role when active, otherwise
// the real one. _realIsOwner() bypasses the override so the switcher
// itself stays accessible.
let _roleOverride = null;
try { _roleOverride = sessionStorage.getItem('bsc_role_override') || null; } catch {}

function _realRole() {
  if (!currentStaffMember) return '';
  return (currentStaffMember.Role || '').toLowerCase();
}
function _realIsOwner() {
  if (!currentUser) return false;
  if (!currentStaffMember) return true; // unlinked → permissive
  const r = _realRole();
  return r.includes('owner') || r.includes('admin');
}
function _effectiveRole() {
  if (_roleOverride) return _roleOverride.toLowerCase();
  return _realRole();
}

function isManagerOrOwner() {
  if (!currentUser) return false;
  if (!currentStaffMember && !_roleOverride) return true;
  const role = _effectiveRole();
  return role.includes('manager') || role.includes('owner') || role.includes('admin') || role === '';
}

function isOwner() {
  if (!currentUser) return false;
  if (!currentStaffMember && !_roleOverride) return true;
  const role = _effectiveRole();
  return role.includes('owner') || role.includes('admin');
}

function isOwnerOrAccounting() {
  if (!currentUser) return false;
  if (!currentStaffMember && !_roleOverride) return true;
  const role = _effectiveRole();
  return role.includes('owner') || role.includes('admin') || role.includes('accounting');
}

// True only for accounting-role users (NOT owner/admin). Drives the
// accounting-specific dashboard view: financial cards only, operational
// cards hidden. Owners always see the full owner dashboard.
// PR 12 — Counter role. Lowest-privilege inventory role: read-only par,
// vendor, cost; can enter counts but submits to Lead/Manager for approval
// (approval inbox is OOS per design handoff — currently a stub).
// Owner/Manager are NOT considered Counter even if they simulate.
function isCounter() {
  if (!currentUser) return false;
  if (!currentStaffMember && !_roleOverride) return false;
  const role = _effectiveRole();
  if (role.includes('owner') || role.includes('admin') || role.includes('manager')) return false;
  return role.includes('counter');
}

function isAccountingOnly() {
  if (!currentUser) return false;
  if (!currentStaffMember && !_roleOverride) return false;
  const role = _effectiveRole();
  if (role.includes('owner') || role.includes('admin')) return false;
  return role.includes('accounting');
}

// ── Role override (owner-only testing tool) ──────────────────────
function setRoleOverride(role) {
  if (!_realIsOwner()) return;
  if (role) {
    _roleOverride = role;
    try { sessionStorage.setItem('bsc_role_override', role); } catch {}
  } else {
    _roleOverride = null;
    try { sessionStorage.removeItem('bsc_role_override'); } catch {}
  }
  closeRoleSwitcher();
  updateTopbarStaffInfo();
  if (typeof applyModulePermissions === 'function') applyModulePermissions();
  if (typeof renderLocations === 'function') renderLocations();
  if (typeof renderDashboard === 'function') renderDashboard();
  if (typeof toast === 'function') {
    toast('ok', role ? `🧪 Testing as ${role}` : '✓ Restored to Owner view');
  }
}
function clearRoleOverride() { setRoleOverride(null); }

function openRoleSwitcher() {
  if (!_realIsOwner()) return;
  const pop = document.getElementById('role-switcher-pop');
  if (!pop) return;
  // Build option list — pull dynamic role names from BSC_Roles, fall back to defaults
  const dynamicRoles = (cache.roles || [])
    .map(r => (r.RoleName || '').trim())
    .filter(Boolean);
  const defaults = ['Owner', 'Manager', 'Accounting', 'Counter', 'Staff'];
  const seen = new Set();
  const roles = [...defaults, ...dynamicRoles].filter(r => {
    const k = r.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const active = (_roleOverride || _realRole() || 'owner').toLowerCase();
  const items = roles.map(r => {
    const isActive = r.toLowerCase() === active;
    return `<button type="button" data-role="${escHtml(r)}" onclick="setRoleOverride(this.dataset.role)"
      style="display:block;width:100%;text-align:left;padding:8px 12px;background:${isActive?'var(--cream)':'transparent'};border:none;cursor:pointer;font-size:13px;${isActive?'font-weight:700;':''}">${escHtml(r)}${isActive?' ✓':''}</button>`;
  }).join('');
  const stopBtn = _roleOverride
    ? `<button type="button" onclick="clearRoleOverride()" style="display:block;width:100%;text-align:left;padding:8px 12px;background:transparent;border:none;border-top:1px solid var(--border);cursor:pointer;font-size:12px;color:var(--gold);font-weight:600;">↩ Stop testing (back to Owner)</button>`
    : '';
  pop.innerHTML = `
    <div style="padding:6px 12px;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border);">Test as Role</div>
    ${items}${stopBtn}`;
  pop.style.display = 'block';
  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', _roleSwitcherOutsideClick, { once: true });
  }, 0);
}
function closeRoleSwitcher() {
  const pop = document.getElementById('role-switcher-pop');
  if (pop) pop.style.display = 'none';
}
function _roleSwitcherOutsideClick(e) {
  const pop = document.getElementById('role-switcher-pop');
  const trigger = document.getElementById('user-role-label');
  if (pop && !pop.contains(e.target) && trigger && !trigger.contains(e.target)) {
    closeRoleSwitcher();
  } else if (pop && pop.style.display !== 'none') {
    // Re-arm the listener if click landed inside
    document.addEventListener('click', _roleSwitcherOutsideClick, { once: true });
  }
}

// ── Token acquisition ───────────────────────────────────────────
// Graph calls use getToken(); admin operations (staff sync, tenant
// invites) use getAdminToken(). SharePoint REST calls use
// getSharePointToken() — a different audience, must be invoked
// before any other awaits so the popup isn't blocked.
async function getToken() {
  try {
    const r = await msal.acquireTokenSilent({ scopes: SCOPES, account: currentUser });
    return r.accessToken;
  } catch(e) {
    // Use popup instead of redirect — redirect causes an infinite loop when
    // the cached token is missing newly-added scopes (page reloads → silent
    // fails again → redirect → repeat forever)
    try {
      const r = await msal.acquireTokenPopup({ scopes: SCOPES, account: currentUser });
      return r.accessToken;
    } catch(e2) {
      // Popup blocked or user dismissed — fall back to redirect as last resort
      await msal.acquireTokenRedirect({ scopes: SCOPES });
    }
  }
}

async function getAdminToken() {
  try {
    const r = await msal.acquireTokenSilent({ scopes: ADMIN_SCOPES, account: currentUser });
    return r.accessToken;
  } catch(e) {
    try {
      const r = await msal.acquireTokenPopup({ scopes: ADMIN_SCOPES, account: currentUser });
      return r.accessToken;
    } catch(e2) {
      await msal.acquireTokenRedirect({ scopes: ADMIN_SCOPES });
    }
  }
}

// SharePoint REST API token — uses /.default so no extra permission
// registration needed. SharePoint checks the signed-in user's own site
// permissions rather than the OAuth scope when authorising REST calls.
async function getSharePointToken() {
  const spScopes = ['https://mainspringdevelopers.sharepoint.com/.default'];
  try {
    const r = await msal.acquireTokenSilent({ scopes: spScopes, account: currentUser });
    return r.accessToken;
  } catch(e) {
    // Don't use popup — popup may be blocked when called mid-async-chain.
    // Callers must invoke this BEFORE any other awaits so the user-gesture
    // context is fresh. Fall back to redirect (page reloads, user re-runs
    // the operation once).
    await msal.acquireTokenRedirect({ scopes: spScopes });
    return null; // never reached — redirect navigates away
  }
}
