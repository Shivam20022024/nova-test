# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React 18 + TypeScript + Vite, React Router v6, Tailwind CSS, lucide-react (icons), recharts (charts). No heavy UI kit — a small internal design system lives in src/components/ui/. Already scaffolded and building. Frontend/UI only for this build: no backend, no real API integration, no database, no real auth; all data comes from local mock data in src/mock/, actions simulate loading/success/error/approval states with a fake-delay helper rather than real network calls.

## Users

Primary: QA engineers, SDETs, release managers, and developers investigating test failures, using the product itself (`/app/*`). They read fast, often mid-incident or mid-release, and need to complete a task quickly rather than be sold to.

Secondary: engineering leaders evaluating whether to adopt the platform, reached via the marketing site (`/`). They need a sharp, confident case for adoption.

## Product Purpose

NovaTest AI is an AI-native autonomous QA platform — a "quality command center" that turns requirements, application understanding, and code changes into evidence-backed test coverage automatically. Its workflow spans: understand → design → automate → execute → observe → diagnose → heal → prove → decide → learn.

## Positioning

Most QA tooling automates one step (test generation, or execution, or flaky-test triage) and leaves the rest manual. NovaTest AI's mechanism is the closed loop across all of them, expressed as named sub-systems a competitor would need to rebuild wholesale, not bolt on: AppGraph™ (application understanding), TestIntent™ (AI test design), FailureIQ™ (failure diagnosis), AutoHeal™ (self-healing automation), RiskRun™ (risk-based regression selection), and EvidenceGraph™ (evidence-backed release decisions). The claim isn't "AI writes your tests" — it's that every release decision is backed by traceable evidence, generated automatically end to end.

## Operating Context

Two distinct surfaces sharing one brand:
- Marketing site (`/`, no app shell): a public page making the case to engineering leaders evaluating adoption.
- Product app (`/app/*`, global shell with topbar + grouped sidebar): a dense operational workspace used by QA engineers/SDETs/release managers to run and triage testing work, often under time pressure (mid-incident, mid-release).

The in-app AI assistant, NovaTest Copilot, is a global slide-in drawer available from every `/app/*` page (not a standalone route).

## Capabilities and Constraints

- Testing types (web, api, database, mobile, performance, security, accessibility) are served by one reusable Testing Workspace, not seven separate pages.
- Reports is one page with tabs (overview/test/defects/coverage/flaky/trends), not nine routes.
- Status semantics are fixed and reused everywhere: pass=green, fail=red, running=blue, flaky=amber, healing=purple, blocked=gray.
- Disabled controls must show *why* (permission tooltip) rather than fail silently.
- This build phase is UI-only: nothing persists to a server, nothing is ever actually sent anywhere.

## Brand Commitments

- Product name is "NovaTest AI" everywhere (nav logo, tab title, page titles, footer, empty states, onboarding copy, sample emails). Never "OneClickQA" / "OneClick QA" in any form (code, comments, copy, filenames, component names, commit messages) — that is a prior product name being retired.
- Sub-feature/module names stay their own sub-brands, unchanged: AppGraph™, TestIntent™, FailureIQ™, AutoHeal™, RiskRun™, EvidenceGraph™. The in-app AI assistant is "NovaTest Copilot".
- Voice: confident, precise, evidence-driven. No hype, no vague claims — every statement should sound backed by data.
- Anti-references (binding, do not use anywhere in the product): purple gradients, glassmorphism, generic "AI beige," italic-serif "beautifully crafted for modern teams"-style headlines, side-tab AI chat bubbles, three-equal-icon-tile feature rows used as filler, pulsing-dot "AI is thinking" indicators.

## Evidence on Hand

- `OneClickQA_Detailed_Technical_Doc_v2.pdf` and `OneClickQA wireframe specification Doc.pdf` at the repo root: earlier technical/wireframe specs for this product under its prior name. Not yet extracted (no PDF renderer available in this environment) — treat as background reference, not confirmed content, until read.
- `Sample Video.mp4` at the repo root: unreviewed reference video.
- No real customer content, testimonials, case studies, benchmarks, or pricing exists. Nothing of that kind should be fabricated; the marketing site's brief already scripts an illustrative "Novalantis" case study and testimonial as placeholder narrative, not a real claim.
- All in-app data is local mock data (TypeScript files in src/mock/) — never real user, customer, or execution data.

## Product Principles

1. Evidence drives decisions — every release claim should be traceable, not asserted.
2. Quality is a systems problem — requirements, tests, execution, and defects form one closed loop, not disconnected tools.
3. Operate surfaces optimize for task speed and scanability; the Persuade surface (marketing) optimizes for a confident, evidence-driven case. Neither borrows the other's job.
4. Reuse over proliferation — one configurable workspace/table/detail pattern beats many near-duplicate pages.
5. Progress over perfection — support real engineering velocity from intention to verified quality.
