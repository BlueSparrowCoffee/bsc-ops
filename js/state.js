/* ================================================================
 * BSC Ops — state.js
 * Cross-cutting app state that every module needs to read or write.
 * Feature-specific state (_editInvId, _cogsHiddenIds, etc.)
 * stays with its owning module.
 *
 * Classic script — top-level `let`/`const` become script-global
 * bindings shared across every other classic <script> on the page.
 * ================================================================ */

// ── Session identity ─────────────────────────────────────────────
let currentUser         = null;  // MSAL account object (set after login)
let currentLocation     = 'all'; // selected location filter — 'all' or a BSC location name
let currentStaffMember  = null;  // BSC_Staff record resolved from currentUser.username

// ── Main in-memory data cache ────────────────────────────────────
// Populated by loadAllData(); all render* functions read from here.
// Feature modules mutate via cache.xxx = [...new items]; signalR refreshes
// individual keys.
const cache = {
  inventory: [], transfers: [], orders: [],
  checklists: [], vendors: [], roles: [], recipes: [],
  maintContacts: [], staff: [], maintSchedule: [], maintLog: [],
  clProgress: {}, clProgressRows: [], countHistory: [], settingsItems: [],
  menu: [], menuCounts: [],
  cogsRecipes: [], cogSnapshots: [],
  clGroups: [], clCompletions: [],
  merchInventory: [], merchCountHistory: [],
  equipInventory: [], equipCountHistory: [],
  labels: [],
  retailBags: [],
  fiveLbLabels: [],
  foodPars: [],
  foodParValues: [],
  parking: [],
  contactArchive: [],
  prepItems: [],
  prepItemIngredients: [],
  foodInventory: [],
  groceryInventory: [],
  tags: [],
  merchReceived: [],
  merchMonths: [],
  lastCount: [],
  inventoryPars: [],   // per-location par + reorder trigger rows
  marketCompetitors: [],
  marketItems: [],
  marketPrices: [],
  pendingCounts: [],   // PR 12b — Counter-submitted counts awaiting Manager approval
  projects: [],
  projectTasks: [],
  projectUpdates: [],
  projectLinks: [],
  squareModifiers: [],     // flattened modifier list pulled from Square Catalog
  squareItemVariations: [] // flattened ITEM_VARIATION list pulled from Square Catalog
};

// ── SignalR refresh coordination ─────────────────────────────────
// SignalR messages arriving while a modal is open are queued here and
// flushed by closeModal() once all modals are dismissed. Prevents the
// user's in-progress edit from being blown away by a remote update.
let _pendingRefreshKeys = new Set();

// ── SharePoint list metadata cache (session-lifetime) ────────────
// getSpListCache() populates this on first use; saves per-list 404 probes
// during provisioning.
let _spListCache = null;

// Per-list column metadata — loaded lazily by loadListColNames().
// Map: listName -> { internalName: displayName }
const _colDisplayNames = {};
// Map: listName -> Set of read-only/hidden column names
const _colReadOnly = {};
