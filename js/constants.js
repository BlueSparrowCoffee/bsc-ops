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
  'maint-contacts': 'Contacts',
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
  maintContacts:       ['maint-contacts'],
  maintSchedule:       ['maint-schedule'],
  maintLog:            ['maint-schedule'],
  roles:               ['settings'],
  parking:             ['parking'],
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
  {name:'CostPerCase',number:{decimalPlaces:'automatic'}},
  {name:'ServingsPerUnit',number:{decimalPlaces:'automatic'}},
  {name:'CostPerServing',number:{decimalPlaces:'automatic'}},
  {name:'ServingUnit',text:{}},{name:'Unit',text:{}},{name:'Tags',text:{}},
  {name:'Archived',text:{}}
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

const MERCH_LIST_COLS = [
  {name:'ItemName',text:{}},{name:'Category',text:{}},{name:'ItemNo',text:{}},
  {name:'CostPerUnit',number:{decimalPlaces:'automatic'}},
  {name:'SellingPrice',number:{decimalPlaces:'automatic'}},
  {name:'SquareCatalogItemId',text:{}},{name:'Tags',text:{}},
  {name:'Received',number:{decimalPlaces:'none'}},
  {name:'ReceivedNotes',text:{allowMultipleLines:true}},
  {name:'Archived',text:{}}
];

const MERCH_COUNTS_EXTRA_COLS = [
  {name:'ChangesSinceLastCount',number:{decimalPlaces:'automatic'}}
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
  labels:         'BSC_CoffeeBagLabels',
  foodPars:            'BSC_FoodPars',
  parking:             'BSC_Parking',
  prepItems:           'BSC_PrepItems',
  prepItemIngredients: 'BSC_PrepItemIngredients',
  foodInventory:       'BSC_FoodInventory',
  groceryInventory:    'BSC_GroceryInventory',
  tags:                'BSC_Tags',
  merchReceived:       'BSC_MerchReceived',
  merchMonths:         'BSC_MerchMonths',
  lastCount:           'BSC_LastCount'
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
    hasCategory: true,
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
const APP_VERSION = '2026-04-22ac';
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
const PROVISION_VERSION = '29';

// ── Data / cache TTLs ────────────────────────────────────────────
const CACHE_MAX_AGE = 4 * 60 * 60 * 1000; // 4 hours

// ── External URLs ────────────────────────────────────────────────
const PASTRY_ORDER_SHEET_URL = 'https://mainspringdevelopers-my.sharepoint.com/:x:/g/personal/plattestreet_bluesparrowcoffee_com/IQD4lfreJEqATZTjPUub-JmoAUDTaircsNPrwcyCR44bhYU';

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
  'ItemNo','CostPerUnit','SellingPrice','SquareCatalogItemId','Received','ReceivedNotes',
  'WeekOf','StoreCount','StorageCount','TotalCount','Location','CountedBy','ChangesSinceLastCount','Quantity',
  // Transfers
  'FromLocation','ToLocation','TransferredBy','InventoryType',
  // Orders
  'Vendor','Items','Status','OrderedBy','ExpectedDelivery',
  // Checklists
  'TaskName','Frequency','Type','AssignedRole','GroupId','SortOrder','SuggestedBy',
  'GroupName','CompletedBy','CompletedDate','TaskId','RecurEveryDays','RecurTime','Description','StartDate',
  // Roles
  'RoleName','Permissions','LocationAccess',
  // Vendors
  'OrderDays','DeliveryDays','ContactPerson','Email','Website','Phone',
  'OrderMethod','Terms','PaymentMethod','Active',
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
  { key:'Terms',         span:false },
  { key:'PaymentMethod', span:false },
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
  { id:'count_submitted', name:'Count Submitted',      type:'count_submitted',enabled:false, description:'Confirmation when a weekly inventory count is submitted' }
];

// ── Coffee bag SKU pattern matcher (for label sync from Square) ──
const COFFEE_BAG_PATTERNS = [
  'low pressure', 'headliner', 'blake st blend', 'blake street blend',
  'platte st blend', 'platte street blend', 'rare release', 'broad strokes'
];
