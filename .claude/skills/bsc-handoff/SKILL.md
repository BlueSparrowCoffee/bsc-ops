---
name: bsc-handoff
description: Generate a session handoff brief for the BSC Ops project. Reads recent commits, summarizes shipped work, updates MEMORY.md index + version stats, and rolls resolved items into the open-issues log. Run at the end of any meaningful BSC Ops session.
allowed-tools: Read, Bash, Edit, Write
---

The user wants to wrap up a BSC Ops session with a handoff brief — the standard memory artifact that lets the next session pick up cold without re-reading transcripts.

Argument: $ARGUMENTS (optional — usually empty; the skill reads commit log + diff to infer what shipped)

Repo: `/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops`
Memory dir: `/Users/jeffreyknott/.claude/projects/-Users-jeffreyknott-Desktop-BSC-x-Claude-1-0/memory/`

## Steps

### 1. Identify what shipped this session
Run in parallel:
- `git -C "<repo>" log --oneline -20` — pull recent commits
- `git -C "<repo>" log --since="24 hours ago" --pretty=format:"%h %s%n%b%n---"` — full bodies of recent commits
- Read the latest existing handoff in memory dir to find the cutoff (handoff frontmatter has the originating session info)

Determine:
- Which commits belong to THIS session (not already covered by the most recent handoff)
- The starting + ending `APP_VERSION` (find in `js/constants.js` history if needed)
- The starting + ending `PROVISION_VERSION`
- Cache-bust count delta (new modules added)

### 2. Pick the handoff filename
- Today's date in `YYYY-MM-DD` (use `date +%Y-%m-%d` if needed, or system date)
- If a handoff for today already exists, suffix with `b` (e.g., `handoff_2026-05-04b.md`)
- Path: `<memory dir>/handoff_<YYYY-MM-DD>[suffix].md`

### 3. Write the handoff using the standard template
Frontmatter:
```yaml
---
name: BSC Ops — Handoff Brief <YYYY-MM-DD>[ (suffix)]
description: <one-sentence summary of the major themes>
type: project
---
```

Sections (in order):
1. **Session at a glance** — bullet list: # commits, commit hashes (`<old>` → `<new>`), `APP_VERSION` transition, `PROVISION_VERSION` transition (if changed), cache-bust count, schema migration notes, headline themes.
2. **What shipped — Commit N (`<hash>`)** — one numbered subsection per commit, each with what changed at the file/function level. Include implementation details a future session would need to navigate the code (function names, schema additions, behavior contracts).
3. **Required user actions** — anything the user must do (clear cache, re-grant access, click sync). If schema bumps auto-apply, say so explicitly. If "None", say so explicitly.
4. **Future work / deferred** — features the user explicitly vetoed or postponed for v2. Group by feature area. Include enough detail that a future session can pick the item up without re-explaining context.
5. **Patterns confirmed / reusable** — non-obvious idioms worth remembering. Examples: a click-to-edit pattern, an in-memory-only filter approach, a JSON-blob-on-row trick. Future-you will look here when building similar features.

### 4. Update `MEMORY.md` index
Add a new line near the top of the handoff list (after any existing same-day entry):
```markdown
- [BSC Ops — Handoff Brief <YYYY-MM-DD>[ <suffix>]](handoff_<YYYY-MM-DD>[suffix].md) — <one-line summary, ~150 chars>
```
Keep the index entry under 200 chars; it's an index, not a memory.

### 5. Update `bsc_ops_app.md` if versions changed
If `APP_VERSION` / `PROVISION_VERSION` / cache-bust count / module count changed:
- Edit the `APP_VERSION ...` and `PROVISION_VERSION ...` lines to current values
- Update the cache-bust count (`grep -c "v=<currentversion>" index.html`)
- Update the JS module count if a new module was added (was 31 as of 2026-05-04y)

### 6. Update `bsc_open_issues.md`
- If the session resolved any open issue, move it to the "Recently Resolved" section with date + 1-line note
- If the session left a known issue open, add it under the "Open Issues" section
- Keep stale resolved entries (>30 days) but move them down — recency at top
- If `PROVISION_VERSION` changed, update the "User Action Needed" note to reflect the new version (or remove if migrations now auto-apply)

### 7. Update `bsc_ops_lists.md` if SP lists were added/removed
If new lists were added to `LISTS`, append rows to the `bsc_ops_lists.md` table with the new entries and a `← added vNN` annotation.

### 8. Confirm + report
Print a summary of what was written:
- New handoff file path
- Files touched in memory (`MEMORY.md`, `bsc_ops_app.md`, `bsc_open_issues.md`, `bsc_ops_lists.md` as applicable)
- 1-line tagline of what shipped

## Rules
- Don't generate the handoff body from the COMMIT MESSAGES alone — read the actual diff for technical detail. Commit messages are a starting point, not a substitute.
- Prefer specifics over generalities: function names, schema field names, behavior contracts, file:line citations beat "added a feature".
- Use the user's words verbatim where they made specific calls ("user said one-shot only", "vetoed kanban for v1") so future sessions don't re-relitigate decisions.
- Never delete or rewrite an existing handoff — they're append-only history. Only add new ones or update the index.
- Keep the index entries in `MEMORY.md` short. Detail goes in the handoff file itself.

## Skip conditions
If the session had no commits AND no meaningful design decisions, say so and don't write a handoff. Empty handoffs are noise.
