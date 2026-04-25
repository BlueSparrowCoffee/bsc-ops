---
name: bsc-context
description: Load full BSC Ops project context — tech stack, SharePoint lists, current PROVISION_VERSION, modules, patterns, and conventions. Run this at the start of a session or when context feels stale.
allowed-tools: Read, Bash
---

Load and summarize all critical context for the BSC Ops project so the session is fully informed.

## Read these memory files

- `/Users/jeffreyknott/.claude/projects/-Users-jeffreyknott-Desktop-BSC-x-Claude-1-0/memory/bsc_brand_guide.md`
- `/Users/jeffreyknott/.claude/projects/-Users-jeffreyknott-Desktop-BSC-x-Claude-1-0/memory/bsc_integrations.md`

## Read these live values

**Note (post module-split, 2026-04):** Constants moved from `index.html` into `js/constants.js`. Form-field arrays and CFGs may still live in either file or in their feature module — search both.

Files to inspect:
- `/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops/js/constants.js`
- `/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops/index.html`
- `/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops/js/*.js` (feature modules)

Extract and report:
1. **APP_VERSION** — grep `const APP_VERSION` in `js/constants.js`
2. **PROVISION_VERSION** — grep `const PROVISION_VERSION` in `js/constants.js`
3. **LISTS constant** — grep `const LISTS` (likely `js/constants.js`); read full object
4. **INV_TYPE_CFG** — grep `const INV_TYPE_CFG`
5. **INV_COG_CFG** — grep `const INV_COG_CFG`
6. **MODULES array** — grep `const MODULES`
7. **MAINT_FORM_FIELDS** — grep `const MAINT_FORM_FIELDS`
8. **VENDOR_FORM_FIELDS** — grep `const VENDOR_FORM_FIELDS`
9. **Line counts** — run `wc -l index.html js/*.js` (index.html should be well below 10k post-split — currently ~4,900)

## Report format

```
PROVISION_VERSION: 'N'   ← bump this whenever schema changes; tell user to clear bsc_provision_v from localStorage
index.html: ~N lines     ← flag if >10,000 lines, recommend module split

SharePoint Lists (LISTS constant):
  key → SharePoint list name
  ... all entries ...

Inventory Types (INV_TYPE_CFG):
  consumable → BSC_Inventory (cache.inventory)
  merch      → BSC_MerchInventory (cache.merchInventory)
  equipment  → BSC_EquipInventory (cache.equipInventory)
  (pastries/sandwiches/labels/transfers are special non-inventory tabs)

COG Tabs (INV_COG_CFG):
  merch   → BSC_MerchInventory, hiddenKey: bsc_merch_cogs_hidden
  food    → BSC_FoodInventory,  hiddenKey: bsc_food_cogs_hidden
  grocery → BSC_GroceryInventory, hiddenKey: bsc_grocery_cogs_hidden

Contact form fields (MAINT_FORM_FIELDS): Title, Service, Contact, Phone, Email, Website, Location, Tags, Notes
Vendor form fields (VENDOR_FORM_FIELDS): VendorName, Category(type:category), Product, Active, ...

Tech stack:
  Hosting:  Azure Static Web Apps (auto-deploys from main branch)
  Backend:  Azure Functions (Node.js) in /api/ — sp-webhook, negotiate
  Auth:     MSAL v2, AAD browser-side
  DB:       SharePoint lists via Microsoft Graph API
  Realtime: Azure SignalR Service (SharePoint webhook → Azure Function → SignalR → browser)
  Repo:     /Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops

Modules: Dashboard, Inventory, Menu, COGs, Ordering, Checklists, Vendors, Contacts, Maintenance, Parking, Prep Items, Settings
```

## Key patterns established in this project

### Deploy workflow
Always use the `deploy` skill after index.html changes. It stages only index.html (not -A), commits with co-author line, pushes to origin main.

### Schema changes
- Add columns to `ensureList(...)` calls in `ensureAllLists()`
- Bump `PROVISION_VERSION` (currently '28')
- Tell user to clear `bsc_provision_v` from localStorage to trigger re-provisioning

### Tag system (added v23)
- Central registry: `BSC_Tags` list → `cache.tags`
- Reusable widget: `tagEditorHTML(instanceId)` → inject into form HTML, then `initTagEditor(instanceId, tagsStr)`, read back with `getTagEditorValue(instanceId)`
- Read-only display: `renderTagPills(tagsStr)` → returns gold pill HTML
- Tags on: vendors (instanceId='vendor'), contacts (instanceId='maint-contact'), inventory (instanceId='inv-item'), maintenance tasks (instanceId='maint-task')
- Global autocomplete: `getAllTagNames()` — union of BSC_Tags registry + all section tags
- Auto-migrate existing tags: `migrateTagsToRegistry()` called after data load
- Settings page has 🏷️ Tags card for managing global tag list

### Inventory vendor select (added)
- Pattern: `<select id="new-item-supplier">` + `<div id="new-vendor-inline">` for inline creation
- `populateInvVendorSelect(currentVal)` — populates from `cache.vendors`
- `createVendorQuick()` — atomically creates vendor in SP and updates cache
- `saveInventoryItem` auto-creates vendor if `__new__` sentinel + name typed

### Vendor category field
- Type: `category` in VENDOR_FORM_FIELDS
- Renders as `<select>` + hidden `<input class="vendor-cat-new-inp">`
- `onVendorCatSelectChange(sel)` / `finishVendorCatNew(inp)` — add new category inline
- `saveVendorForm` flushes pending category before reading

### Inventory category field
- Similar pattern: `<select id="new-item-cat">` + `<input id="new-item-cat-custom">`
- `onInvCatChange(sel)` / `finishInvCatNew(inp)`
- `saveInventoryItem` flushes pending category at top

### COG hidden state persistence
- Hidden IDs stored in both localStorage AND SharePoint BSC_Settings
- `applyHiddenSettings()` called after data load — reads SP first, falls back to localStorage
- `toggleCogHidden` / `toggleInvCogHidden` write to both on every toggle
- SP keys: `cogs_hidden`, `bsc_merch_cogs_hidden`, `bsc_food_cogs_hidden`, `bsc_grocery_cogs_hidden`

### COG food sync buttons
- Food tab: "🥐 Sync Cost from Pars" — matches BSC_FoodInventory items by name to BSC_FoodPars Price → writes CostPerUnit
- Grocery tab: "📦 Sync Cost from Inventory" — matches BSC_GroceryInventory items by name to BSC_Inventory CostPerServing → writes CostPerUnit

### Settings persistence
- `getSetting(key)` / `saveSetting(key, value)` — BSC_Settings list, shared across all devices
- Used for: slack_webhook, slack_paused, notification_rules, cog hidden IDs

### SignalR
- `initSignalR()` — connects with `withAutomaticReconnect([0,2000,5000,10000,30000])`
- `onclose` handler restarts after 60s so connection never permanently drops
- Log level: None (suppresses noisy transport errors)

### Security rules (always follow)
- Always `escHtml()` on user data in innerHTML
- Never bare variables in onclick="..." strings — use `data-*` + `this.dataset.*`
- `invCfg()` returns null for non-inventory types (pastries/sandwiches/labels/transfers) — always guard

### SP field reading pattern
- `MAINT_FORM_FIELDS` / `VENDOR_FORM_FIELDS` — always use fixed field arrays, never derive from SP response keys (empty fields get dropped from SP response)
- `SP_SYSTEM_FIELDS` — set of fields to strip when reading SP metadata

### cogMap key format
- Keyed as `"menuItemId:variationName"` (NOT just item ID)
- `calcCog(menuItemId, variationName, cogMap, invMap, prepMap)` — always use this, never look up cogMap directly by item ID

### Row click → modal pattern (inventory & vendors)
- Click row opens edit modal. Archive/delete in modal footer, NOT inline on row.
- CRITICAL: capture `_editInvId` (or equivalent) into a local variable BEFORE calling `closeModal()` — `closeModal('modal-add-item')` nulls `_editInvId` immediately.

### Vendor form PATCH safety
- `saveVendorForm` strips keys not in `VENDOR_FORM_FIELDS` before PATCH — prevents 400 errors from stale localStorage field names.
- `VENDOR_FORM_FIELDS` includes `Title` (Company Name), `Active`, `Category`, `Product`, `OrderDays`, `Phone`, `Email`, `Notes`, `Tags`.

### Column reorder (`moveCol`)
- Uses `_colPanelFields[listKey]` module-level map (set in `buildColPanel`).
- Never serialize `allFields` inside an `onclick` attribute — use the module-level map instead.

### COGs ingredient dropdown
- `position:fixed` + `getBoundingClientRect()` to escape overflow:auto containers.

### COGs overview chart (post 2026-04-25)
- **Coffee-bar dots use LIVE `calcCog`** against current cogMap/invMap/prepMap — **NOT** `BSC_CogSnapshots`. Snapshots are history-only now. If chart looks "stale" don't tell the user to take a snapshot — the chart is decoupled.
- Chart is repainted by `renderCogsOverview()` on every COG mutation (snapshot, ingredient add/edit/delete, sync buttons, hide toggles, archive toggles in Inventory).
- Dot click navigates: switches tab via `cogTab(type)`, scrolls to `#cogs-item-card-${type}-${cardId}`, flashes gold ring. Don't add tooltip-embedded action links — the tooltip vanishes on mouseleave.
- Card IDs follow the convention `cogs-item-card-${type}-${id}` where `type ∈ {coffee-bar, merch, food, grocery}` and `id` is `SquareId || sp_id` for coffee-bar, sp `id` for inv types.

### Count records
- Written ONLY by `submitWeeklyCount()` / `submitMerchCount()` on explicit button press.
- SignalR and `updateCountTotal` never write to count lists.
- **Pre-fill (v27+)**: inputs populate from `recentMap` — last count for current location, blank if none
- **Grouping (v27+)**: by vendor (Supplier field), not category
- **Location filter**: `!loc || !r.Location || r.Location === loc` — tolerant of null Location field on records
- **Inv id compare after submit**: use `String(i.id) === String(e.id)` (dataset.id is string, SP id is number — strict equality silently fails)
- **Synthetic id assignment** after cache push: `maxExistingId + idx + 1` so recentMap tiebreak picks newest records
- **BSC_LastCount**: list tracking most recent count per `invType:location`, written by `upsertLastCount()` post-submit

### Square integration
- **All calls** go through `squareAPI(method, path, body)` → `/api/square/{path}` proxy with MSAL bearer
- **Token lives in Azure env var** `SQUARE_ACCESS_TOKEN` — NOT the client-side `square_token` setting (UI-only)
- **Location map direction**: stored as `{ squareId: bscName }`. Use helpers:
  - `getSquareLocIds()` — Square IDs (map keys)
  - `bscNameToSquareLocId(bscName)` — reverse lookup
  - NEVER use `Object.values(locMap)` or `locMap[bscName]` for IDs
- **Diagnostic**: Settings → ◼ Square API → 🔍 Test Square APIs — probes 5 endpoints independently
- **Personal Access Token scopes**: Square requires explicit scope grants now. If Orders returns 403 but other endpoints work, add `ORDERS_READ` in Square Developer Dashboard

### Coffee bag labels (v27+)
- Auto-syncs BagsSold + Adjustment (`ceil(BagsSold × 1.1)`) + EndBalance + TotalValue on tab open
- Rate-limited 5min via `_labelsSyncedAt`, resets to 0 on error for retry
- Month-key matching (`_monthKey()`) parses "April 2026", "Apr 2026", "2026-04" as equivalent
- Only updates EXISTING records — won't create monthly rows

### COGs ingredient lookup (v28+)
- `BSC_CogsRecipes` has both `IngredientName` AND `IngredientId`
- `calcCog(menuItemId, variationName, cogMap, invMap, prepMap, invIdMap)` — ID-first, name fallback
- `buildInvIdMap()` returns `{ String(id): item }`
- ID-based lookup survives renames; name-based is fallback for legacy records

### Vendor rename cascade
- `cascadeVendorRename(oldName, newName)` — PATCHes Supplier field on all 5 inv types
- Called from vendor save flow. 8 concurrent PATCHes at a time.

### Autofill block
- Capture-phase `focus` listener sets `autocomplete="new-password"` on all text/textarea inputs globally.

### CSP (staticwebapp.config.json)
- `connect-src` includes `https://cdn.jsdelivr.net` for SignalR CDN.
- Edit this file alongside index.html when adding new external domains.

### Schema change → re-provisioning
- Add columns to `ensureList(...)` in `ensureAllLists()`.
- Bump `PROVISION_VERSION` in `js/constants.js`.
- Tell user to clear `bsc_provision_v` from localStorage (Settings → Clear Local Data) so re-provisioning fires.

### "Remove" means delete completely
Per `feedback_remove_means_delete.md`: when the user says remove/delete/kill/drop, delete every supporting line — helpers, constants, CSS classes, legend entries, comments. Never just hide with `display:none`, `if (false)`, or feature flags. After the obvious deletion, search for orphaned references and remove them in the same edit.

## Also flag
- If `index.html` is over 10,000 lines again: recommend further module split
- If `PROVISION_VERSION` hasn't been bumped after a schema change: remind user
- If `APP_VERSION` in `js/constants.js` doesn't match the 27 cache-bust strings in `index.html`: bump both
