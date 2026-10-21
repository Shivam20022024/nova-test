# NovaTest gaps found while testing Masa (2026-10-13 → 2026-10-16)

Goal: any test or prompt about Masa runs correctly and the reports tell the truth.
Evidence = something observed in a run, a report, a video frame or the code. "Fixed" = changed this week.

## A. Fixed this week (all compile; verified where noted)

| # | Problem | Evidence | Fix |
|---|---|---|---|
| F1 | Pages that merely embed Turnstile were treated as "bot-blocked" | `ExecutionAgent.ts` matched the words "turnstile"/"captcha" in the HTML; logged-out batch 2/5 → 5/5 after fix | `utils/antiBotInterstitial.ts` — only a real challenge page counts |
| F2 | SPA "Loading…" splash: steps ran before the UI existed | login form took 3–10 s; step "fill email" failed | `goto` now waits for interactive content and for the splash to clear (capped 12 s + 15 s) |
| F3 | Click on an ambiguous name silently used the first match (the "Sign in" **tab**) | click "passed", login never submitted | when several elements match, prefer a `[type=submit]` control (logged as `[Ambiguous click]`) |
| F4 | Guessed selectors (`input[name="email"]`) failed on fields that only have `type=email` | 11 of 11 and 16 of 16 runs failed at that step | `utils/selectorFallback.ts` — try `type=`, label, placeholder, role on the live page (polls up to 20 s) before asking the LLM |
| F5 | A finished run saved the whole browser state (incl. the app's **login session**) for 25 min and the next runs reused it → opened already signed in → login steps failed | video of MASA-07 showed the Today screen at 25 s of a run that was meant to log in | `executionWorker.ts` now saves only `cf_clearance`-style cookies; stale Masa entry deleted from Redis |

## B. Open problems that will break Masa tests (priority order)

### P0 — wrong or dangerous results

| # | Gap | Evidence | Suggested fix |
|---|---|---|---|
| G1 | **Skipped assertions count as a pass; AI summary invents results** | MASA-07 "PASSED / APPROVED FOR PRODUCTION" with 8 of 8 checks skipped; MASA-12 summary said "My Journey title is visible" while the video showed the login page | a scenario with any skipped or unresolved assertion = FAILED/INCONCLUSIVE; build the summary only from recorded step results |
| G2 | **Dashboards count raw `COMPLETED` as passed** (Command Center "5/5 passed" when 3 failed; traceability ad-hoc ✓/✗) | recent-executions + traceability roll-up use run status, not scenario result | derive pass/fail from the scenario result everywhere |
| G3 | **No protected-action guard** | Masa has Delete my account, Reset my data, End this cycle, Mark as a loss, history Delete, Sign out everywhere, Purchase, Send my story — a vague prompt ("test the settings page") could click them | per-project deny-list of button names/regex; click/fill on a protected control is refused unless the step explicitly opts in |
| G4 | **Ambiguous elements resolve to `.first()`** | `/cycle`: 3× "Save"/"Nothing to save yet", per-entry Edit/Delete; `/calendar`: 31 buttons named 1…31; plans: many `/MO` `/YR` buttons | resolve within a container (dialog, row text, section heading); if >1 match and no disambiguation, fail with the list of candidates instead of guessing |
| G5 | **Custom dropdowns unsupported** — `select` throws unless the element is a native `<select>` | Masa uses `button[role=combobox]` for appointment type, hour/minute/AM-PM, repeat, provider role, clinic; `/settings` week-start has a native select hidden behind a custom one | add "choose option X in dropdown Y" = open the combobox, click the option by role=option/text; keep `select` for native |
| G6 | **Blocking dialog/overlay not handled** | first-visit tour "Here's where things live." appears in every fresh browser; click retries then force-clicks behind it | generic pre-step: if a visible modal with Got it / Close / Dismiss appears and the step does not target it, dismiss it (configurable per project) |
| G7 | **Same-account parallel logins** | 4 browsers (hard-coded `concurrency: 4`) + one account; recorded run ended blank after Sign in | per-project "max parallel runs" (1 for login-bound suites) or a pool of test accounts |

### P1 — missing capability

| # | Gap | Evidence | Suggested fix |
|---|---|---|---|
| G8 | Action vocabulary is only `goto, click, fill, wait, screenshot, assertText, assertVisible, assertNotVisible, select, hover` | `ScriptGenerationAgent` "VALID TYPES" | add `assertUrl`, `assertCount`, `assertEnabled/Disabled`, `assertChecked/Expanded`, `press` (Enter/Escape), `upload`, `scrollTo`, `selectCustom`, `switchTab` |
| G9 | No login reuse: every scenario logs in again (~60–90 s each; 11 scenarios ≈ 15 min) | run durations 1–4 min | project-level "login once" setup step, saving a session that is scoped to the suite and discarded afterwards (not the Redis clearance cache) |
| G10 | Credentials only via the sheet's TestData in Excel mode (UI username/password boxes are disabled), end up in logs, step text, DB and video | live password visible in step data and typed into the video | secrets store with masking (`{{secret:MASA_PASSWORD}}`), redact in logs/steps/report |
| G11 | Dynamic ids (`_r_21_`) are offered to the LLM as selectors | `/learn`, `/learn/glossary` search inputs | strip generated ids from the DOM summary; prefer role/label/placeholder |
| G12 | Time/data-dependent text | greeting, "Day N", dates, counts | script generator must use regex for such text; document in prompt guide |
| G13 | Toasts are short-lived | Masa toasts in region "Notifications" | `assertText` with short polling right after the action |
| G14 | Hidden twin inputs (switch button + hidden checkbox, radio button + hidden radio) | `/settings` | prefer the visible `role=switch/radio` element |
| G15 | Accessibility / Security options ticked but reports say "Not evaluated" in Excel mode | batch reports | run axe/security sanity or remove the checkboxes in that mode |

### P2 — report/UI accuracy

| # | Gap | Evidence |
|---|---|---|
| G16 | PASS RATE vs counts disagree (33 %, 38.46 %, 50 %, 66.67 % on 0-pass/1-fail reports); header says "Staging" while top bar says "Dev"; release/sprint names missing on some reports | multiple reports |
| G17 | Report page shows "APPROVED FOR PRODUCTION" while the run is still RUNNING with 0 steps | MASA-07 `fe1f9176` |
| G18 | Excel scenarios appear only as "ad-hoc" runs; no test-case assignment | traceability: assigned 0 |
| G19 | No preflight for the Playwright browser binary (raw error) | first run on 2026-10-13 |
| G20 | Many simultaneous failing runs flood a sprint's results (no way to mark a run as invalid/superseded) | Sprint 3–5 clutter |

## C. What NovaTest already does well on Masa
- Imports a sheet, tags runs to a release/sprint, queues, records video, produces PDF/JSON reports, traceability roll-up, Jira filing.
- Logged-out flows: 5/5 pass after F1; login proven to work in a single run (reached Today).
- Plain-English failure explanations are usually close to the real cause.

## D. Verification still pending
1. One signed-in scenario alone (MASA-07) → confirms whether G7 is concurrency or Masa-side.
2. Re-run the 11-scenario sheet after G1/G2/G7 are fixed.
