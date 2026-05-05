---
name: bsc-add-column
description: Add a new column to an existing SharePoint list in BSC Ops. Lighter-weight than the new-list skill — for schema tweaks where the list already exists. Pass the list key and column spec as the argument (e.g. "checklists DueDate dateTime").
allowed-tools: Read, Bash, Edit
---

The user wants to add a column to an existing SharePoint list. This happens way more often than adding a whole new list — common cases: a new optional field on inventory, a flag column, a new dateTime tracker, a JSON blob field for extensible metadata.

Argument: $ARGUMENTS
(Format expected: `<listJsKey> <ColumnName> <type> [options]`. Examples:
- `checklists DueDate dateTime`
- `projects Watchers text-multi`
- `inventory FreezerOK text`
- `transfers ApprovedBy text`
- `merchInventory CostBasis number`)

Repo: `/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops`

## When to use this vs other skills
- **This skill**: Adding a column to a list that already exists in `LISTS`. Light schema bump.
- **`new-list` skill**: Adding a brand-new SharePoint list. Heavier — wires up cache + load + render hooks.
- **`bsc-new-page` skill**: Adding a whole new top-level page with its own module file.

## Required touch points

### 1. Find the `ensureList(LISTS.<listJsKey>, [...])` call
Most are in `index.html` inside `ensureAllLists()`. A few may be in `js/<feature>.js` (e.g., per-location lists provisioned at first save). Use grep:
```bash
grep -n "ensureList(LISTS.<listJsKey>" "/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops/index.html" "/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops/js/"*.js
```

### 2. Append the new column definition to the columns array
Common type mappings (all use camelCase keys per Graph API):
| Type input | Column spec |
|---|---|
| `text` | `{name:'<ColumnName>',text:{}}` |
| `text-multi` | `{name:'<ColumnName>',text:{allowMultipleLines:true}}` |
| `number` | `{name:'<ColumnName>',number:{decimalPlaces:'automatic'}}` |
| `number-int` | `{name:'<ColumnName>',number:{decimalPlaces:'none'}}` |
| `dateTime` | `{name:'<ColumnName>',dateTime:{}}` |
| `bool` | `{name:'<ColumnName>',boolean:{}}` |

Insert the new column at the end of the array (preserves visual grouping for existing readers). If the column belongs with a related group of fields, you can also tuck it next to its sibling.

### 3. Bump `PROVISION_VERSION` in `js/constants.js`
Increment by 1. The version-mismatch check in `bootstrapApp` re-runs `ensureAllLists()` on each user's next page load, and `ensureList()` adds missing columns to existing lists automatically (no list recreation, no data loss). No "Clear Local Data" needed.

### 4. (Conditional) Update `state.js` if the column needs initialization
Most columns just appear as undefined on existing rows — no state.js change needed. Only update if the cache object structure depends on this field at boot.

### 5. (Conditional) Wire the column into render code
This is the part the user usually came here to do. The column won't show up anywhere automatically — find where the list is rendered and add display + edit affordances.

## Verify ensureList ADDS columns (doesn't recreate lists)
The `ensureList(listName, columns)` function in `js/graph.js`:
1. Reads existing column metadata from the SP list
2. Adds any columns from your spec that don't exist yet
3. Leaves existing columns untouched
4. Logs `[ensureList] <list>: column "X" failed — <err>` for any column add that fails (won't abort the loop)

So column additions are non-destructive. Existing rows on the list will have `undefined` (or `null`) for the new field until populated.

## After the column is added

### Bump APP_VERSION + sweep cache-busts
Same drill as any deploy:
- `js/constants.js`: bump `APP_VERSION` letter suffix
- `sed -i '' 's/v=OLD/v=NEW/g'` across `index.html`
- Verify count: `grep -c "v=NEW" index.html` matches the expected number (currently 40 as of 2026-05-04y)

### Deploy
Use the `deploy` skill. Mention the PROVISION bump and the new column in the commit message so future-you can find it.

## Backfilling existing data (if needed)
For a column that needs a default value on existing rows (rare — usually leaving them null is fine), write a one-time backfill snippet in console:
```javascript
// Run once — find rows missing the field, PATCH a default
const items = cache.<listJsKey>.filter(x => !x.<ColumnName>);
for (const i of items) {
  await updateListItem(LISTS.<listJsKey>, i.id, { <ColumnName>: '<default>' });
}
```
Don't ship a backfill in the bundle — it's a one-time op, not a recurring code path.

## Common mistakes
- Forgetting to bump `PROVISION_VERSION` → new column never gets added to existing users' SP list, then the app silently fails to read/write the field
- Using snake_case column names in the spec (Graph wants PascalCase)
- Putting `decimalPlaces` as a number instead of a string (must be `'automatic'`, `'none'`, etc.)
- Adding the column to `ensureList` but never wiring it into render code (the data is there, the user can't see it)
