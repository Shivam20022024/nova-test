# How to file a bug in Jira and have NovaTest test it

The **Jira Intake** feature watches a Jira project for bugs carrying a trigger
label. When it finds one, an AI reads the bug **and its linked user stories**,
generates a test that reproduces the problem and verifies the correct behaviour,
runs it through the autonomous pipeline, and posts the result back as a comment
on the issue.

---

## 1. What's already set up

| Setting | Value | Where to change it |
|---|---|---|
| NovaTest project | **TestingDemo** | — |
| Watched Jira | `your-company.atlassian.net`, project **OCQ** | `JIRA_*` in `backend-node/.env` |
| Trigger label | **`novatest-run`** | Integrations → Jira Intake card |
| Fallback URL | *(none — every bug MUST contain a URL)* | Jira Intake card → "App base URL" |
| Min. AI confidence to run | **medium** | Jira Intake card |
| Result comment | **always** (pass or fail) | Jira Intake card |
| Poll interval | **every 5 minutes** | Jira Intake card |

> OCQ has no "Bug" issue type — create issues as **Task** (or Story). The
> **label** is what triggers a run, not the issue type.

---

## 2. Write the user story (create this first)

Create a Jira issue (Task or Story) for the feature the bug is about. The AI
uses it as the source of truth for *correct* behaviour.

**Summary**
```
As a shopper, I can complete a purchase on the demo store
```

**Description**
```
As a shopper, I want to add a product to my cart and check out so that I can
buy it.

Acceptance criteria:
- The product catalog shows products, each with a name and a price.
- Clicking a product opens its detail page with an "Add to cart" button.
- After adding a product and opening the cart, the product is listed by name.
- Completing the checkout form and placing the order shows an order
  confirmation ("Thank you for your purchase").
```

Notes on how to write it:
- Start with the classic **"As a … I want to … so that …"** line.
- Put a heading that literally contains **"Acceptance criteria"** (or use a Jira
  custom field named *Acceptance Criteria* / *Definition of Done*). The AI
  searches for those words.
- Each criterion should be **one observable, checkable fact** — something a
  person could look at the screen and say yes/no to. Avoid vague words like
  "works" or "is fast".

---

## 3. Write the bug (create this second)

Create the bug as a **Task**. It needs three things for the AI to run it with
confidence: **a URL, steps to reproduce, and an expected result.**

**Summary**
```
Order confirmation does not appear after placing an order
```

**Description**
```
Summary
Clicking "Purchase" on the checkout dialog does nothing — no confirmation is
shown and the order is not recorded.

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
A confirmation dialog appears with the text "Thank you for your purchase!"
and the order details.

Actual result
Nothing happens when "Purchase" is clicked. No dialog, no error.
```

Then:
1. **Link** the bug to the user story from step 2 — *Link → "relates to" → OCQ-xxx*.
2. **Add the label `novatest-run`** to the bug.

### The rules the AI follows

| It runs the test when… | It skips (and comments what's missing) when… |
|---|---|
| the description contains a real `https://` URL | there is no URL anywhere (and no fallback URL is configured) |
| there are clear numbered steps to reproduce | the steps are vague ("it's weird sometimes") |
| there is an explicit **Expected result** | there's no statement of what *should* happen |
| → AI confidence = **medium or high** | → AI confidence = **low** |

A skipped issue gets a comment listing exactly what to add, plus a
`novatest-skipped` label. Fix the description, then **remove and re-add** the
`novatest-run` label to retry (or ask NovaTest to reset it — see §7).

---

## 4. Run it

**Option A — wait.** The poller checks OCQ every 5 minutes. Add the label and
walk away.

**Option B — "Check Jira now".**
- **In the app:** log in → **Integrations** → *Jira Intake* card → **Check Jira now**.
- **Via API** (no login needed, uses the CI key):
  ```bash
  curl -X POST http://127.0.0.1:8080/api/v1/jira-intake/poll \
    -H "x-api-key: $CI_API_KEY" -H "Content-Type: application/json" \
    -d '{"projectId":"87f0a31e-fc6b-4cbf-8334-173d6dbc17b1"}'
  ```
  Response tells you what it did: `{"found":1,"queued":1,"skipped":0,...}`.

---

## 5. Where to see the result

1. **On the Jira issue** — a comment from NovaTest within a few minutes:
   > 🤖 NovaTest AI ran automated checks for this bug (triggered from this issue).
   > **Result: PASSED / FAILED** · Checks passed: X of Y · Browser: chromium · Duration: …
   > **What was tested:** <the AI's plain-English understanding of the bug>
   > **First failure:** <if it failed> · **Full report:** <link>

   …and the issue gains a **`novatest-tested`** label.

2. **In NovaTest** —
   - **Command Center → Recent Executions**: the run has a **`Jira · OCQ-xxx`** badge.
   - **Executions → open the run → report**: a **"Raised from Jira"** card shows
     the issue key, who raised it, the summary, and a link to the comment.

---

## 6. If the login flow is needed

If the bug's flow is behind a login, set the test credentials once:
Integrations → *Jira Intake* card → **Test username / Test password** → Save.
The AI will use them when the generated scenario needs to sign in.

---

## 7. Re-testing an issue

Once an issue has `novatest-tested` or `novatest-skipped`, the poller ignores
it. To run it again:

- **Manually in Jira:** remove the `novatest-tested` / `novatest-skipped` label.
- **Helper script:**
  ```bash
  cd backend-node && npx ts-node scripts/jira-intake/reset-issue.ts OCQ-381
  ```
  (removes the labels; the next poll re-processes it)

---

## 8. Turning it off

- **Per project:** Integrations → *Jira Intake* card → untick "Watch this
  project's Jira…" → Save. (Or `PUT /api/v1/jira-intake/config` with
  `{"projectId":"…","enabled":false}`.)
- **Globally:** set `JIRA_INTAKE_DISABLED=1` in `backend-node/.env` and restart.

---

## 9. Quick reference — the two templates

**User story (Task/Story):**
```
Summary:  As a <role>, I can <capability>

As a <role>, I want to <action> so that <benefit>.

Acceptance criteria:
- <observable fact 1>
- <observable fact 2>
- <observable fact 3>
```

**Bug (Task), label `novatest-run`, linked to the story:**
```
Summary:  <what is broken, in one line>

Environment
- URL: https://<the affected page>
- Browser: Chrome

Steps to reproduce
1. Open https://<url>
2. <action>
3. <action>

Expected result
<what should happen — a concrete, visible outcome>

Actual result
<what happens instead>
```
