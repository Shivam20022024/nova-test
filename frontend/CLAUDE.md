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
