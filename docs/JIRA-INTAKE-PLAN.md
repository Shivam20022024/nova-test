# Plan: "Jira → NovaTest" — run tests from a bug raised in Jira

*Written in plain language. Read top to bottom.*

---

## 1. The idea in one line

Today: **a test fails in NovaTest → we file a bug in Jira.**
New feature: **someone files a bug in Jira → NovaTest runs the tests, shows the
report on the dashboard, and (optionally) replies to that same Jira bug with the
result.**

It's the same Jira integration we already have, just running in the other
direction.

---

## 2. What it looks like for a real person

1. A QA person on the client's team finds something broken. They open Jira and
   create a bug the normal way: title, description, which page/URL it's on, links
   to the user stories it affects.
2. They add one thing that tells NovaTest "please test this" — the simplest
   version is a **label** on the issue, e.g. `novatest-run`.
3. Within a few minutes, NovaTest notices the new bug, figures out what to test,
   and runs it.
4. A new run appears on the **NovaTest dashboard** with a badge that says
   **"From Jira"**. Opening it shows a panel: *Raised by Ana Costa in PROJ-142 —
   "Checkout button does nothing on mobile"*.
5. NovaTest posts a **comment back on the Jira bug**:
   > 🤖 NovaTest ran the automated checks for this bug.
   > **Result: FAILED** — 1 of 6 steps failed.
   > "Tap Checkout" timed out after 30s. [View full report ›](link)

That's the whole feature.

---

## 3. How it works, step by step

```
        Jira (client's team)                 NovaTest
   ┌─────────────────────────┐        ┌──────────────────────────────┐
   │ 1. Person creates a bug │        │                              │
   │    + label "novatest-run"│       │                              │
   └───────────┬─────────────┘        │                              │
               │                      │  2. Every few minutes,       │
               │  ◀───────────────────┤     NovaTest asks Jira:       │
               │   "any new bugs with │     "give me bugs labelled    │
               │    that label?"      │      novatest-run since last  │
               │                      │      time"                    │
               │ ─────────────────────▶  3. Jira returns PROJ-142     │
               │                      │                              │
               │                      │  4. NovaTest reads the bug:  │
               │                      │     reporter, description,   │
               │                      │     target URL, what to test │
               │                      │                              │
               │                      │  5. NovaTest runs the test   │
               │                      │     (reusing the existing    │
               │                      │      run pipeline)           │
               │                      │                              │
               │                      │  6. Run finishes → report    │
               │                      │     saved, tagged "From Jira"│
               │                      │                              │
               │  ◀───────────────────┤  7. NovaTest posts a comment │
               │   comment on PROJ-142│     on PROJ-142 with the     │
               │                      │     result + report link     │
   └───────────────────────────┘      └──────────────────────────────┘
```

Nothing here is exotic. Step 2/3 is "ask Jira a question". Step 5 is the run
button we already have. Step 7 is one more Jira API call, almost identical to how
we already **create** issues.

---

## 4. Three decisions to make first

### Decision A — How does NovaTest find out about the new bug?

| Option | How it works | Good | Bad |
|---|---|---|---|
| **Polling** *(recommended)* | NovaTest asks Jira every few minutes | No setup on Jira side, works even though NovaTest isn't on the public internet, easy to build | Up to a few minutes' delay |
| **Webhook** | Jira instantly notifies NovaTest when a bug is created | Real-time | NovaTest needs a public URL Jira can reach; client's Jira admin has to add a webhook or an Automation rule; needs a shared secret |

**Recommendation:** build **polling** first. Add webhook later as an optional
"instant mode" if someone wants it. The rest of the plan assumes polling.

### Decision B — How does the bug tell NovaTest *what* to test?

The bug in Jira has to carry enough information. Three levels, from simplest to
smartest — we can support more than one:

| Level | What the reporter does | What NovaTest does | Reliability |
|---|---|---|---|
| **1. Point at an existing test** *(recommended for v1)* | Adds a label like `novatest:SUITE-88` or `novatest:TC-125`, or picks it in a custom field | Re-runs that saved suite / test case | Highest — it's a test we've already run before |
| **2. Fill a small template** | Pastes a short block in the description: `Target URL:` + a bullet list of steps | Parses that block into steps (we already have a scenario parser) | Medium |
| **3. Just describe it** | Writes the bug normally, links the user stories | AI reads the description + stories and generates a test suite (the "Autonomous QA" path we already have) | Lowest, but most magical |

**Recommendation:** v1 supports **Level 1 and Level 2**. If the issue links a
test → use it. Else if it has the template block → parse it. Level 3 (AI from the
story) is a great phase-3 add-on.

### Decision C — What exactly triggers a run?

Pick the condition NovaTest looks for. Options: a **label** (`novatest-run`), an
**issue type** ("Bug"), a **status change** ("moved to *Ready for QA*"), or a
**custom field** ticked. **Recommendation: a label.** It's the least intrusive,
works on any Jira plan, and the team can add it to old issues too.

---

## 5. What we build

Everything below follows patterns that **already exist in this codebase** — the
CI trigger route (`routes/ci.ts`), the Jira bug-filing service
(`services/JiraService.ts`), and the hand-written SQL migrations in
`backend-node/migrations/`.

### 5.1 Jira side (config, not code)

- The client's Jira project gets one **label**: `novatest-run`.
- (Optional, Level 1) A **custom field** "NovaTest Suite" or an agreed label
  format `novatest:SUITE-xx`.
- The API token we **already store** per project (`JiraIntegration` table) is
  reused — it needs permission to *read issues* and *add comments* (it already
  can create issues, so this is usually already fine).

### 5.2 Database — one migration file (`005_jira_intake.sql`)

Same style as `004_ci_trigger_metadata.sql` — additive only, run by hand in the
Supabase SQL editor.

**Add to `ExecutionLog` (nullable columns):**

| Column | Meaning |
|---|---|
| `triggeredBy` | already exists — we start writing `'jira'` (today it's `'manual'` / `'ci'`) |
| `jiraSourceIssueKey` | the bug that triggered this run, e.g. `PROJ-142` |
| `jiraSourceReporter` | who raised it, e.g. `Ana Costa` |
| `jiraSourceSummary` | the bug's title |
| `jiraResultCommentUrl` | link to the comment we posted back (null if not posted) |

**New table `JiraIntakeConfig`** (one row per NovaTest project):

- `projectId`, `enabled` (on/off), `triggerLabel` (default `novatest-run`),
  `pollIntervalMinutes` (default 5), `defaultBrowsers` (default `["chromium"]`),
  `postResultComment` (`always` / `on_failure` / `off`), `lastPolledAt`.

**New table `JiraIntakeIssue`** (so we never run the same bug twice):

- `issueKey` (unique), `projectId`, `status` (`queued` / `running` / `done` /
  `skipped`), `executionId`, `reason` (why skipped), `processedAt`.

### 5.3 Backend — `backend-node`

**a) Extend `JiraService.ts` with three small methods:**

- `searchIssues(jql)` → `GET /rest/api/3/search` — find the new bugs.
  JQL example: `project = PROJ AND labels = "novatest-run" AND updated >= -10m`.
- `getIssue(key)` → `GET /rest/api/3/issue/{key}` — read reporter, description,
  custom fields, linked issues (the user stories).
- `addComment(key, adfBody)` → `POST /rest/api/3/issue/{key}/comment` —
  **this is the "reply to the thread" piece** (see section 6).

**b) New route file `routes/jiraIntake.ts`** (mounted at `/api/v1/jira/intake`):

- `GET /config` / `PUT /config` — read/update the `JiraIntakeConfig` for a project.
- `POST /poll` — "Check Jira now" button (session-authenticated). Runs one poll
  immediately instead of waiting for the timer.
- `GET /runs` — list of Jira-triggered runs, for the dashboard/report screens.
- `POST /webhook` — *(phase 4, optional)* receives Jira's instant notification;
  guarded by a shared secret in the URL, skips the normal login check (same
  approach the mobile WebSocket handler already uses).

**c) The poller itself** — a repeating background job:

- Runs every N minutes (a BullMQ *repeatable job*, or a simple `setInterval` in
  `index.ts` — the Python side already does this for schedules).
- For each NovaTest project where `JiraIntakeConfig.enabled = true`:
  1. Ask Jira for issues matching the label, updated since `lastPolledAt`.
  2. For each issue **not already in `JiraIntakeIssue`**:
     - Read the issue (reporter, description, target URL, linked test / template).
     - Work out what to run (Decision B logic).
     - Call the **existing** `POST /api/v1/executions/run-multi-test` endpoint
       with a new `source` block:
       `source: { provider: 'jira', issueKey, reporter, summary }`.
     - Save a `JiraIntakeIssue` row so we don't do it again.
  3. Update `lastPolledAt`.

**d) Tiny change to `routes/executions.ts`:** the helper `ciCols(source)` today
only understands `commitSha` / `branch` / `prNumber`. Extend it (or add a sibling
`triggerCols`) so `provider: 'jira'` writes `triggeredBy = 'jira'` +
`jiraSourceIssueKey` / `jiraSourceReporter` / `jiraSourceSummary`. This is a
~15-line change and touches nothing else.

**e) Post the result back** — a small hook after a run finishes:

- In `queue/executionWorker.ts`, where a run reaches PASSED / FAILED, add:
  *if* `triggeredBy === 'jira'` *and* the config says post back → build a short
  summary (reuse the ADF builders already in `JiraService`) → `addComment(...)`
  → save `jiraResultCommentUrl`.
- **Important guard:** a Jira-triggered run must **not** auto-file a brand-new
  Jira bug when it fails (we already have that feature). Otherwise: bug triggers
  run → run fails → new bug filed → new bug triggers run → loop. Fix: skip
  auto-filing for `triggeredBy === 'jira'` runs, and the poller ignores any
  issue whose reporter is our own bot account.

### 5.4 Frontend — `frontend`

- **Integrations page** — new "Jira Intake" card: on/off toggle, trigger-label
  field, poll interval, "post result back to Jira" dropdown, **"Check now"**
  button, "last checked 3 min ago", "12 runs triggered from Jira".
- **Command Center / Executions list** — the run row already shows a "CI" badge
  when `triggeredBy === 'ci'`. Add a **"Jira"** badge for `'jira'`, linking to
  the issue.
- **Execution report page** — new **"Raised from Jira"** panel: issue key
  (clickable → Jira), reporter name, the bug summary, and "Result posted back to
  Jira ✓" with a link to the comment.
- **Types** (`lib/types.ts`) — extend `ExecutionLog.triggeredBy` to
  `'manual' | 'ci' | 'jira'`, add the four new fields, add a `JiraIntakeConfig`
  type. (This file is a hand-kept mirror of the API — see its header comment.)

---

## 6. "Reply to the Jira thread" — the part you weren't sure about

A Jira bug is an **issue**. Every issue has a **comments** section underneath it —
that *is* "the thread". Replying to it is one API call:

```
POST  {jiraBaseUrl}/rest/api/3/issue/PROJ-142/comment
Authorization: Basic <the token we already store>
{
  "body": { ...rich-text content, same format we already build for descriptions... }
}
```

We already do the *harder* version of this today — `JiraService.createIssue()`
builds that rich-text "body" and posts a whole new issue. Posting a comment is
the same code, a simpler endpoint, and no new credentials.

**What the comment says** (configurable — always / only when it fails / never):

> **🤖 NovaTest AI — automated check for this bug**
> Triggered automatically from this issue.
> **Result: FAILED** · 4 of 6 steps passed · ran on Chromium · 41s
> First failure: step 5 "Tap Checkout" — `TimeoutError: waited 30000ms`
> [Open the full report in NovaTest ›](https://…/app/execution/abc123/report)

Optionally we can also add a label to the issue (`novatest-tested`) or move it to
a status, but a comment is enough for v1.

---

## 7. Build it in phases

| Phase | What you get | Rough effort |
|---|---|---|
| **1 — Core loop (manual)** | "Check now" button → finds labelled bugs → runs a **linked** suite → report on dashboard with "From Jira" badge + panel. No auto-poll, no comment-back yet. | 2–3 days |
| **2 — Automatic + reply** | Background poll every N minutes + posts the result comment back on the bug. Config card on Integrations page. | 1–2 days |
| **3 — Smarter intake** | Parse the description template; if nothing is linked, let AI generate the test from the bug + linked user stories. | 2–4 days |
| **4 — Instant mode (optional)** | Jira webhook / Automation rule → runs within seconds instead of minutes. Needs a public URL + shared secret. | 1–2 days |

Phases 1 + 2 together are the real feature. 3 and 4 are polish.

---

## 8. Things that can go wrong (and how we avoid them)

| Risk | Fix |
|---|---|
| **Loop:** Jira bug → run fails → NovaTest files a new bug → that triggers another run | Jira-triggered runs never auto-file bugs; poller skips issues reported by our bot account or carrying a `novatest-generated` label |
| **Same bug runs every poll** | The `JiraIntakeIssue` table — one row per issue key, checked before running |
| **Jira API rate limits** | Poll no faster than every ~5 min; use `updated >= -Xm` in the query so we only pull recent changes |
| **"Target URL / user stories" live in custom fields whose IDs differ per Jira site** | A small field-mapping section in `JiraIntakeConfig` (e.g. "target URL = customfield_10042"), or read them from the description / issue links |
| **Jira sends description as rich JSON, not plain text** | A small helper that flattens Jira's ADF to plain text for the template/AI path (needed anyway) |
| **Webhook endpoint is public** | Shared secret in the URL + verify it before doing anything; same pattern as the existing CI key and mobile-proxy key |
| **Which NovaTest project does a Jira project map to?** | v1 assumes 1-to-1 — the `JiraIntegration` row already defines that pairing |
| **Token can't comment** | Show a clear error in the Integrations card ("token can create issues but not comment — check Jira permissions") |

---

## 9. Summary

- Reuse the Jira integration we already have; just point it the other way.
- **Poll** Jira for bugs with a **label**; for each new one, **run the linked
  test** through the pipeline we already have.
- Tag the run **"From Jira"**, store **who raised it**, show it on the dashboard.
- **Post a comment** back on the bug with the result — one API call, same style
  as filing a bug.
- One additive SQL migration, one new service method group, one poller, one route
  file, three small frontend additions.
- Ship Phase 1 + 2 first; AI-generated tests and instant webhooks are later.
