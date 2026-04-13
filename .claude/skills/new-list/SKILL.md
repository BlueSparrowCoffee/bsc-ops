---
name: new-list
description: Checklist for adding a new SharePoint list to BSC Ops. Ensures every required touch point is hit. Pass the list key name and SharePoint list name as the argument (e.g. "prepLogs BSC_PrepLogs").
allowed-tools: Read, Bash, Edit
---

The user wants to add a new SharePoint list to the BSC Ops app.

Argument: $ARGUMENTS
(Format expected: `<jsKey> <SharePointListName>`, e.g. `prepLogs BSC_PrepLogs`)

File: `/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops/index.html`

## Required touch points — complete ALL of these

### 1. LISTS constant
Find `const LISTS = {` and add the new entry:
```javascript
<jsKey>: '<SharePointListName>',
```

### 2. ensureAllLists()
Find the `ensureAllLists` function and add a `ensureList(LISTS.<jsKey>, [...fields])` call with the correct field definitions. Each field needs at minimum `{ name, type }`. Common types: `Text`, `Number`, `DateTime`, `Boolean`, `Note` (multi-line text).

### 3. PROVISION_VERSION bump
Find `const PROVISION_VERSION = '...'` and increment the number by 1. This triggers `ensureAllLists()` to run on next load for all users.

### 4. cache object
Find where `cache` is initialized (search for `let cache =` or `const cache =`) and add a `<jsKey>: []` entry so the cache slot exists before data loads.

### 5. loadData() / refresh
Find the main data loading function and add a fetch for the new list using the existing `getListItems(LISTS.<jsKey>)` pattern, storing results into `cache.<jsKey>`.

### 6. Nav / PAGE_MODULE (if this list backs a new page)
If a new page is being added:
- Add a nav item in the sidebar HTML with `data-module="<ModuleName>"`
- Add `'<pageKey>': '<ModuleName>'` to `PAGE_MODULE`
- Add `'<ModuleName>'` to the `MODULES` array

### 7. Verify nothing was missed
After making all changes, grep for the new list name and key to confirm it appears in all expected locations:
```
LISTS constant ✓
ensureAllLists ✓
cache init ✓
loadData ✓
PROVISION_VERSION bumped ✓
```

## Rules
- Never skip the PROVISION_VERSION bump — without it, existing users won't get the new list provisioned
- Field names in `ensureList` must exactly match what the app reads from SharePoint (case-sensitive)
- After all edits, call `/deploy` with a message describing the new list
