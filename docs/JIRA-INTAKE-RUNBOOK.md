# Jira Intake — end-to-end runbook (every location)

Follows one bug from "typed into Jira" to "result comment back on the issue".
Every step names **where** to click.

- **Jira:** `https://your-company.atlassian.net` — project **OCQ**
- **NovaTest:** `http://localhost:5173` (frontend) · `http://127.0.0.1:8080` (API)
- NovaTest project this is wired to: **TestingDemo**

---

## PHASE 0 — one-time check that Intake is on

**LOCATION:** NovaTest → top bar **project selector** → choose **TestingDemo** →
left sidebar → **Platform → Integrations** (`http://localhost:5173/app/integrations`)
→ scroll to the **"Jira Intake — bugs become tests"** card.

Confirm: status pill says **Active**, Trigger label = `novatest-run`.
(API check, no login: `curl -H "x-api-key: $CI_API_KEY" "http://127.0.0.1:8080/api/v1/jira-intake/config?projectId=87f0a31e-fc6b-4cbf-8334-173d6dbc17b1"` → `"enabled": true`.)

---

## PHASE 1 — write the user story (in Jira)

**LOCATION:** Jira → top nav → blue **Create** button (or press `C`).

| Field | Value |
|---|---|
| Project | **OCQ** |
| Issue type | **Story** (or Task) |
| Summary | `As a shopper, I can complete a purchase on the demo store` |
| Description | *(paste the block below)* |

```
As a shopper, I want to add a product to my cart and check out so that I can buy it.

Acceptance criteria:
- The catalog shows products, each with a name and a price.
- Clicking a product opens its detail page with an "Add to cart" button.
- After adding a product and opening the cart, the product is listed by name.
- Placing the order shows an order confirmation ("Thank you for your purchase").
```

Click **Create**. Note the key it gets, e.g. **OCQ-401**.
**LOCATION of the new story:** `https://your-company.atlassian.net/browse/OCQ-401`

---

## PHASE 2 — write the bug (in Jira)

**LOCATION:** Jira → **Create** button again.

| Field | Value |
|---|---|
| Project | **OCQ** |
| Issue type | **Task** (OCQ has no "Bug" type) |
| Summary | `Order confirmation does not appear after placing an order` |
| Description | *(paste the block below)* |

```
Summary
Clicking "Purchase" on the checkout dialog does nothing — no confirmation shows.

Environment
- URL: https://www.demoblaze.com
- Browser: Chrome (latest)

Steps to reproduce
1. Open https://www.demoblaze.com
2. Click the first product in the catalog (e.g. "Samsung galaxy s6")
3. On the product page, click "Add to cart" and accept the dialog
4. Click "Cart" in the top navigation
5. Click "Place Order"
6. Fill in Name, Country, City, Credit card, Month, Year
7. Click "Purchase"

Expected result
A confirmation dialog appears with the text "Thank you for your purchase!".

Actual result
Nothing happens when "Purchase" is clicked. No dialog, no error.
```

Click **Create**. Note the key, e.g. **OCQ-402**.

---

## PHASE 3 — link the bug to the story (in Jira)

**LOCATION:** open the **bug** (`.../browse/OCQ-402`) → in the issue view, the
**"+ Add"** / **"Link"** control (top of the issue, next to *Attach*, *Child
issue*) → choose **Link** → **"is related to"** → type/select the story
**OCQ-401** → **Link**.

You'll now see a **"Linked issues → is related to → OCQ-401"** section on the bug.

---

## PHASE 4 — add the trigger label (in Jira)

**LOCATION:** open the **bug** → right-hand **Details** panel → **Labels** field
→ type `novatest-run` → press Enter → it saves automatically.

The bug is now armed. Nothing else to do in Jira.

---

## PHASE 5 — NovaTest picks it up

**Automatic:** the poller checks OCQ **every 5 minutes**. Just wait.

**Or trigger it now:**
- **LOCATION (UI):** NovaTest → **Integrations** → *Jira Intake* card →
  **"Check Jira now"** button. A toast says e.g. *"Checked Jira: 1 run started."*
- **LOCATION (API, no login):**
  ```bash
  curl -X POST http://127.0.0.1:8080/api/v1/jira-intake/poll \
    -H "x-api-key: $CI_API_KEY" -H "Content-Type: application/json" \
    -d '{"projectId":"87f0a31e-fc6b-4cbf-8334-173d6dbc17b1"}'
  ```
  Returns `{"found":1,"queued":1,"skipped":0,"errors":0,"details":[{"issueKey":"OCQ-402","outcome":"queued","executionIds":["<id>"]}]}`.

Behind the scenes (≈30–60 s): NovaTest reads the bug + the linked story, an AI
writes the test scenario, and — because the bug has a URL, steps, and an
expected result — it **queues an autonomous run**. (A vague bug would instead be
**skipped**: a comment appears on it listing what's missing, plus a
`novatest-skipped` label.)

**LOCATION to see what Intake decided (UI):** Integrations → *Jira Intake* → the
**"Issues from Jira"** side panel lists `OCQ-402 · running` (then `done`), or
`OCQ-402 · skipped`.
**(API):** `curl -H "x-api-key: $CI_API_KEY" "http://127.0.0.1:8080/api/v1/jira-intake/issues?projectId=87f0a31e-fc6b-4cbf-8334-173d6dbc17b1"`

---

## PHASE 6 — watch the run in NovaTest

**LOCATION:** left sidebar → **Command Center** (`/app/command-center`) → scroll
to **Recent Executions**. The new row shows the test name with a
**`Jira · OCQ-402`** badge next to it, and a status of *running → passed/failed*.

**Or the full list:** sidebar → **Web Testing → Executions**
(`/app/execution`). Same run, same `Jira` badge.

**Live view:** click the run → **Execution detail** (`/app/execution/<id>`).
The header shows a **"Raised in Jira · OCQ-402"** chip. While it runs you get
live telemetry; steps fill in as they execute (this takes a few minutes — the
autonomous engine explores, generates a script, executes, and self-heals
selectors).

---

## PHASE 7 — read the report in NovaTest

**LOCATION:** from the run's detail page → **"Open report"** button
(`/app/execution/<id>/report`).

Near the top, a **"Raised from Jira"** card shows:
- the issue key **OCQ-402** (raised by …)
- the bug summary
- *"This run was generated automatically from the Jira bug above and its linked user stories."*
- once posted: a **"Result posted back to Jira"** link → opens the comment.

The rest of the report is the normal one: scenarios, pass/fail, step log,
screenshots, video, self-healing events.

---

## PHASE 8 — the result on the Jira issue

**LOCATION:** back in Jira, open the **bug** (`.../browse/OCQ-402`) → scroll to
the **Comments** section (or the **Activity** tab).

A comment from the Jira account appears within a few minutes of the run
finishing:

> 🤖 **NovaTest AI ran automated checks for this bug** (triggered from this issue).
> **Result: PASSED** *(or FAILED)* — Checks passed: X of Y · Browser: chromium · Duration: …
> **What was tested:** *<the AI's plain-English restatement of the bug + expected behaviour>*
> **First failure:** *<only if it failed>*
> **Full report:** *<link back to `/app/execution/<id>/report`>*

**LOCATION of the label:** right-hand **Details** panel → **Labels** now also
shows **`novatest-tested`** (or `novatest-skipped`).

That closes the loop: **bug typed in Jira → tested by NovaTest → result and
report link back on the same Jira issue.**

---

## PHASE 9 — run it again

Once an issue carries `novatest-tested` / `novatest-skipped` the poller ignores
it. To re-run:

- **In Jira:** open the issue → Details → Labels → remove `novatest-tested`
  (and `novatest-skipped` if present). Next poll re-processes it.
- **Helper script:**
  ```bash
  cd backend-node && npx ts-node scripts/jira-intake/reset-issue.ts OCQ-402
  ```

---

## Location cheat-sheet

| Thing | Where |
|---|---|
| Create a Jira issue | Jira top nav → blue **Create** |
| A Jira issue | `https://your-company.atlassian.net/browse/OCQ-###` |
| Link issues | Issue view → **+ Add / Link** → *is related to* |
| Add label | Issue view → **Details** panel → **Labels** |
| Read the result comment | Issue view → **Comments** / **Activity** |
| Turn Intake on/off, "Check now", set fallback URL / test creds | NovaTest → **Integrations** → *Jira Intake* card (needs **TestingDemo** selected in the top bar) |
| See what Intake decided per issue | Integrations → *Jira Intake* → **"Issues from Jira"** panel |
| Watch/verify the run | **Command Center → Recent Executions** (Jira badge) |
| All runs | **Web Testing → Executions** (`/app/execution`) |
| Live run + "Raised in Jira" chip | `/app/execution/<id>` |
| Report + "Raised from Jira" card | `/app/execution/<id>/report` |
| Poll now (no login) | `POST http://127.0.0.1:8080/api/v1/jira-intake/poll` + `x-api-key` |
| Intake status (no login) | `GET .../api/v1/jira-intake/config` and `.../issues` + `x-api-key` |
