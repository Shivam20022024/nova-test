# NovaTest AI — UI-Only Build Plan for Claude Code
**Tuesday Aug 25 → Sunday Aug 30 · Frontend/UI only, no backend**

---

## How to use this with Claude Code

- Run this inside a Claude Code session in your project repo.
- Paste **CLAUDE.md contents** below into an actual `CLAUDE.md` file at your
  repo root first. Claude Code reads this automatically every session, so
  every later prompt below can stay short — the agent already knows the
  naming rule, stack, routes, and shell.
- Each day is a list of **PROMPT** blocks. Paste them **one at a time, in
  order, in the same session**, so components already built get reused
  instead of rebuilt.
- Some prompts open with a `/skill-name` line — that's a slash-invoked
  skill you have installed. Type that as the first line of the message
  (skills that take inline arguments, like `/impeccable`, are written as
  one flowing line per that tool's own convention). The rest of the block
  is the task you give it in the same message.
- Saturday and Sunday are **audit/fix prompts, not build prompts.** Don't
  add new pages those two days.

This still targets your **22-screen scope**: 1 public landing page + the
21 product routes from your own `React-Page-Count-Analysis.md`.

---

## Your design skills, and exactly when each one fires

| Slash command | What it actually does | When it's used in this plan |
|---|---|---|
| `/frontend-design` | Picks one deliberate, non-generic aesthetic direction (palette, type pairing, motion) before writing code, then implements it. General-purpose — works for marketing pages *and* product UI. | Landing page direction (Tue T2). Reused once for the app-shell's dashboard execution (Tue T5), constrained to reuse the same tokens rather than inventing new ones. |
| `/design-taste-frontend` | An anti-slop pass built specifically for **landing pages, portfolios, and redesigns**. Bans common AI-tell patterns and runs a pre-flight checklist (contrast, button wrapping, hero fit, color consistency, motion justification, etc.). Its own docs explicitly say it is **not** for dashboards, data tables, or multi-step product UI. | Landing page only (Tue T3). Never call it on anything under `/app/*`. |
| `/canvas-design` | Generates a standalone visual art asset (PNG/PDF) from a short design-philosophy brief — good for one-off textures or abstract graphics, not page layout. | Optional, inside Tue T3: generate the landing page's grain-texture/abstract hero asset if you want a custom one instead of a CSS noise filter. |
| `/web-design-guidelines` | Fetches Vercel's Web Interface Guidelines fresh, then audits the files you point it at for accessibility/interaction/spacing compliance, reporting terse `file:line` findings. | End of Wed/Thu/Fri (quick pass on that day's new files) and again Saturday (S6) across the whole `/app/*` tree. |
| `/impeccable init` | One-time setup: captures your product brief into `PRODUCT.md` (who the users are, what mode the surface is in, brand voice, anti-references) so every later command reads it instead of guessing. | Once, Tuesday, before any design work (T1). |
| `/impeccable document` | Snapshots the visual system you actually built — colors, gradient, type, spacing, component radii/shadows — into `DESIGN.md`. This becomes the single source of truth. | Immediately after the landing page is finished (Tue T4). |
| `/impeccable colorize` | Finds and fixes color/gradient inconsistency against `DESIGN.md`. | Sunday (SU2) — this is the direct fix for "internal pages must match the landing page's color/gradient." |
| `/impeccable typeset` | Finds and fixes typography-hierarchy inconsistency against `DESIGN.md`. | Sunday (SU3). |
| `/impeccable polish` | A final overall quality pass that respects the existing design system rather than overwriting it. | Sunday (SU4), run across `/app/*`. |
| `/impeccable audit` | A production-readiness gate checked against `DESIGN.md`/`PRODUCT.md`. | End of Friday (breadth-complete checkpoint, S7-equivalent) and again Sunday as the final ship gate (SU6). |

---

## How this plan keeps 22 screens visually consistent

The mechanism is simple: **the landing page is built first and becomes
canon.** `/impeccable document` freezes what got built into `DESIGN.md`
(colors, gradient direction, type pairing, radius/shadow scale). Every
prompt from Tuesday afternoon onward opens by telling the agent to reuse
those tokens, never invent new ones. Saturday and Sunday close the loop
with `/web-design-guidelines` and `/impeccable colorize`/`audit`, which
catch drift automatically instead of relying on you eyeballing 21 pages.

One nuance worth stating up front: the product app (`/app/*`) should
**not** literally repaint every dashboard page with the marketing hero's
full-bleed gradient — that would hurt readability on a dense data screen.
Instead it should feel like the same brand in work clothes: same accent
color(s), same serif/mono type pairing logic, same corner-radius and
shadow language, same status-color system — with the gradient itself
reserved for specific accents (topbar wash, primary buttons, the
Command Center confidence ring, empty-state banners) rather than page
backgrounds. This distinction is written into the brief below so the
agent doesn't over- or under-apply it.

---

## CLAUDE.md — paste this once, at your repo root, before anything else

```text
PROJECT: NovaTest AI

ONE-LINE: NovaTest AI is an AI-native autonomous QA platform — a "quality
command center" that turns requirements, application understanding, and
code changes into evidence-backed test coverage automatically: understand
→ design → automate → execute → observe → diagnose → heal → prove →
decide → learn.

SCOPE FOR THIS BUILD: Frontend / UI ONLY.
- No backend, no real API integration, no database, no real auth.
- All data comes from local mock data (TypeScript files) in src/mock/.
- Actions (Run Test, Approve Healing, Create Defect, etc.) may update
  local/in-memory state so the UI feels alive, but nothing persists to a
  server and nothing is ever actually sent anywhere.
- Simulate loading/success/error/approval states with setTimeout or a
  fake-delay helper, never a real network call.

NAMING — CRITICAL, NEVER BREAK THIS:
- The product is called "NovaTest AI" everywhere: nav logo, browser tab
  title, page titles, footer, empty states, onboarding copy, sample
  emails, everything.
- NEVER write "OneClickQA" or "OneClick QA" anywhere — not in code,
  comments, copy, filenames, component names, or commit messages.
- Sub-feature/module names stay as their own sub-brands, unchanged:
  AppGraph™, TestIntent™, FailureIQ™, AutoHeal™, RiskRun™,
  EvidenceGraph™. The in-app AI assistant is called "NovaTest Copilot".

TECH STACK:
React 18 + TypeScript + Vite, React Router v6, Tailwind CSS,
lucide-react (icons), recharts (charts). No heavy UI kit — build a small
internal design system in src/components/ui/.

DESIGN SYSTEM SOURCE OF TRUTH:
Once the landing page is built, `DESIGN.md` and `PRODUCT.md` exist at the
repo root (written by the /impeccable skill). Every page built after that
point MUST read and reuse the tokens in DESIGN.md — accent color(s),
gradient direction, type pairing, radius scale, shadow scale, status
colors. Do not introduce a new palette or gradient anywhere in the app.
The product app under /app/* adapts these tokens into a dense "quality
command center" mode: the full-bleed hero gradient from the marketing
page is NOT reused as a dashboard background; instead it shows up only as
targeted accents (topbar wash, primary buttons, the Command Center
confidence ring, empty-state banners). Sidebar/table/card chrome stays
neutral and readable, colored only via the shared status-color system
(pass=green, fail=red, running=blue, flaky=amber, healing=purple,
blocked=gray) and the one brand accent.

TWO VISUAL MODES SHARING ONE TOKEN SET:
1. Marketing site (route "/" only, no app shell): editorial SaaS style —
   large serif display headlines, monospace labels/buttons, warm neutral
   background, one confident accent color used in a hero gradient,
   generous whitespace, floating rounded-corner product-preview cards
   with soft shadow, subtle grain texture on section breaks, duotone
   photography.
2. Product app (everything under "/app/*"): a clean, dense dashboard
   built from the SAME tokens — sidebar + topbar shell, data-dense
   tables, status-color-coded badges, monospace for IDs/metrics,
   sans-serif for UI chrome.

CORE DESIGN SYSTEM (build once Tuesday, reuse everywhere after):
Button, Input, Select, Dropdown, Modal, Drawer, Tabs, Badge, StatusBadge,
ConfidenceBadge, Card, Table/DataTable, Pagination, SearchBar, FilterBar,
Tooltip, ProgressBar, Skeleton, EmptyState, ErrorState, ApprovalBanner,
PageHeader, DetailLayout, AIPanel.

ROUTES (build in this order across the week):
/                              marketing landing page (public, no shell)
/app/command-center
/app/one-click-test
/app/requirements
/app/application
/app/tests                     (tabs/params for web|api|database|mobile|
                                 performance|security|accessibility —
                                 ONE reusable workspace, not 7 pages)
/app/tests/design               TestIntent / AI test design
/app/data                       test data management
/app/execution
/app/execution/:id
/app/failures                   FailureIQ
/app/healing                    AutoHeal
/app/regression                 RiskRun
/app/evidence                   EvidenceGraph explorer
/app/defects
/app/defects/:id
/app/reports                    tabs: overview/test/defects/coverage/
                                 flaky/trends
/app/reports/release-readiness
/app/integrations
/app/governance
/app/settings
NovaTest Copilot = a global slide-in drawer available from every
/app/* page, NOT its own route.

GLOBAL APP SHELL (Tuesday, shared by everything under /app/*):
Topbar: logo, project selector, environment selector, global search,
notifications bell, help, avatar/profile.
Left sidebar, grouped:
  COMMAND CENTER
  CREATE — One-Click Test, NovaTest Copilot
  QUALITY — Requirements, Application, Tests, Executions, Failures,
            AutoHeal, RiskRun, Evidence, Defects
  INTELLIGENCE — Reports, Release Readiness
  PLATFORM — Integrations, Governance, Settings
Context header under topbar: current project / environment / release /
health status. Disabled controls must show *why* (permission tooltip),
never fail silently.

HARD RULES:
- Do NOT build 7 separate top-level pages for each testing type. Build
  ONE reusable "Testing Workspace" that reconfigures its fields by type.
- Do NOT build Reports as 9 separate routes. ONE /app/reports page with
  tabs.
- Do NOT build the Copilot as a full page — it's a drawer, everywhere.
- Do NOT wire up real fetches, sockets, or persistence. Mock everything.
- Do NOT invoke /design-taste-frontend on anything under /app/* — that
  skill is landing-page/portfolio only per its own docs.
- Reuse components aggressively: DataTable powers Requirements, Tests,
  Executions, Failures, Healing, Defects, Integrations. DetailLayout
  powers Requirement/Execution/Failure/Defect/Evidence detail views.
  StatusBadge and ConfidenceBadge appear everywhere AI/execution state
  is shown.
```

---

## Landing page — content & structure brief

Your reference video is a scroll-through of a sustainability SaaS site.
Below is that same section-by-section structure, rewritten with NovaTest
AI content — use this as the literal content source for Tuesday's landing
page prompts so the agent isn't guessing at copy.

**Section order (top to bottom):**

1. **Nav** — Logo "NovaTest AI" · links: Product, Journal, About, Careers
   · right-aligned button "Get started →"
2. **Hero** — big serif headline over two lines: *"Autonomous QA, built
   for engineering teams."* Subtext: *"Understand your app, generate
   tests, execute at scale, and heal failures automatically — with
   evidence behind every release decision."* Two buttons: dark solid
   "Request a demo", dark outline "Explore the platform".
3. **Floating product-preview card** (rounded corners, soft shadow, sits
   half-overlapping the hero) — mimics the real Command Center:
   greeting *"Good morning, Acme Commerce"* / *"Your release confidence
   is ready to review."* Three metric tiles: `1,420 tests passed · 98%`,
   `Avg run time · 4m 12s ↓12.4%`, a highlighted tile `Release confidence
   92/100 — High Confidence`. Below the tiles, a bar chart labeled
   **"Test executions trend"** (Feb–Jun, trending up then down).
4. **Section heading** — *"Everything you need to test, heal, and ship
   with confidence."*
5. **Numbered feature list (001–004)** beside an image:
   - `001 Understand` — Requirements, application objects, and workflows
     across your product
   - `002 Generate` — AI designs test scenarios and TestIntent
     automatically
   - `003 Execute` — Run tests at scale with self-healing automation
   - `004 Prove` — Evidence-backed release decisions, every time
   Button: "Explore features".
6. **"Built for confidence / Designed for speed"** — three cards on a
   textured neutral background, each with an icon:
   - *Evidence drives decisions* — "We believe better releases start
     with better evidence — captured, traceable, and trusted."
   - *Quality is a systems problem* — "We build tools that connect
     requirements, tests, execution, and defects into one closed loop."
   - *Progress over perfection* — "We support real engineering
     velocity — helping teams ship from intention to verified quality."
7. **Case study** — image + text block: *"Why Acme Commerce chose
   NovaTest AI"* — "With fragmented test suites and slow manual QA,
   Acme turned to NovaTest AI to automate their regression workflow.
   The result? Faster releases, fewer flaky tests, and 34% more
   coverage." Button "Read case study".
8. **"From the NovaTest journal"** — three article cards + "View all
   articles":
   - *How to Build a Self-Healing Test Suite* — Insights · 4 min
   - *Quality Isn't a Side Project: Making QA Operational* — Strategy ·
     7 min
   - *Inside the NovaTest Model: How We Turn Failures Into Fixes* —
     Insights · 5 min
9. **Testimonial** — large pull-quote over a duotone photo: *"We finally
   moved past flaky scripts and manual triage. Now we have real
   evidence to guide every release."* — attribution name + "Head of QA,
   [Company]".
10. **Footer** — huge wordmark **"NovaTest AI"** filling the width on a
    bold accent-colored, subtly textured background, standard footer
    link columns above it (Product, Journal, About, Careers, Legal,
    Social).

**Structural requirements to carry over from the reference video** (let
`/frontend-design` pick the exact hues/gradient — don't hardcode colors
yourself): a soft gradient behind the hero, a warm off-white base with a
faint grain/paper texture on section breaks, exactly one confident accent
color used sparingly and deliberately, a serif display face paired with a
monospace face for buttons/labels/data, duotone (two-tone) treatment on
any people photography, rounded-corner floating cards with soft shadow
for anything showing "the product," and a bold, textured, single-color
background for the closing wordmark footer.

---

# 🔵 TUESDAY — Foundation, Landing Page, Shell, Command Center

### PROMPT T1 — Project scaffold + Impeccable init

```text
Scaffold the NovaTest AI frontend per CLAUDE.md.

1. Init a Vite + React + TypeScript project. Install and configure
   Tailwind, react-router-dom v6, lucide-react, recharts.
2. Create this folder structure:
   src/app/ (router.tsx, providers.tsx)
   src/layouts/ (MarketingLayout.tsx, AppLayout.tsx)
   src/components/ui/ (design system primitives)
   src/components/navigation/
   src/components/tables/
   src/components/forms/
   src/components/charts/
   src/components/ai/
   src/pages/marketing/
   src/pages/app/<one folder per route from CLAUDE.md>
   src/mock/
   src/utils/
3. Do not build any product page yet — just get it compiling with an
   empty routed shell.

/impeccable init

Product: NovaTest AI, an AI-native autonomous QA platform.
Users: QA engineers, SDETs, release managers, and developers
investigating test failures — reading fast, often mid-incident or
mid-release, on the product side; on the marketing side, engineering
leaders evaluating whether to adopt it.
Mode: the marketing site (route "/") is Persuade — it needs to make a
sharp, confident case. Everything under /app/* is Operate — it needs to
help someone do a task fast, not sell them anything.
Brand voice: confident, precise, evidence-driven. No hype, no vague
claims — every statement should sound backed by data.
Anti-references: purple gradients, glassmorphism, generic AI beige,
italic-serif "beautifully crafted for modern teams" style headlines,
side-tab AI chat bubbles, three-equal-icon-tile feature rows used as
filler, pulsing-dot "AI is thinking" indicators.
```

### PROMPT T2 — Landing page: aesthetic direction + build

```text
/frontend-design

Build the public marketing landing page for NovaTest AI at route "/",
using MarketingLayout, following the "Landing page — content &
structure brief" from CLAUDE.md exactly: nav, hero + floating
product-preview card, section heading, numbered 001-004 feature list,
three-card "Built for confidence / Designed for speed" section, case
study block, "From the NovaTest journal" three-card grid, testimonial,
and the big-wordmark footer.

Requirements:
- Use the exact copy given in the brief for every section. Don't
  replace it with generic placeholder text.
- The floating product-preview card's bar chart is real recharts data
  (mock monthly numbers trending up then down, Feb-Jun) — build this as
  its own reusable chart component, you'll reuse it in Command Center
  tomorrow.
- Pick and commit to one deliberate aesthetic direction per the
  structural requirements in the brief — a soft hero gradient, warm
  neutral base with grain texture, one confident accent color, serif +
  monospace type pairing, duotone photography, floating shadowed
  cards. State the direction you chose and why, briefly, before you
  build.
- Every button/link routes somewhere sensible: "Get started", "Request
  a demo", "Explore the platform" all go to /app/command-center (no
  real auth in this build). "Read case study" / "View all articles"
  can open a lightweight modal or placeholder route.
- Fully responsive to mobile; nav collapses below ~768px.
- This page must NOT use the app shell — it's standalone and public.
- No "OneClickQA" anywhere.
```

### PROMPT T3 — Landing page: anti-slop refinement pass

```text
/design-taste-frontend

Refine the landing page you just built at route "/". Read the brief's
intent (SaaS, editorial/premium-consumer adjacent, not generic AI
default) and apply the anti-slop dials and pre-flight checklist
(contrast, button wrapping, hero fit, color consistency, motion
justification).

One deliberate exception: the "Built for confidence / Designed for
speed" section is INTENTIONALLY a three-equal-card layout because it's
recreating a specific reference design, not defaulting to a template —
keep it, but make sure it doesn't feel like filler by tightening the
copy and icon treatment so each card earns its place. Apply your other
anti-slop rules everywhere else on the page.
```

### PROMPT T4 — Lock the design system

```text
/impeccable document

Write DESIGN.md from the landing page you just finished. This is now
the single source of truth for color (including the hero gradient),
typography pairing, spacing, and component radius/shadow tokens for
the rest of the app. Confirm back to me what got captured before we
move on to the product app.
```

### PROMPT T5 — Global authenticated app shell + full route skeleton

```text
/frontend-design

Build AppLayout (topbar + left sidebar + content area) for everything
under /app/*, reusing the tokens in DESIGN.md — do not introduce a new
palette. This is the "Operate" mode from PRODUCT.md: a clean, dense
quality command center, not a repaint of the marketing hero. Reserve
the brand gradient for targeted accents only (topbar wash, primary
buttons) — sidebar/content chrome stays neutral and readable.

Wire up React Router with EVERY route from CLAUDE.md's ROUTES list,
each currently a placeholder page ("<PageName> — coming this week" +
PageHeader), so the whole product is navigable today.

Topbar: NovaTest AI logo (links to /app/command-center), project
selector (mock: "Acme Commerce", "Acme Payments"), environment
selector (Dev/QA/Staging/Production), global SearchBar (visual only),
notification bell with mock unread badge, help icon, profile avatar
menu (mock user + non-functional "Sign out").

Sidebar: grouped exactly per CLAUDE.md, collapsible, active-route
highlighting, lucide-react icons throughout.

Context header: a slim bar under the topbar on every /app/* page —
project · environment · release/build id · health status dot. Build
this as one shared component every page can drop in.

Stub the global NovaTest Copilot: a floating button (bottom-right)
opening a Drawer with a chat-style UI (input + suggested prompts:
"What failed?", "Generate tests", "Show coverage", "Explain risk",
"Check release"). No real AI logic yet — echo a canned response after
a fake delay. Mount it once in AppLayout so it's on every /app/* page.

Definition of done: every sidebar item navigates without a 404, blank
page, or console error. Shell, context header, and Copilot button
persist across navigation and visually feel like the same brand as the
landing page, just in a denser, work mode.
```

### PROMPT T6 — Command Center (first real product page)

```text
Build the real /app/command-center page, replacing its placeholder.
Reuse DataTable, StatusBadge, ConfidenceBadge, Card, ProgressBar, and
the chart component from the landing page. Reuse DESIGN.md tokens —
this is where the confidence-ring / accent gradient from the landing
page is a great fit for a targeted accent (e.g. the release-confidence
ring), not for the page background.

Layout, top to bottom:
1. Page header: "Command Center" + project/release context + a
   primary "Run Regression" button.
2. Release Confidence: a large circular/radial score (mock: 92/100,
   "High Confidence").
3. "Why this score" stat tiles: Coverage 96%, Critical 100%, Blockers
   0, High 2, Evidence 98%.
4. "Attention required" list: 2-3 mock alerts with actions, e.g.
   "Payment API regression detected" → [Investigate], "3 unstable
   tests" → [Review], "7 requirements lack coverage" → [Analyze].
5. "Quality flow" — a horizontal stepper: Requirement → Test →
   Execution → Evidence → Defect → Release, each annotated with a
   mock percentage (96%, 94%, 98%, 96%, 92%, 92%).
6. "Recent executions" — a small DataTable: Run ID, Suite,
   Environment, Pass, Fail, Flaky, Risk, Status (StatusBadge).
7. "AI insights" panel (build the AIPanel component now — you'll reuse
   it on FailureIQ/AutoHeal/Evidence/Requirements/Copilot later): a
   short list of AI-generated one-line insights, e.g. "FailureIQ:
   Checkout failures increased 18% this week.", "RiskRun: 128 tests
   recommended for the current release.", "AutoHeal: 4 automation
   repairs are awaiting approval." Each line visually marked as
   AI-generated (small sparkle/AI icon).

All numbers come from a single mock/commandCenter.ts file, not
hardcoded inline, so later pages reference the same mock project data
consistently.
```

**End of Tuesday, you should have:** Landing page ✅ · `DESIGN.md`
locked ✅ · App shell + all routes reachable ✅ · Command Center fully
built ✅ · Copilot drawer stubbed ✅

---

# 🟢 WEDNESDAY — Understand + Design

Every prompt below opens with the same rule, stated once here instead of
repeated five times: **reuse the tokens in DESIGN.md — same accent
color, type pairing, radius, and shadow scale as the landing page,
applied in the dense dashboard mode from Tuesday. Don't invent new
colors.**

### PROMPT W1 — Requirements

```text
Build /app/requirements. Layout:
- Left panel: a requirement tree, Epic → Feature → Story → Acceptance
  Criteria, collapsible, with search/filter at the top. Selecting a
  story loads it into the center panel.
- Center: story header (key, title, status badge, priority, release,
  owner), description, acceptance criteria list, business rules,
  dependencies. Controlled inputs, update local state on edit.
- Right panel: "AI quality score" (ConfidenceBadge), ambiguity
  warnings (mock: "Missing negative path for invalid email"), linked
  tests count, linked defects count, coverage summary
  (tested/partially/untested).
- Bottom: tabs for Versions, Traceability, Activity, Comments,
  Evidence — simple mock lists/timelines.
- Empty state (EmptyState component) when nothing is selected.
- "New Requirement" button → Modal with: external key, title,
  description, actor, business value, priority, epic/feature,
  sprint/release, acceptance criteria, dependencies, tags. Submitting
  adds it to the mock tree.
Use 6-8 mock requirements across 2-3 epics.
```

### PROMPT W2 — Application / AppGraph

```text
Build /app/application. Two views:

View 1 "Applications": DataTable of registered applications (name,
environment, last discovery date, page count, object count, status),
with "Register Application" button.

View 2 "Discover" — a step flow: Application URL → Environment select
→ Credential reference select (mock list, never a real password field)
→ Crawl scope/exclusions → Browser select → "Start Discovery" →
progress state (indeterminate bar + live-looking log lines appearing
via setTimeout) → results: summary (pages/objects/workflows found) +
a tree or card grid of discovered pages, each expandable to a few mock
objects (component_type, label, locator string). End with "Approve
AppGraph Version".

StatusBadge for application status (Healthy/Stale/Discovering/Error).
```

### PROMPT W3 — Test Explorer

```text
Build /app/tests as the reusable Testing Workspace — your biggest,
most reused page.

Left: folder/suite tree (Regression, Smoke, Critical, custom folders).
Center: DataTable of test cases — ID, Name, Type, Priority,
Requirement link, Automation status (StatusBadge), Owner, Last run
(StatusBadge), Tags. SearchBar + FilterBar (type, status, owner,
automation status).
Right: selecting a test case opens its detail — objective,
preconditions, steps, expected result, test data ref, environment,
requirement links, TestIntent link, automation status, version,
approval state.

Add a testing-type switcher (tabs/select): Web, API, Database, Mobile,
Performance, Security, Accessibility, Visual, Exploratory. Switching
reconfigures relevant mock columns/fields (API shows endpoint/method,
Database shows connection/query, Performance shows load-model) — it
does NOT navigate to a new route. This is the reusable-workspace
pattern from CLAUDE.md; do not create separate pages per type.

Top-level actions: Generate (AI icon), Create Test, Run.
```

### PROMPT W4 — Test Design / TestIntent

```text
Build /app/tests/design, the AI test-generation review flow:

1. Picker: select a requirement (from Requirements mock data).
2. "Generate" → fake AI delay ("Analyzing requirement and
   AppGraph...") → 3-5 generated scenario cards (positive/negative/
   boundary/validation), each with title, short description, coverage
   tag.
3. Selecting a scenario opens its TestIntent detail rendered as a
   readable step list (not raw JSON): objective, actors,
   preconditions, ordered steps (action/target/value), expected
   outcomes, data refs, requirement refs, ConfidenceBadge (0.80-0.99).
4. Approve / Reject / Edit per scenario. Approving marks it "Active"
   and (in mock state) adds it to Test Explorer's list so the two
   pages feel connected.
5. A simple "before you approve" summary card is enough — no full diff
   view needed.

Reuse AIPanel/ConfidenceBadge. Use realistic QA copy (e.g. "Verify
successful customer onboarding with valid email", "Reject onboarding
with duplicate customer"), not lorem ipsum.
```

### PROMPT W5 — One-Click Test

```text
Build /app/one-click-test:

Large centered card: "What would you like to test?" with a big
textarea (placeholder: "Test customer onboarding. Cover successful
registration, invalid email, duplicate customer, and password
validation."), Upload and "+ Add context" buttons (visual only).

Input-source toggle chips below: Natural Language / User Story /
Requirement / URL / API Spec (one active at a time, changes a hint
line).

Form section: Target (Application + Environment selects), Test Scope
(chips: Smart/Smoke/Regression/Full), AI Mode (radio:
Assisted/Autonomous), Evidence (radio: Standard/Diagnostic).

Primary "Start Test" button.

On click, transition to a run view showing an autonomous pipeline
checklist filling in over time: Understand ✓ → Discover ✓ → Generate
✓ → TestIntent ✓ → Execute (● in progress, "31/42 tests running") →
Diagnose (○) → Prove (○) → Decide (○), plus live results tiles
(Passed/Failed/Running/Flaky ticking up) and View Execution / Stop Run
buttons. Keep these exact step names — they're the product's core
lifecycle framing.
```

### PROMPT W6 — End-of-day audit

```text
/web-design-guidelines

Audit everything built today: src/pages/app/requirements,
src/pages/app/application, src/pages/app/tests,
src/pages/app/tests/design, src/pages/app/one-click-test, and any
shared components they introduced. Fix what it finds.
```

**End of Wednesday, you should have 6 pages fully built:** Command
Center, One-Click Test, Requirements, Application/AppGraph, Test
Explorer, Test Design/TestIntent — plus the landing page and shell.

---

# 🟠 THURSDAY — Data + Execution + AI Failure Loop

Same reminder as Wednesday: reuse DESIGN.md tokens, dense dashboard mode,
no new colors.

### PROMPT TH1 — Test Data

```text
Build /app/data. DataTable of datasets/data pools — Name, Data class
(Valid/Invalid/Boundary/Null-Empty/Duplicate/Security/PII-like —
colored chip per class), Linked test count, Environment, Version, Last
updated. Filter by data class and environment.

"Generate Data" button → modal: pick a TestIntent/test, toggle data
classes to generate (each with a one-line description, e.g.
"Boundary — min/max length, numeric min/max, date edges"), a
masking/PII toggle, "Generate" (fake delay → adds mock rows).

Selecting a dataset row opens a detail panel with a small sample table
of generated values (5-10 mock rows realistic to the class, e.g.
malformed emails for "Invalid").
```

### PROMPT TH2 — Execution

```text
Build /app/execution as a live-feeling operations screen.

Top: summary tiles — Queued, Running, Passed, Failed, Cancelled.
Middle: "Run Tests" button → config modal — Test/Suite/Plan picker,
Environment, Adapter (Playwright/Selenium/API), Browser matrix
(multi-select chips: Chromium/Firefox/WebKit), Priority, Concurrency,
Retry policy, Evidence policy (Standard/Diagnostic), Healing policy
toggle, Quality gate toggle. Submitting adds a queue row, shows
"Running" with a progress bar, then flips to Passed/Failed after a
delay — randomize a couple to Failed so downstream pages have data.
Below: DataTable of executions — Run ID, Suite, Environment, Browser,
Worker, Duration, Status (StatusBadge), row click → /app/execution/:id.
```

### PROMPT TH3 — Execution Detail

```text
Build /app/execution/:id using DetailLayout (build it now if not
already built — a shared header + tabbed/sectioned body reused for
Requirement/Failure/Defect/Evidence detail too).

Header: Run ID, status, duration, environment, browser, build number.
Steps list: ordered, pass/fail/pending icon + name + duration; failed
steps expand inline with a short error message.
Tabs: Logs (mock console lines), Screenshots (placeholder gallery),
Video (placeholder player frame), DOM snapshot (collapsed code block),
Network (small request/response table), Console, Artifacts
(download-style list). If a step failed, show a "Failure detected"
banner linking to /app/failures with that failure highlighted.
```

### PROMPT TH4 — FailureIQ

```text
Build /app/failures.

Top: failure-clusters visual (nested cards or a small tree — no graph
library required) grouping mock failures by classification, e.g.
"12 failures" → "7 Payment API (HTTP 500)", "3 Locator changed",
"2 Environment".

Below: split view. Left: list of individual failures. Right "Failure
detail": Classification (LOCATOR_FAILURE / APPLICATION_DEFECT),
ConfidenceBadge (e.g. 96%), root-cause summary, recommended action
badge (AUTO_HEAL / CREATE_DEFECT / HUMAN_REVIEW), affected tests
count, an "Evidence" mini-panel (screenshot thumbnail, console line,
network line, DOM note). Buttons: Investigate, Create Defect, Retry.

Use realistic root-cause sentences ("Payment API returned HTTP 500
after coupon validation.", "The original selector no longer
resolves."). "Create Defect" should prefill and open the Defect create
flow you'll build Friday (a TODO comment linking them is fine until
then).
```

### PROMPT TH5 — AutoHeal

```text
Build /app/healing.

Top: summary tiles — Healthy, Attention, Autohealed, Approval
(pending), Critical.
Below: "Healing queue" list. Each item: test name, Before/After
locator comparison (two code-styled boxes, e.g. "#submit-button" →
'role=button[name="Submit"]'), confidence percentage, one-line reason
("Original locator no longer exists."), signal source tags (DOM,
Accessibility, Semantic, Historical), validation result ("✓ Passed"
after a simulated re-run), and actions that change by confidence tier:
  - >95%: "Auto-Applied" state (+ "Undo")
  - 80-95%: Approve / Reject / Compare / Rollback buttons
  - <80%: "Needs human review", no auto actions
Approving/rejecting updates state locally and moves the item out of
the pending count. Keep the three tiers visually distinct
(green/amber/gray) — this confidence policy is a core product rule.
```

### PROMPT TH6 — End-of-day audit

```text
/web-design-guidelines

Audit everything built today: src/pages/app/data, .../execution,
.../execution/[id], .../failures, .../healing, and any shared
components they introduced. Fix what it finds.
```

**End of Thursday, you should have:** Test Data, Execution, Execution
Detail, FailureIQ, AutoHeal — plus Wednesday's six. The core loop is now
visually complete and cross-linked.

---

# 🔴 FRIDAY — Risk, Evidence, Defects, Reporting, Admin, Copilot

Same reminder: reuse DESIGN.md tokens throughout. This is the biggest
day — get breadth first, don't polish.

### PROMPT F1 — RiskRun / Regression

```text
Build /app/regression.

Top: source selector chips — PR #, Commit SHA, Release (mock: "PR
#842", "Commit a83f12", "Release v4.8.0").
Impact analysis: a left-to-right flow of cards — Changed Components
(e.g. Checkout, Payment) → Impacted Requirements (mock IDs) →
Impacted Workflows (e.g. "Customer Checkout", "Coupon Flow") →
Candidate Tests (count, e.g. 128) → Risk score (number/100 +
Low/Medium/High label).
Below: "Recommendation" row — Recommended Tests, Safe to Skip,
Critical Tests, Estimated Runtime — plus a primary "Run Intelligent
Regression" button routing to /app/execution with a prefilled mock
config.
```

### PROMPT F2 — Evidence Explorer

```text
Build /app/evidence — the most visually impressive screen.

Layout:
- A horizontal traceability chain at the top: Requirement →
  Acceptance Criterion → Test → TestIntent → Execution →
  (Evidence | Failure) → Defect → Release, rendered as connected
  nodes (simple boxes + connecting lines, no graph library needed).
  Clicking a node selects it.
- Below, three panels: Evidence Graph/Timeline (vertical timestamped
  event list for the selected chain), Artifact Viewer (tabbed:
  Screenshot/Video/DOM/Network/Console/API/DB), AI Analysis panel
  (classification, confidence, rationale, evidence refs — reuse
  AIPanel).
- A bottom "Selected node" summary bar (e.g. "BUG-1842 · Severity:
  High · Root Cause: Payment API · Evidence: 4 · Release Impact:
  High").
Keep it visually consistent with Thursday's Execution Detail via
DetailLayout patterns.
```

### PROMPT F3 — Defects (list + detail)

```text
Build /app/defects and /app/defects/:id.

List: DataTable — ID, Title, Severity (StatusBadge), Priority, Status,
Source (Manual/Automated/AI-suggested/Exploratory/etc.), Environment,
Assignee, Created date. FilterBar for severity/priority/status/
source/environment/release/assignee. "Create Defect" → multi-section
form modal: Identity (title, component), Classification (type,
source, suspected cause), Severity/Priority, Status, Environment/
Build, Requirement/Test links, Steps to reproduce, Expected vs Actual,
Reproducibility, Evidence attachments (mock upload), an "AI suggested
severity/priority" hint chip, and a "check for duplicates" mock step
showing 1-2 similar existing defects before confirming creation.

Detail (DetailLayout): header (ID/title/status/severity/priority);
sections for Description, Steps/Expected/Actual, Environment & Build,
Requirement & Test links, Evidence (reuse the artifact-viewer
pattern), AI Analysis, Assignment, Relations
(duplicate/blocker/related), External sync (mock "Synced to Jira ·
QA-482" badge), Audit/history timeline at the bottom.
```

### PROMPT F4 — Reports + Release Readiness

```text
Build /app/reports with tabs: Overview, Test, Defects, Coverage,
Flaky, Trends — ONE route, not six.

Overview: grid of summary cards + 2-3 recharts (pass rate over time,
defect severity breakdown, coverage by module). Other tabs: one chart
+ one supporting DataTable each — lighter than Overview but each must
render something real.
Include a "Custom Report Builder" (modal: metrics checkboxes, date
range, visual-only "Export") and an Export menu
(PDF/XLS/CSV/JSON, non-functional).

Then /app/reports/release-readiness: a large 0-100 score with GO /
GO WITH RISK / NO-GO / INCONCLUSIVE as a prominent color-coded status,
a checklist of contributing factors (Critical requirement coverage,
Critical test completion, Critical/high defects, Flaky-test policy,
Environment health, Evidence completeness) each pass/warn/fail, and a
"Request Approval" button opening an ApprovalBanner-style
confirmation.
```

### PROMPT F5 — Integrations + Governance + Settings

```text
Build three simpler screens — don't overbuild any of them today.

/app/integrations: card grid, one per integration (Jira, Azure DevOps,
TestRail, GitHub, GitLab, Jenkins, Slack, Teams, Webhooks, AWS, Azure,
GCP, BrowserStack), each showing Connected/Disconnected +
Configure/Test Connection/Sync actions (mock only).

/app/governance: tabbed — Users, Teams, Roles & Permissions,
Approvals, Audit Logs, Activity, AI Policy. Users/Teams/Audit/Activity
= simple DataTables. Roles & Permissions = a matrix table (roles as
columns, permissions as rows, checkmarks). AI Policy = a few toggles
(e.g. "Allow autonomous healing above 95% confidence", "Require
approval for external defect creation").

/app/settings: left sub-nav — Project, Environment, Execution,
Notifications, AI, Policies, Appearance, API Keys — each a basic form
with relevant mock fields + Save button.
```

### PROMPT F6 — NovaTest Copilot (finish it)

```text
Upgrade the Copilot drawer stubbed Tuesday into something that feels
real, no actual AI backend.

Support these intents via simple keyword matching on the typed input
(or cycle canned responses if simpler): Investigate ("what failed"),
Query ("show coverage" / "show risky tests"), Generate ("create
tests"), Execute ("run regression"), Heal ("check healing queue"),
Evidence ("show evidence for X"), Release ("check release
readiness"), Explain ("explain this risk score"), Navigate ("open
defects" → actually routes there).

Each response renders as a small structured card in the chat thread
(not plain text) — e.g. a failures response shows a mini failure card
linking to /app/failures; a release-readiness response shows the
GO/NO-GO badge linking to /app/reports/release-readiness. Keep
suggested-prompt chips visible when input is empty.
```

### PROMPT F7 — End-of-day breadth-complete gate

```text
/impeccable audit

Run a production-readiness audit across the whole /app/* tree against
DESIGN.md and PRODUCT.md. We're not polishing yet — just flag anything
that's badly broken or off-brand so we know what Saturday/Sunday need
to cover. List findings, don't fix everything now.
```

**Friday night target — every one of these should exist and be
reachable from the sidebar without a 404 or blank page:** Command
Center, One-Click Test, Requirements, Application, Tests, Test Design,
Data, Execution, Execution Detail, FailureIQ, AutoHeal, Regression,
Evidence, Defects, Defect Detail, Reports, Release Readiness,
Integrations, Governance, Settings, Copilot drawer — **21 product
screens + the landing page.**

---

# 🟣 SATURDAY — Testing & Debugging (no new pages)

Saturday is not a build day. These are audit prompts for the same
Claude Code session to check and fix what already exists.

### PROMPT S1 — Routing & navigation audit

```text
Audit the whole app: visit every route in CLAUDE.md plus every
internal Link/navigate() call in the codebase. Report and fix: any
404, blank page, console error/warning, broken redirect, or dead
sidebar item. Confirm "/" never renders the app shell, and every
/app/* route always renders inside AppLayout with the correct sidebar
item highlighted active.
```

### PROMPT S2 — Main journey & mock-data wiring audit

```text
Walk through this journey and fix any place it breaks or feels
disconnected: One-Click Test → (creates a) Requirement → Test
Generation/TestIntent → Test Data → Execution → FailureIQ → AutoHeal
→ Evidence → Defect → Regression → Release Readiness. Check: does
data created/approved on one page show up as linked downstream (even
via shared mock state)? Fix any place two pages reference the same
entity but show inconsistent mock details — consolidate into shared
fixtures in src/mock/ instead of duplicated inline data.
```

### PROMPT S3 — UI states audit

```text
For every major page, verify these states exist and look intentional:
Loading (skeleton, not a blank flash), Empty (icon + message + a clear
next action, never a bare "No data"), Success, Partial (some sub-items
succeeded, some failed — shown distinctly), Validation error (inline,
field-level), System error (message + retry action), Permission
denied (explain what's required, don't just disable silently),
Approval required (pause + show exactly what's being approved). Fix
any missing state or blank screen.
```

### PROMPT S4 — Forms & tables audit

```text
For every form: required-field validation shows a clear message,
invalid input is caught, empty submission is blocked with a message,
long input doesn't break layout, dropdowns/multi-selects work with
clear selected state, mock file-upload inputs show a selected-file
state, Cancel/Reset/Save behave predictably. For every DataTable:
search filters rows, filters combine correctly, sort works, pagination
works, row click and checkbox selection don't conflict, empty/loading
states render correctly with zero mock rows.
```

### PROMPT S5 — Responsive audit

```text
Test at 1920px, 1440px, 1280px, 1024px, and mobile (~390px). The
landing page must look genuinely good at all of these. /app/* should
at minimum not catastrophically break — sidebar collapses to an icon
rail or drawer below ~1024px, tables scroll horizontally rather than
overflow, multi-column detail layouts (Requirements, Evidence,
Defects, Execution Detail) stack to single-column below ~1024px. Fix
any overlap/clip/overflow at any of these widths.
```

### PROMPT S6 — Full interface-guidelines pass

```text
/web-design-guidelines

Audit the entire src/pages and src/components tree against the Web
Interface Guidelines, not just today's files. Fix every finding.
```

### PROMPT S7 — Full production-readiness gate

```text
/impeccable audit

Re-run the production-readiness audit across the whole app against
DESIGN.md and PRODUCT.md now that S1-S6 are done. Fix everything it
flags before we move to Sunday's polish pass.
```

---

# 🟡 SUNDAY — Final QA, Cross-Page Consistency, Polish & Release

### PROMPT SU1 — Bug triage (priority order)

```text
Fix bugs in this strict priority order, don't move to the next tier
until the current one is clean:
P0 (first): app fails to load, a route crashes, routing is broken, a
primary action button does nothing, sidebar navigation is broken.
P1: a modal/drawer is broken, a form doesn't submit/validate, data
isn't rendering where expected, a table is broken, a major responsive
layout is broken.
P2 (only after P0/P1 are clean): spacing, typography, minor alignment,
icon issues, animation glitches.
Report what you found and fixed at each tier before moving on.
```

### PROMPT SU2 — Cross-page color/gradient consistency

```text
/impeccable colorize

Check the entire app against DESIGN.md's color and gradient tokens —
every page under /app/* plus the landing page. Fix any page that
drifted from the accent color, gradient direction, or status-color
system established Tuesday. This is the pass that makes all 22 screens
read as one product instead of 21 separately colored dashboards
bolted onto one nice landing page.
```

### PROMPT SU3 — Typography consistency

```text
/impeccable typeset

Check typography hierarchy consistency against DESIGN.md across the
whole app — heading scale, body scale, the serif/monospace pairing
usage, weight and spacing. Fix drift.
```

### PROMPT SU4 — Final polish pass

```text
/impeccable polish

Run a final quality pass across /app/* within the existing design
system from DESIGN.md — spacing scale, button sizes/variants, card
corner radius, table row height, icon sizing, hover/active states,
empty/loading-state patterns. Don't introduce anything new — just make
what exists consistent and clean everywhere.
```

### PROMPT SU5 — Production build check

```text
Run the production build and lint. Fix every build error, TypeScript
error, ESLint error/warning, missing import, broken route, missing
asset reference, and console error/warning that appears during a full
click-through of the built/preview version (not dev mode). Confirm
the app runs correctly from a static production build with no
dev-only behavior leaking through.
```

### PROMPT SU6 — Final walkthrough, ship gate, deploy prep

```text
/impeccable audit

Run the final production-readiness gate against DESIGN.md and
PRODUCT.md across the entire app. Then do one manual walkthrough:
landing page top to bottom, every sidebar item in order, then the full
One-Click Test → Execution → FailureIQ → AutoHeal → Evidence → Defect
→ Regression → Release Readiness journey once more end to end. Fix
anything still off.

Since this is a static UI-only build with no backend, prepare it for a
static deploy (Vercel/Netlify/GitHub Pages) — confirm the build
output, client-side routing fallback, and grep the entire build output
for the string "OneClickQA" as a final check that it never shipped.
```

---

## Quick reference — priority tiers if you run out of time

**🔴 Must have:** Landing page, Global Shell, Command Center,
One-Click Test, Requirements, Application, Tests, TestIntent,
Execution, FailureIQ, AutoHeal, Evidence, Defects, Reports.

**🟠 Should have:** Test Data, Execution Detail, Regression/RiskRun,
Release Readiness, Integrations.

**🟡 Can be simplified:** Governance, Settings, advanced Copilot
intents (a working drawer with 2-3 intents is enough).
