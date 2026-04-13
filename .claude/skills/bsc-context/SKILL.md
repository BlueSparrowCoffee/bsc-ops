---
name: bsc-context
description: Load full BSC Ops project context — tech stack, SharePoint lists, current PROVISION_VERSION, modules, and role system. Run this at the start of a session or when context feels stale.
allowed-tools: Read, Bash
---

Load and summarize all critical context for the BSC Ops project so the session is fully informed.

## Read these memory files

- `/Users/jeffreyknott/.claude/projects/-Users-jeffreyknott-Desktop-BSC-x-Claude-1-0/memory/bsc_brand_guide.md`
- `/Users/jeffreyknott/.claude/projects/-Users-jeffreyknott-Desktop-BSC-x-Claude-1-0/memory/bsc_integrations.md`

## Read these live values from index.html

File: `/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops/index.html`

Extract and report:
1. **PROVISION_VERSION** — grep for `const PROVISION_VERSION`
2. **LISTS constant** — grep for `const LISTS` and read the full object (all SharePoint list key → name mappings)
3. **MODULES array** — grep for `const MODULES`
4. **PAGE_MODULE map** — grep for `const PAGE_MODULE`
5. **Current line count** — run `wc -l` on index.html

## Report format

Summarize in a compact, scannable format:

```
PROVISION_VERSION: '19'
index.html: ~N lines

SharePoint Lists:
  inventory → BSC_Inventory
  ... (all entries)

Modules: Dashboard, Inventory, ...
Page → Module map: dashboard → Dashboard, ...

Tech stack: Azure Static Web Apps + Azure Functions, MSAL v2, Microsoft Graph API + SharePoint REST
DB: SharePoint lists (no SQL)
Auth: AAD browser-side via MSAL
Repo: /Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops
```

Also flag: if index.html is over 10,000 lines, recommend splitting into JS modules.
