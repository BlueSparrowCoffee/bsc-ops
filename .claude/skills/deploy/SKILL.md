---
name: deploy
description: Commit and push changes to the BSC Ops repo. Use this after any code change to index.html. Pass a short description of what changed as the argument.
allowed-tools: Bash
---

The user wants to commit and push the current changes to the BSC Ops repository.

Argument provided: $ARGUMENTS

## Steps

1. Run `git -C "/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops" status` to confirm what's changed.
2. Run `git -C "/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops" diff --stat` to verify the scope.
3. Stage and commit with a clear message derived from the argument, always appended with the co-author line:

```
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Use a HEREDOC for the commit message to preserve formatting.

4. Push to `origin main`.
5. Confirm success with a one-line summary of what was deployed.

## Rules
- Never use `--no-verify`
- Always use `git add index.html` (not `git add -A`) unless the user explicitly mentions other files
- If there is nothing to commit, say so and stop
- Repo path: `/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops`
