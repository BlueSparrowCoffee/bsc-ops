---
name: deploy
description: Commit and push changes to the BSC Ops repo. Use this after any code change to index.html or js/* modules. Pass a short description of what changed as the argument.
allowed-tools: Bash
---

The user wants to commit and push the current changes to the BSC Ops repository.

Argument provided: $ARGUMENTS

## Steps

1. Run `git -C "/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops" status` to confirm what's changed.
2. Run `git -C "/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops" diff --stat` to verify the scope.
3. Stage **only the files this session actually modified** by name (e.g. `git add index.html js/cogs.js js/constants.js`). NEVER `-A`, NEVER `.`. If unsure which files changed, read `git status` output and stage exactly those.
4. Commit with a clear message derived from the argument, always appended with the co-author line:

```
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Use a HEREDOC for the commit message to preserve formatting.

5. Push to `origin main`.
6. Confirm success with a one-line summary of what was deployed.

## Rules
- Never use `--no-verify`
- Never `git add -A` or `git add .` — always name files explicitly
- Post module-split (April 2026), most COGs/inventory edits touch BOTH `index.html` (cache-bust strings) AND one or more `js/*.js` modules. Stage all of them.
- If `js/constants.js` was modified to bump `APP_VERSION`, also confirm `index.html` had the matching `sed` cache-bust update (27 occurrences) — they go together.
- If there is nothing to commit, say so and stop
- Repo path: `/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops`
