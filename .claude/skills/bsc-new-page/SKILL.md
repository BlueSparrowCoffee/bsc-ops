---
name: bsc-new-page
description: Scaffold a new top-level page (with its own sidebar nav, page section, and JS module) for the BSC Ops app. Hits all 14 required touch points. Pass the page key, module name, and emoji as the argument (e.g. "projects Projects 🗂").
allowed-tools: Read, Bash, Edit, Write
---

The user wants to add a new top-level page to BSC Ops. This is the heaviest scaffold in the app — 14 specific touch points across 6 files, in a specific order. Skipping any one of them produces a silent bug (broken nav, no real-time refresh, missing cache slot, off-by-one cache-bust count, etc.).

Argument: $ARGUMENTS
(Format expected: `<pageKey> <ModuleName> <emoji>`, e.g. `projects Projects 🗂` or `analytics Analytics 📈`. The pageKey is the URL slug used in `nav('<pageKey>')`; the ModuleName is the role-permission key; the emoji is shown in the sidebar.)

Repo: `/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops`

## When to use this vs other skills
- **This skill**: New top-level page reachable from the sidebar (Projects, Analytics, Reports). Requires a new JS module file + nav routing + page-level permission.
- **`new-list` skill**: Add a SharePoint list to an existing page. Use that one if you're not adding a new sidebar item.
- **`bsc-add-column` skill**: Add a column to an existing list. Lighter than `new-list`; use for schema tweaks.

## Required touch points — complete ALL 14

### 1. `js/constants.js` — `MODULES` array (role-permission key)
Find `const MODULES = [...]` and append the new module name. This is what gates `data-module="<ModuleName>"` and `userCanAccess()` checks.

### 2. `js/constants.js` — `PAGE_MODULE` map
Add `'<pageKey>': '<ModuleName>'`. Maps the URL slug to the role permission.

### 3. `js/constants.js` — `LIST_PAGE_MAP` (per SP list this page reads)
For each list the new page renders: `<listJsKey>: ['<pageKey>', ...other-pages-that-care]`. Drives SignalR re-render on list changes.

### 4. `js/constants.js` — `LISTS` map
Add the new SharePoint list keys (e.g., `projects: 'BSC_Projects'`). Group them logically with a comment for the next dev.

### 5. `js/constants.js` — `PROVISION_VERSION` bump
Increment by 1. Triggers `ensureAllLists()` to re-run on each user's next page load (auto-applied; no "Clear Local Data" needed for column additions).

### 6. `js/state.js` — `cache` object
Add empty array slots for each new list (e.g., `projects: []`, `projectTasks: []`). Without this, render functions crash before data loads.

### 7. `index.html` — `ensureAllLists` provisioning
Add `await ensureList(LISTS.<key>, [...columns])` for each new list. Place near other related lists with a comment indicating PROVISION_VERSION it landed in.

### 8. `index.html` — `loadAllData` getListItems
Append `getListItems(siteId, LISTS.<key>).catch(()=>[])` to the `firstBatch` array. Then add the matching destructured variable name AT THE END of the `const [...] = await Promise.all(...)` line. Position MUST match the array order. Then assign `cache.<key> = <varName> || [];` after the await.

### 9. `index.html` — sidebar nav item
Add a `<div class="nav-item" data-module="<ModuleName>" onclick="nav('<pageKey>')"><span class="nav-icon"><emoji></span> <ModuleName></div>` line in the sidebar block (around the existing `data-module="..."` items, alphabetically or grouped with related pages).

### 10. `index.html` — page section
Add `<div class="page section-load-target" id="page-<pageKey>">` block with `.page-header`, `.page-title`, `.page-sub`, and the page body. Place near other pages of similar scope.

### 11. `index.html` — modals (if needed)
Add any `<div class="modal-overlay" id="modal-...">` blocks the new feature uses.

### 12. `index.html` — `<script>` tag
Append `<script src="/js/<pageKey>.js?v=2026-MM-DDx" defer></script>` near the other module scripts. Use the CURRENT `APP_VERSION` value as the cache-bust string.

### 13. `js/nav.js`
- In the `nav()` function: add `if (page === '<pageKey>' && typeof render<PageName> === 'function') render<PageName>();`
- In `_resetPageFilters()`: add a `case '<pageKey>':` branch that clears any search inputs / filter selects on the page.

### 14. `js/signalr.js` — `PAGE_RENDER_FN`
Add `'<pageKey>': () => { if (typeof render<PageName> === 'function') render<PageName>(); },`. Drives real-time refresh when SP webhooks fire.

### 15. NEW FILE: `js/<pageKey>.js`
Create the module file. Standard template:
```javascript
/* ================================================================
 * BSC Ops — <pageKey>.js
 * <one-line description>
 * Lists: <list names>
 * Depends on: state.js, constants.js, utils.js, graph.js, auth.js
 * ================================================================ */

let _<pageKey>EditId = null;

function render<PageName>() {
  // Owner/role gate if needed
  // Filters
  // Render grid / table / etc.
}

function open<PageName>Form(id) { /* modal open + populate */ }
async function save<PageName>() { /* validation + addListItem/updateListItem */ }
async function delete<PageName>() { /* confirm + cascade-delete + cache update */ }
```

## After scaffolding

### Bump `APP_VERSION` + sweep cache-busts
- Edit `js/constants.js`: bump `APP_VERSION` letter suffix (e.g., `'2026-05-04x'` → `'2026-05-04y'`)
- Run: `sed -i '' 's/v=OLDVERSION/v=NEWVERSION/g' "/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops/index.html"`
- Verify count: `grep -c "v=NEWVERSION" "/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops/index.html"` — should be 40 + 1 (the new script tag you added) = 41 (or whatever the previous count + 1 was).

### Verify no missed touch points
After all edits, grep to confirm the new `<pageKey>` appears in:
- `js/constants.js` ✓ (MODULES, PAGE_MODULE, LIST_PAGE_MAP, LISTS, PROVISION_VERSION)
- `js/state.js` ✓ (cache slots)
- `index.html` ✓ (ensureList × N, loadAllData × N, nav item, page section, script tag)
- `js/nav.js` ✓ (route + _resetPageFilters)
- `js/signalr.js` ✓ (PAGE_RENDER_FN)
- `js/<pageKey>.js` ✓ (new file exists)

### Deploy
Use the `deploy` skill with a clear message about the new page + the schema bump.

## Common mistakes
- Forgetting to bump `PROVISION_VERSION` → existing users never get the new SP lists
- Missing the destructure position in `loadAllData` → all per-cache assignments after the new entry shift by one and become wrong
- Forgetting the `<script>` tag → render function exists but is never loaded; nav silently fails
- Forgetting the `signalr.js` entry → page works on first load but ignores live updates
- Off-by-one cache-bust count after `sed` sweep → silent stale-asset cache for half the users
