---
name: bsc-audit
description: Full-stack audit of the BSC Ops app — correctness, security, reliability, performance, UX, maintainability, observability, build/deploy. Produces a severity-tagged report; does not auto-fix. Pass a phase name to scope (e.g. "security", "speed", "fast") or a filename to restrict to one file. Empty argument runs the full sweep.
allowed-tools: Read, Bash, Grep, Glob
---

You are running a full-stack audit of the BSC Ops app. The repo is a vanilla-JS SharePoint-backed
single-page app deployed to Azure Static Web Apps. There is no test suite — the audit is your
test suite.

Repo: `/Users/jeffreyknott/Desktop/BSC x Claude 1.0/bsc-ops`
Memory dir: `/Users/jeffreyknott/.claude/projects/-Users-jeffreyknott-Desktop-BSC-x-Claude-1-0/memory/`

Argument: `$ARGUMENTS`

START BY READING:
  - `memory/bsc_ops_app.md` (architecture, versions, security rules)
  - `memory/bsc_ops_patterns.md` (idioms in active use)
  - `memory/bsc_ops_lists.md` (full SP list map)
  - `memory/bsc_open_issues.md` (known issues — don't re-flag)
  - `js/constants.js` (current APP_VERSION, PROVISION_VERSION, MODULES, LISTS)
  - The most recent `handoff_*.md` (recent context)

Skip anything already in `bsc_open_issues.md` or recent handoffs unless you find it has regressed.

═══════════════════════════════════════════════════════════════════════════════
ARGUMENT MODES
═══════════════════════════════════════════════════════════════════════════════
`$ARGUMENTS` controls scope:
  (empty)        → full sweep, all 8 phases
  "security"     → Phase 2 only
  "speed"        → Phase 4 only
  "fast"         → Phases 1, 2, 3 only (skip deep perf + a11y)
  "<filename>"   → restrict scope to a single file (e.g. "js/projects.js")

═══════════════════════════════════════════════════════════════════════════════
SEVERITY RUBRIC — apply consistently
═══════════════════════════════════════════════════════════════════════════════
P0  Data loss, auth bypass, secret exposure, app won't load. Fix today.
P1  Real bug or vuln users will hit; reliability gap that loses writes; XSS sink
    reachable by a non-owner user. Fix this session.
P2  Edge-case bug, perf cliff at >Nx scale, dead code, stale comment. Backlog.
P3  Style, naming, "could be cleaner". Don't list these unless asked explicitly.

A finding without a severity label is invalid. If unsure between two, pick higher.

═══════════════════════════════════════════════════════════════════════════════
PHASE 1 — CORRECTNESS & DEBUGGING
═══════════════════════════════════════════════════════════════════════════════
Look for actual bugs hiding in the live code.

Checks:
  • `console.error` / `console.warn` — grep all of them. Each should be either an
    expected user-facing error path or a TODO. Anything noisy in normal use is a bug.
  • try/catch with empty catch or `catch(e){}` — silent failure swallowing real errors.
  • Date handling — grep `new Date(`, `toISOString`, `getDate`. Confirm UTC vs local
    timezone is consistent. Multi-day checklists, transfer month grouping, and
    clock-in cron are all date-sensitive.
  • Money math — grep `parseFloat`, `Number(`, `* 100`, `/ 100`. Floating-point
    rollups (Transfer Summary, COGs) need sanity. Check that sums of cents-as-dollars
    don't drift.
  • Async race conditions — find `await` inside loops that share state, or
    `saveX()` calls that don't await before re-rendering.
  • Half-deleted features — per the "remove means delete" rule, grep for any
    legend/CSS class/handler whose owning feature was removed. Examples to check:
    legacy Build Order modal, spreadsheet import, 5 LB Bag Labels (currently
    flagged off — confirm flag actually disables every code path).
  • Dead code — exported helpers with zero call sites, modal HTML referenced by no JS.
  • Stale comments — any `// TODO`, `// FIXME`, `// HACK`, `// removed`,
    `// for now`, `// temporary`. Each is a finding.
  • "Optional" SP fields the code treats as required (and vice versa).

Output: list bugs with `file:line` and a one-line repro.

═══════════════════════════════════════════════════════════════════════════════
PHASE 2 — SECURITY
═══════════════════════════════════════════════════════════════════════════════
This app is internal but reachable on the public internet behind AAD; treat it as
exposed. Defense in depth — SP permissions are the real perimeter, but bugs in
the client still matter.

Checks:
  • XSS sinks — grep `innerHTML`, `outerHTML`, `insertAdjacentHTML`, ` = \``
    (template-literal assignment). For each, verify every interpolated value is
    either (a) a constant, (b) numeric, or (c) passed through an escape helper.
    User-controlled fields known to flow into the DOM: Description, Notes, Body,
    TaskName, Label, ProjectName, Tag, Owner, Watchers, Assignee, Blocker,
    survey notes, recipe instructions. Each is a candidate sink.
  • URL/href injection — `<a href="${x}">`. Validate URL scheme (http/https only).
    Project Links are user-supplied URLs — confirm `javascript:` is blocked.
  • Hardcoded secrets — grep `sk_`, `Bearer `, `client_secret`, `AccessKey=`,
    `SharedAccessSignature`, `apiKey`, `api_key`, `Authorization: `. Any hit
    in committed JS is P0. Function app config is fine; client code is not.
  • Auth checks bypassed by client-only gating — every owner/manager-only action
    needs to be safe even if the gate is removed. SP list perms are the
    enforcement. Confirm the SP list ACLs actually restrict writes for baristas
    on owner-only lists (Vendors, Settings, MarketSurveys, Projects writes, etc.).
  • Mail.Send abuse surface — who can trigger `_orderBody` / auto-send? Confirm
    the recipient address is server-validated or comes from a fixed Vendors list
    (not free-text user input that could send mail to arbitrary recipients).
  • localStorage PII — list every key written to localStorage and what it holds.
    Anything containing real names, emails, costs, or auth tokens is a finding.
  • CodeQL — run `gh api repos/<owner>/<repo>/code-scanning/alerts?state=open`
    and list any open alerts. Cross-reference against past fixed alerts in
    handoffs (#34, #36 are fixed).
  • CSP headers — read `staticwebapp.config.json`. Confirm CSP exists; if missing,
    that's P1.
  • Function app — list any HTTP endpoints. Each must require AAD auth or be
    explicitly public. Time-clock cron is invoked by Logic App; confirm not
    publicly callable.
  • Secret rotation — per memory, AAD client secret expires ~2028-05. Note the
    specific expiry date and how many days remain.

Output: severity-tagged findings with `file:line` and remediation sketch.

═══════════════════════════════════════════════════════════════════════════════
PHASE 3 — RELIABILITY & DATA INTEGRITY
═══════════════════════════════════════════════════════════════════════════════
This app has no DB transactions — every write is an isolated Graph PATCH. Failure
modes matter.

Checks:
  • Graph 429/503 retry — find the fetch wrapper. Does it retry with backoff?
    What's the cap? On final failure, does the user see a real error or a silent
    no-op?
  • Concurrent edits — Graph supports If-Match / etag. Are we using it for any
    write? If not, last-write-wins is the policy — confirm that's intentional
    for each list type. Counts and Transfers especially.
  • SignalR reconnect — read `js/signalr.js`. On disconnect, does the client
    refresh state on reconnect, or trust local cache? If trust, a missed message
    means stale UI.
  • Bootstrap migration path — when `PROVISION_VERSION` mismatches, `ensureAllLists`
    runs. If it fails partway (network drop after list 3 of 4), what happens
    next reload? Is the partial state idempotent?
  • Pagination — grep `getListItems`. Does it handle `@odata.nextLink`?
    Lists likely to grow past 5000 rows: BSC_Counts, BSC_Transfers, BSC_TimeClock,
    BSC_OrderHistory. Anything paginated to a fixed top is a P1 at scale.
  • Daily auto-sync (A) — find the entry. On error mid-stream, does it leave
    partial state? Does it log the failure visibly?
  • Square 2-way archive — idempotent? Running it twice in a row should be a no-op.
  • Service worker — read `sw.js`. Cache version is v20 per memory. Confirm
    `APP_VERSION` bumps trigger SW activation correctly. Stale SW serving old
    `js/*.js` after deploy is the most common "user reports a bug that was already fixed."
  • Cache-bust integrity — `grep -c "v=<APP_VERSION>" index.html` should match
    the documented count (40 as of 2026-05-04y). Drift means a module is
    serving stale.
  • Time-clock cron — what happens if the 6:20am Slack DM run errors? Is there
    a retry, alert, or dead-letter? Or does it just silently miss a day?
  • Logic App / Function failures — where do errors surface? Application
    Insights? Slack channel? Or are they invisible until someone notices missing data?

Output: each gap as a finding + the specific failure scenario (e.g., "if Wi-Fi
drops between PATCH 1 and PATCH 2 of `moveProjectLink`, SortOrders desync").

═══════════════════════════════════════════════════════════════════════════════
PHASE 4 — PERFORMANCE & SPEED
═══════════════════════════════════════════════════════════════════════════════
Measure where you can; reason where you can't.

Checks:
  • Bootstrap sequence — read `loadAllData` in `index.html`. Are `getListItems` calls
    parallelized with `Promise.all`, or sequential? Sequential is a major win to fix.
  • Render churn — find each `render*()` function. Does it rebuild the entire DOM
    subtree on every state change, or surgically update? Big lists (Counts,
    Transfers, Projects, Recipes) are the candidates.
  • Large-list O(n²) — grep `.find(` and `.filter(` inside `.map(` or `.forEach(`.
    Each is a quadratic loop. At 5000+ items, noticeable.
  • Image weight — `ls -lh images/` and find anything > 200KB. PNG vs WebP.
    Hero/splash images especially.
  • CSS — `index.html` ships its own CSS. Find unused selectors via heuristic
    (class names with zero matches in JS or HTML).
  • Module split — `index.html` line count. Per memory, recommend split at 10k.
    Currently ~4900. Just confirm we're still under threshold.
  • SignalR payload — when a row changes, do we refetch the whole list or accept
    the delta from the message? Refetch on every message is wasteful.
  • Click-to-edit `prompt()` calls — these block the main thread. Note the count;
    flag if any is on a hot path.
  • Cache-bust query strings — 40 separate `?v=...` URLs. Browsers parallelize
    over HTTP/2 fine, but confirm we're served HTTP/2 (`curl -I --http2 https://<host>/`).

Output: list bottlenecks with measured cost where possible (line counts, file
sizes), or a reasoned estimate.

═══════════════════════════════════════════════════════════════════════════════
PHASE 5 — UX & ACCESSIBILITY
═══════════════════════════════════════════════════════════════════════════════
Quick pass — not a full WCAG audit.

Checks:
  • Modal ESC-to-close — every modal should respond to ESC. Grep `keydown` /
    `Escape` and verify coverage.
  • Focus trap — when a modal opens, focus moves into it; when it closes, focus
    returns to the triggering element. Most modals here likely don't.
  • `aria-label` on icon-only buttons — every button whose visible content is only
    an emoji needs an `aria-label` or sr-only text. Grep `<button` for content
    that's a single emoji or icon.
  • Color contrast on status pills — Planning gray, Active blue, On Hold amber,
    Done green. Confirm WCAG AA (4.5:1) for body text. If unsure, flag and skip.
  • Mobile touch targets — minimum 44×44 pt. The +1/-1 count buttons were
    explicitly enlarged; confirm other touch targets meet the bar.
  • Loading states — every async action should show a spinner or disable its
    button. Find buttons that fire fetch without disabling.

Output: P2 list (UX rarely P0 unless a button is unreachable).

═══════════════════════════════════════════════════════════════════════════════
PHASE 6 — MAINTAINABILITY
═══════════════════════════════════════════════════════════════════════════════
Checks:
  • Duplicated helpers — grep for identical or near-identical functions across
    modules (date formatters, money formatters, escape helpers). Consolidate
    candidates go into a util module.
  • Magic numbers — anything other than 0/1/-1 inline. Especially day counts (90
    for auto-archive), thresholds, animation durations.
  • Naming consistency — camelCase across the board. Flag snake_case or kebab.
  • Module split candidates — any single module > 1500 LOC. List with line counts.
  • Inline event handlers — `onclick="..."` in `index.html` template strings vs
    `addEventListener`. Mixed style is OK; flag only if it makes a specific
    refactor harder.

Output: P2/P3 only.

═══════════════════════════════════════════════════════════════════════════════
PHASE 7 — OBSERVABILITY
═══════════════════════════════════════════════════════════════════════════════
Checks:
  • Error logging — is there any client-side error reporter? `window.onerror`?
    Application Insights JS SDK? If not, every silent failure is invisible to
    the team. Flag as P1 if zero error reporting exists.
  • User action audit — do edits get logged anywhere (who/when)? SP itself
    tracks `Modified`/`ModifiedBy`, but cross-list operations (e.g., a transfer
    that touches 2 lists) aren't traceable as a single action.
  • Health check — is there a `/health` endpoint or equivalent? If a Function or
    Logic App breaks, who notices, and how?
  • Debug toggle — a global flag that turns on verbose logging would help future
    debugging. Note whether one exists.

═══════════════════════════════════════════════════════════════════════════════
PHASE 8 — BUILD & DEPLOY
═══════════════════════════════════════════════════════════════════════════════
Checks:
  • Pre-commit / pre-deploy lint — none today, per the project shape. Note the gap.
  • `staticwebapp.config.json` — read it. Confirm routing rules, auth config,
    response overrides are sane.
  • SW cache version (v20) vs `APP_VERSION` drift — both should bump together;
    confirm the deploy skill enforces this.
  • Cache-bust count drift — actual `grep -c "v=<APP_VERSION>" index.html` vs
    documented count in `bsc_ops_app.md`. Mismatch = a forgotten bump.
  • `.DS_Store` committed? gitignore'd?
  • Deploy script idempotency — re-running deploy with no changes should be a no-op.

═══════════════════════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════════════════════
Group findings by phase. Inside each phase, list by severity (P0 first).
Each finding:

  [P1] <one-line title>
  File: js/foo.js:123
  Issue: <2-3 sentence description>
  Fix: <concrete remediation, ideally one sentence>
  Effort: <S | M | L>     # S = <30 min, M = a few hrs, L = >1 day

End with three lists:
  • **TOP 5** — what to fix this session (highest severity × lowest effort)
  • **DEFER** — flagged but not now
  • **CONFIRMED CLEAN** — areas you actively checked and found nothing wrong, so
    they don't get re-checked next audit

Do NOT spawn separate commits or PRs. This is a report. The user picks what to
ship.

═══════════════════════════════════════════════════════════════════════════════
RULES
═══════════════════════════════════════════════════════════════════════════════
• Every finding cites `file:line`. "There might be an XSS somewhere" is invalid.
• Don't list things already in `bsc_open_issues.md` or the most recent handoff.
• Don't propose abstractions. Findings are problems, not refactors.
• Don't auto-fix. Wait for the user to pick from TOP 5.
• If a phase yields zero findings, write "Phase N: clean" — don't pad.
• Time-box: if a phase is taking >30 min of search, summarize what you covered
  and what you skipped. Honesty beats false confidence.
