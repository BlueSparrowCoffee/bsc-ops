/* ================================================================
 * BSC Ops — constants.js
 * Pure data constants shared across modules. Loaded as a classic
 * <script src="...">, so every declaration becomes a browser global.
 * No function references — those stay in index.html / feature modules.
 * ================================================================ */

// ── Timing / UI tuning ───────────────────────────────────────────
const NAV_SETTLE_MS         = 80;   // ms to wait after nav() before querying newly rendered DOM
const SEARCH_DEBOUNCE_MS    = 150;  // ms to debounce search/filter inputs
const MODAL_FOCUS_DELAY_MS  = 100;  // ms to wait before focusing first field in a modal
const SP_PAGE_SIZE          = 500;  // Graph API $top — max items per list fetch
const WEBHOOK_EXPIRY_DAYS   = 170;  // SharePoint webhook max lifetime (days)
const AUTO_SYNC_INTERVAL_HOURS = 24;       // daily Square→SP auto-sync cooldown
const AUTO_SYNC_LOCK_TTL_MS    = 5 * 60 * 1000; // hot lock duration (5 min)

// ── App modules / navigation ─────────────────────────────────────
const MODULES = ['Dashboard','Inventory','Transfers','Ordering','Checklists','Vendors','Recipes','Staff','Maintenance','Contacts','Menu','Prep','Square','COGs','Settings'];

const PAGE_MODULE = {
  'dashboard':      'Dashboard',
  'inventory':      'Inventory',
  'ordering':       'Ordering',
  'checklists':     'Checklists',
  'vendors':        'Vendors',
  'recipes':        'Recipes',
  'staff':          'Staff',
  'maint-schedule': 'Maintenance',
  'menu':           'Menu',
  'prep-items':     'Prep',
  'square':         'Square',
  'cogs':           'COGs',
  'settings':       'Settings',
};

// Which pages to re-render when a given list changes
const LIST_PAGE_MAP = {
  inventory:           ['inventory','cogs'],
  orders:              ['ordering'],
  checklists:          ['checklists'],
  clProgress:          ['checklists','dashboard'],
  clGroups:            ['checklists'],
  clCompletions:       ['checklists'],
  vendors:             ['vendors','ordering'],
  recipes:             ['recipes'],
  staff:               ['staff'],
  prepItems:           ['prep-items','cogs'],
  prepItemIngredients: ['prep-items','cogs'],
  cogs:                ['cogs'],
  foodPars:            ['ordering'],
  menu:                ['menu'],
  maintContacts:       ['maint-schedule'],
  maintSchedule:       ['maint-schedule'],
  maintLog:            ['maint-schedule'],
  roles:               ['settings'],
  parking:             ['parking'],
  inventoryPars:       ['inventory','dashboard'],
};

// ── Maintenance / equipment ──────────────────────────────────────
const EQUIPMENT_LIST = ['Slayer Espresso Machine','Grinders','Glycol Chiller','Refrigerators','Ice Machine','Fetco Batch Brewer','Cold Brew System','Keg Lines / Draft','Water Filtration','Dishwasher','POS Terminals','HVAC / Ventilation','Plumbing / Sinks','Hood / Exhaust'];
const FREQ_DAYS   = { Monthly:30, Quarterly:90, Annually:365 };
const MAINT_ICONS = { glycol:'🧊', ice:'❄️', coffee:'⚙️', espresso:'⚙️', window:'🪟', building:'🏢', slayer:'📖', electric:'⚡', plumb:'🔩', hvac:'🌡️', pest:'🐛' };

// ── SharePoint list column definitions ───────────────────────────
const FP_PAR_LIST_COLS = [
  {name:'Mon',number:{decimalPlaces:'none'}},{name:'Tue',number:{decimalPlaces:'none'}},
  {name:'Wed',number:{decimalPlaces:'none'}},{name:'Thu',number:{decimalPlaces:'none'}},
  {name:'Fri',number:{decimalPlaces:'none'}},{name:'Sat',number:{decimalPlaces:'none'}},
  {name:'Sun',number:{decimalPlaces:'none'}}
];

const INV_LIST_COLS = [
  {name:'ItemName',text:{}},{name:'Category',text:{}},{name:'Supplier',text:{}},
  {name:'OrderSize',number:{decimalPlaces:'automatic'}},{name:'OrderUnit',text:{}},
  {name:'ParLevel',number:{decimalPlaces:'automatic'}},
  {name:'ReorderTrigger',number:{decimalPlaces:'automatic'}},
  {name:'CostPerCase',number:{decimalPlaces:'automatic'}},
  {name:'ServingsPerUnit',number:{decimalPlaces:'automatic'}},
  {name:'CostPerServing',number:{decimalPlaces:'automatic'}},
  {name:'ServingUnit',text:{}},{name:'Unit',text:{}},{name:'Tags',text:{}},
  {name:'Archived',text:{}}
];

// Per-location par + reorder trigger (one row per (ItemId, Location)).
// Title = "{itemId}:{locationSlug}" — the composite key.
// Replaces the legacy ParLevel/ReorderTrigger columns on BSC_Inventory
// (those stay as a safety net during migration but are ignored after).
const INV_PARS_LIST_COLS = [
  {name:'ItemId',         text:{}},
  {name:'Location',       text:{}},
  {name:'ParLevel',       number:{decimalPlaces:'automatic'}},
  {name:'ReorderTrigger', number:{decimalPlaces:'automatic'}}
];

const COUNTS_LIST_COLS = [
  // WeekOf stores a full ISO datetime of the submit moment — label kept for
  // SP column-name stability across already-provisioned per-location lists.
  {name:'WeekOf',dateTime:{displayAs:'default',format:'dateTime'}},
  {name:'StoreCount',number:{decimalPlaces:'automatic'}},
  {name:'StorageCount',number:{decimalPlaces:'automatic'}},
  {name:'TotalCount',number:{decimalPlaces:'automatic'}},
  {name:'Location',text:{}},{name:'CountedBy',text:{}}
];

const MENU_COUNTS_LIST_COLS = [
  {name:'WeekOf',dateTime:{displayAs:'default',format:'dateOnly'}},
  {name:'Quantity',number:{decimalPlaces:'automatic'}},
  {name:'Location',text:{}},{name:'CountedBy',text:{}}
];

// Schema is shared with foodInventory + groceryInventory provisioning, hence
// the legacy "MERCH_LIST_COLS" name. Category stays here because food/grocery
// still use it; merch ignores it at the UI/save level (hasCategory:false).
// Supplier added 2026-04-29 to support merch vendor field. ItemNo dropped
// 2026-04-29 — never populated from Square and not used in food/grocery.
const MERCH_LIST_COLS = [
  {name:'ItemName',text:{}},{name:'Category',text:{}},{name:'Supplier',text:{}},
  {name:'CostPerUnit',number:{decimalPlaces:'automatic'}},
  {name:'SellingPrice',number:{decimalPlaces:'automatic'}},
  {name:'SquareCatalogItemId',text:{}},
  {name:'Archived',text:{}}
];

// Coffee bag labels — per-location list (BSC_<Loc>_CoffeeBagLabels). Lazy-
// provisioned in labels.js via ensureList on first save. No Location column
// because the location is encoded in the list name.
const BAG_LABELS_LIST_COLS = [
  {name:'Month',        text:{}},
  {name:'StartBalance', number:{decimalPlaces:'automatic'}},
  {name:'BagsSold',     number:{decimalPlaces:'automatic'}},
  {name:'Adjustment',   number:{decimalPlaces:'automatic'}},
  {name:'EndBalance',   number:{decimalPlaces:'automatic'}},
  {name:'CostPerLabel', number:{decimalPlaces:'automatic'}},
  {name:'TotalValue',   number:{decimalPlaces:'automatic'}},
  {name:'Notes',        text:{allowMultipleLines:true}},
  {name:'ReconcileBy',  text:{}},
  {name:'SquareData',   text:{allowMultipleLines:true}}
];

// Retail coffee bags — per-location list (BSC_<Loc>_RetailBagInventory).
// Same shape as labels, but CostPerLabel renamed to CostPerBag for clarity.
const RETAIL_BAGS_LIST_COLS = [
  {name:'Month',        text:{}},
  {name:'StartBalance', number:{decimalPlaces:'automatic'}},
  {name:'BagsSold',     number:{decimalPlaces:'automatic'}},
  {name:'Adjustment',   number:{decimalPlaces:'automatic'}},
  {name:'EndBalance',   number:{decimalPlaces:'automatic'}},
  {name:'CostPerBag',   number:{decimalPlaces:'automatic'}},
  {name:'TotalValue',   number:{decimalPlaces:'automatic'}},
  {name:'Notes',        text:{allowMultipleLines:true}},
  {name:'ReconcileBy',  text:{}},
  {name:'SquareData',   text:{allowMultipleLines:true}}
];

// 5 LB bag labels — per-location list (BSC_<Loc>_FiveLbBagLabels). Manual
// entry only: no Square sync, no waste assumption, no auto-adjustment.
// EndBalance = StartBalance − Adjustment (computed at save time).
const FIVE_LB_BAG_LABELS_LIST_COLS = [
  {name:'Month',        text:{}},
  {name:'StartBalance', number:{decimalPlaces:'automatic'}},
  {name:'Adjustment',   number:{decimalPlaces:'automatic'}},
  {name:'EndBalance',   number:{decimalPlaces:'automatic'}},
  {name:'CostPerLabel', number:{decimalPlaces:'automatic'}},
  {name:'TotalValue',   number:{decimalPlaces:'automatic'}},
  {name:'Notes',        text:{allowMultipleLines:true}},
  {name:'ReconcileBy',  text:{}}
];

// Waste-rate fallbacks (used when BSC_Settings is empty/unreachable). Live
// values are configurable via Settings → ☕ Coffee Bags and stored as integer
// percentages under bsc_label_waste_pct / bsc_retail_bag_waste_pct.
const DEFAULT_LABEL_WASTE_PCT      = 10; // each bag sold deducts +10% extra labels (misprints)
const DEFAULT_RETAIL_BAG_WASTE_PCT = 2;  // each bag sold deducts +2% extra retail bags (damage/expiry)

// BSC_Orders schema. Existing columns (Vendor, Items, Status, OrderedBy,
// Location, ExpectedDelivery, Notes) stay for legacy display. New columns
// drive the build/send/receive workflow:
//   LineItems     — JSON [{itemId, name, qty, unitCost, unit}]
//   ReceivedItems — JSON [{itemId, receivedQty}]
//   ReceivedAt    — ISO datetime when delivery was confirmed
//   ReceivedBy    — user who confirmed receipt
//   Total         — order subtotal at creation (decimal $)
const ORDER_LIST_COLS = [
  {name:'Vendor',           text:{}},
  {name:'Items',            text:{allowMultipleLines:true}},
  {name:'Status',           text:{}},
  {name:'OrderedBy',        text:{}},
  {name:'Location',         text:{}},
  {name:'ExpectedDelivery', dateTime:{displayAs:'default',format:'dateOnly'}},
  {name:'Notes',            text:{allowMultipleLines:true}},
  {name:'LineItems',        text:{allowMultipleLines:true}},
  {name:'ReceivedItems',    text:{allowMultipleLines:true}},
  {name:'ReceivedAt',       dateTime:{displayAs:'default',format:'dateTime'}},
  {name:'ReceivedBy',       text:{}},
  {name:'Total',            number:{decimalPlaces:'automatic'}}
];

// ── Master SharePoint list registry ──────────────────────────────
const LISTS = {
  inventory:      'BSC_Inventory',          // shared consumable item master
  merchInventory: 'BSC_MerchInventory',     // merch item master
  equipInventory: 'BSC_EquipInventory',     // equipment & smallwares item master
  menu:           'BSC_Menu',
  transfers:      'BSC_Transfers',
  orders:         'BSC_Orders',
  checklists:     'BSC_Checklists',
  clProgress:     'BSC_ChecklistProgress',
  vendors:        'vendors',
  roles:          'BSC_Roles',
  recipes:        'BSC_Recipes',
  cogs:           'BSC_Cogs',
  cogHistory:     'BSC_CogHistory',
  clGroups:       'BSC_ChecklistGroups',
  clCompletions:  'BSC_ChecklistCompletions',
  maintContacts:  'Maintenance',
  contactArchive: 'BSC_ContactArchive',
  staff:          'BSC_Staff',
  maintSchedule:  'BSC_MaintSchedule',
  maintLog:       'BSC_MaintLog',
  settings:       'BSC_Settings',
  foodPars:            'BSC_FoodPars',
  parking:             'BSC_Parking',
  prepItems:           'BSC_PrepItems',
  prepItemIngredients: 'BSC_PrepItemIngredients',
  foodInventory:       'BSC_FoodInventory',
  groceryInventory:    'BSC_GroceryInventory',
  tags:                'BSC_Tags',
  merchReceived:       'BSC_MerchReceived',
  merchMonths:         'BSC_MerchMonths',
  lastCount:           'BSC_LastCount',
  inventoryPars:       'BSC_InventoryPars'     // per-location par + reorder trigger for consumable items
};

// ── Inventory type config — drives which list/cache key each inv type uses ──
const INV_TYPE_CFG = {
  consumable: {
    label:       'Consumable Inventory',
    icon:        '📦',
    listKey:     'inventory',
    countsPrefix:'BSC_{loc}_InventoryCounts',
    cacheKey:    'inventory',
    countKey:    'countHistory'
  },
  merch: {
    label:       'Merch Inventory',
    icon:        '🛍️',
    listKey:     'merchInventory',
    countsPrefix:'BSC_{loc}_MerchCounts',
    cacheKey:    'merchInventory',
    countKey:    'merchCountHistory',
    hasCategory: false,
    isMerch:     true
  },
  equipment: {
    label:       'Equipment & Smallwares',
    icon:        '🔧',
    listKey:     'equipInventory',
    countsPrefix:'BSC_{loc}_EquipCounts',
    cacheKey:    'equipInventory',
    countKey:    'equipCountHistory'
  }
};

// ── COGs inventory tab config ────────────────────────────────────
const INV_COG_CFG = {
  merch:   { listKey:'merchInventory',   cacheKey:'merchInventory',   squareCat:'Merchandise', hiddenKey:'bsc_merch_cogs_hidden'   },
  food:    { listKey:'foodInventory',    cacheKey:'foodInventory',    squareCat:'Food',        hiddenKey:'bsc_food_cogs_hidden'    },
  grocery: { listKey:'groceryInventory', cacheKey:'groceryInventory', squareCat:'Grocery',     hiddenKey:'bsc_grocery_cogs_hidden' }
};

// ── Versioning ───────────────────────────────────────────────────
// Bump APP_VERSION any time a deploy has breaking localStorage changes.
// On version mismatch the entire localStorage is wiped so stale prefs never
// cause weirdness after an update.
const APP_VERSION = '2026-05-03c';
(function() {
  try {
    if (localStorage.getItem('bsc_app_version') !== APP_VERSION) {
      localStorage.clear();
      localStorage.setItem('bsc_app_version', APP_VERSION);
    }
  } catch(e) { /* private browsing / storage blocked — ignore */ }
})();

// Bump when SharePoint schema changes. User must clear bsc_provision_v
// from localStorage (or Settings → Clear Local Data) to trigger re-provisioning.
const PROVISION_VERSION = '35';

// ── Data / cache TTLs ────────────────────────────────────────────
const CACHE_MAX_AGE = 4 * 60 * 60 * 1000; // 4 hours

// ── External URLs ────────────────────────────────────────────────
// Google Apps Script Web App endpoint bound to the new pastry order sheet.
// Receives {headers, rows, secret?} via POST, writes them to the BSC_Data tab.
// To rotate: redeploy the Apps Script (Deploy -> Manage deployments -> edit
// existing deployment -> New version -> Deploy) so the URL stays the same.
const PASTRY_ORDER_SYNC_URL = 'https://script.google.com/macros/s/AKfycby0QwYRM9UXXZDVyVYc32uYzb-kvvt0na0HENzhzVztqMpibsJ8qdlGAWmCrUh3-byUUw/exec';

// ── SharePoint dynamic-form / column infra ───────────────────────
const SP_SYSTEM_FIELDS = new Set([
  'id','Created','Modified','AuthorLookupId','EditorLookupId','AppAuthorLookupId',
  'AppEditorLookupId','_UIVersionString','_ComplianceFlags','_ComplianceTag',
  '_ComplianceTagWrittenTime','_ComplianceTagUserId',
  'LabelApplied','LabelAppliedBy','RetentionLabel',
  'Label_x0020_Applied','Label_x0020_Applied_x0020_By','_LabelApplied','_LabelAppliedBy',
  'Attachments','ContentType','ContentTypeId','FolderChildCount','ItemChildCount',
  '@odata.etag','LinkTitle','LinkTitleNoMenu','_ColorTag','Edit','DocIcon',
  'FileSystemObjectType','ServerRedirectedEmbedUri','ServerRedirectedEmbedUrl',
  'FileDirRef','FileRef','FileLeafRef','UniqueId','ScopeId','_Level','_IsCurrentVersion'
]);

// Per-list label overrides — take priority over SharePoint display names
const LIST_FIELD_LABELS = {
  [LISTS && LISTS.maintContacts]: {
    Title: 'Company',
  },
  [LISTS && LISTS.vendors]: {
    Title:         'Company',
    OrderDays:     'Order Days',
    DeliveryDays:  'Delivery Days',
    OrderMethod:   'Order Method',
    ContactPerson: 'Contact',
    PaymentMethod: 'Payment Method',
    Active:        'Active',
    Tags:          'Tags',
    LeadTimeDays:  'Lead Time (days)',
    MinOrderTotal: 'Min Order Total ($)',
    MinOrderQty:   'Min Order Qty',
    OrderNotes:    'Order Notes',
  }
};

// Bump this when DEFAULT_HIDDEN_COLS changes to force a reset of stored prefs
const HIDDEN_COLS_VERSION = '2';
if (localStorage.getItem('hiddenColsVer') !== HIDDEN_COLS_VERSION) {
  localStorage.removeItem('hiddenCols_vendors');
  localStorage.setItem('hiddenColsVer', HIDDEN_COLS_VERSION);
}

// hidden columns stored per-list in localStorage
const DEFAULT_HIDDEN_COLS = {
  vendors: [
    'VendorName',
    'Terms','PaymentTerms','SplitAmt',
    '_ComplianceTag','_ComplianceTagWrittenTime','_ComplianceTagUserId',
    'LabelApplied','LabelAppliedBy','RetentionLabel',
    'Label_x0020_Applied','Label_x0020_Applied_x0020_By',
    '_LabelApplied','_LabelAppliedBy'
  ]
};

// All column names defined in ensureAllLists — deleting these will cause them
// to be re-created on next provision
const PROVISIONED_COL_NAMES = new Set([
  // INV_LIST_COLS + MERCH_LIST_COLS + COUNTS + MENU_COUNTS + MERCH_COUNTS_EXTRA + FP_PAR
  'ItemName','Category','Supplier','OrderSize','OrderUnit','ParLevel','CostPerCase','ServingsPerUnit',
  'CostPerServing','ServingUnit','Unit','Tags','Archived',
  'CostPerUnit','SellingPrice','SquareCatalogItemId',
  'WeekOf','StoreCount','StorageCount','TotalCount','Location','CountedBy','Quantity',
  // Transfers
  'FromLocation','ToLocation','TransferredBy','InventoryType',
  // Orders
  'Vendor','Items','Status','OrderedBy','ExpectedDelivery','LineItems','ReceivedItems','ReceivedAt','ReceivedBy','Total',
  // Checklists
  'TaskName','Frequency','Type','AssignedRole','GroupId','SortOrder','SuggestedBy',
  'GroupName','CompletedBy','CompletedDate','TaskId','RecurEveryDays','RecurTime','Description','StartDate',
  // Roles
  'RoleName','Permissions','LocationAccess',
  // Vendors
  'OrderDays','DeliveryDays','ContactPerson','Email','Website','Phone',
  'OrderMethod','Terms','PaymentMethod','Active',
  'LeadTimeDays','MinOrderTotal','MinOrderQty','OrderNotes',
  // Recipes
  'Content','Steps','Ingredients','Yield',
  // Maint
  'Service','Contact','ContactId','Equipment','AssignedTo','NextDue','PhotoName','ScheduleId',
  // Food pars
  'Price','ExportName',
  // Staff
  'Role',
  // Labels
  'Month','StartBalance','BagsSold','Adjustment','EndBalance','CostPerLabel','TotalValue','ReconcileBy','SquareData',
  // Menu
  'SquareId','Hidden','Variations','Price',
  // Last count session
  'CountedBy','CountedAt','InvType',
  // COGs
  'MenuItemId','MenuItemName','VariationName','IngredientName','IngredientId','COG','GrossMargin','SnapshotDate',
  // Parking
  'FirstName','LastName',
  // Merch months/received
  'CostSnapshot','ClosedBy','ClosedAt',
  // Tags
  'Color',
  // Inventory pars (per-location)
  'ItemId','ReorderTrigger',
]);

// ── Forms: vendors & contacts ────────────────────────────────────
const VENDOR_FORM_FIELDS = [
  { key:'Title',         span:true },
  { key:'Active',        type:'select', options:['Yes','No'], span:false },
  { key:'ContactPerson', type:'multi', span:false },
  { key:'Email',         type:'multi', span:false },
  { key:'Phone',         type:'multi', span:false },
  { key:'Website',       span:false },
  { key:'OrderMethod',   type:'select', options:['Email','Phone','Portal','App','Fax','In Person','Text'], span:false },
  { key:'OrderDays',     type:'days',   span:false },
  { key:'DeliveryDays',  type:'days',   span:false },
  { key:'LeadTimeDays',  type:'number', step:'1',    min:'0', span:false },
  { key:'MinOrderTotal', type:'number', step:'0.01', min:'0', span:false },
  { key:'MinOrderQty',   type:'number', step:'1',    min:'0', span:false },
  { key:'Terms',         span:false },
  { key:'PaymentMethod', span:false },
  { key:'OrderNotes',    type:'textarea', span:true },
];
const DAYS_OF_WEEK = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MAINT_FORM_FIELDS = ['Title','Service','Contact','Phone','Email','Website','Location','Tags','Notes'];

// ── Parking module ───────────────────────────────────────────────
const PARKING_STATUS_BADGE = {
  Add:      'badge-blue',
  Active:   'badge-green',
  Inactive: 'badge-gray',
  Remove:   'badge-red'
};
const PARKING_LOCS = ['Room for Milly','BSC Platte','BSC 17th'];

// ── Food pars (weekday column keys) ──────────────────────────────
const FP_DAYS       = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const FP_DAY_FULL   = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const FP_JS_DAY_MAP = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ── Slack default notification rules ─────────────────────────────
const DEFAULT_NOTIF_RULES = [
  { id:'low_inventory',   name:'Low Inventory',        type:'low_inventory',  enabled:true,  description:'Fires when items are at or below par level during a count' },
  { id:'maint_overdue',   name:'Overdue Maintenance',  type:'maint_overdue',  enabled:true,  description:'Daily digest of past-due maintenance tasks' },
  { id:'maint_due_soon',  name:'Maintenance Due Soon', type:'maint_due_soon', enabled:true,  description:'Daily digest of tasks due within the next 7 days' },
  { id:'count_submitted', name:'Count Submitted',      type:'count_submitted',enabled:false, description:'Confirmation when a weekly inventory count is submitted' },
  { id:'order_sent',      name:'Order Sent',           type:'order_sent',     enabled:false, description:'Fires when a PO is sent to a vendor (Pending → Ordered)' },
  { id:'order_delivered', name:'Order Delivered',      type:'order_delivered',enabled:false, description:'Fires when an order is marked received (Ordered → Delivered)' }
];

// ── Coffee bag SKU pattern matcher (for label sync from Square) ──
const COFFEE_BAG_PATTERNS = [
  'low pressure', 'headliner', 'blake st blend', 'blake street blend',
  'platte st blend', 'platte street blend', 'rare release', 'broad strokes'
];
