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
// slack is populated at deploy time via the staticwebapp.config
// build step (SLACK_WEBHOOK_PLACEHOLDER → real webhook).
// locations is the canonical list of physical BSC sites.
// internalDomain gates staff-access provisioning (direct grant vs B2B invite).
const CFG = {
  clientId:       'a466e07b-68f4-4881-bdcc-d3adeb356799',
  tenantId:       'b808062f-1ca4-4f25-a2eb-8998fac8dc52',
  slack:          'SLACK_WEBHOOK_PLACEHOLDER',
  locations:      ['Blake','Platte','Sherman','17th'],
  internalDomain: 'bluesparrowcoffee.com'
};

// ── OAuth scopes ────────────────────────────────────────────────
// SCOPES       — requested on every login/token call
// ADMIN_SCOPES — requested only when the owner runs Staff Access Sync
const SCOPES       = ['Sites.ReadWrite.All','Files.ReadWrite','User.Read'];
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
  try { await msal.loginRedirect({ scopes: SCOPES }); }
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
    const role  = currentStaffMember.Role || '';
    const loc   = currentStaffMember.LocationAccess === 'All' || !currentStaffMember.LocationAccess
      ? 'All locations'
      : currentStaffMember.LocationAccess;

    if (nameEl) nameEl.textContent = first;
    if (roleEl) roleEl.textContent = role ? `${role} · ${loc}` : loc;
    if (avatarEl) {
      avatarEl.textContent  = first.charAt(0).toUpperCase();
      // Colour avatar by role
      const r = role.toLowerCase();
      avatarEl.style.background = r.includes('owner') ? '#b78b40'
        : r.includes('manager') ? '#3b82f6'
        : 'var(--teal)';
    }
  } else if (currentUser) {
    // Logged in via Microsoft but no matching staff record
    const displayName = currentUser.name || currentUser.username || '';
    const first = displayName.split(' ')[0];
    if (nameEl)   nameEl.textContent = first;
    if (roleEl)   roleEl.innerHTML = `<span style="color:#f59e0b;">⚠ Not linked</span>`;
    if (avatarEl) { avatarEl.textContent = '?'; avatarEl.style.background = '#9ca3af'; }
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
function isManagerOrOwner() {
  if (!currentUser) return false;
  if (!currentStaffMember) return true; // unlinked login → allow during setup
  const role = (currentStaffMember.Role || '').toLowerCase();
  return role.includes('manager') || role.includes('owner') || role.includes('admin') || role === '';
}

function isOwner() {
  if (!currentUser) return false;
  if (!currentStaffMember) return true; // unlinked login → allow during setup
  const role = (currentStaffMember.Role || '').toLowerCase();
  return role.includes('owner') || role.includes('admin');
}

function isOwnerOrAccounting() {
  if (!currentUser) return false;
  if (!currentStaffMember) return true; // unlinked login → allow during setup
  const role = (currentStaffMember.Role || '').toLowerCase();
  return role.includes('owner') || role.includes('admin') || role.includes('accounting');
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
