# NovaTest AI — Complete Repository Documentation

> **Purpose of this document:** Full documentation of every file and folder in this repository. Covers the complete UI redesign (dual-theme system, premium design language, motion standards) alongside all backend services, API endpoints, and database schema.

> **Last Updated:** June 2026 — Full UI/UX overhaul applied. Branding migrated from "Novalantis" to **NovaTest AI** across all frontend surfaces.

---

## Recent UI Changes — June 2026 (Latest Session)

> All changes below are **frontend-only**. No backend logic, APIs, database schemas, or routing were modified.

### 1. Sidebar Cleanup
- Removed **Automation Crons** and **Team Directory** from the visible sidebar navigation menu.
- Routes (`/schedules`, `/settings`) and their pages remain fully accessible via direct URL.
- Sidebar now shows: Dashboard, Projects, Test Suites, Test Cases, Parallel Runner, AI Suite Generator, Autonomous QA.

### 2. One-Click Autonomous QA Page
- Updated subheading: **"19 specialized AI agents"** → **"20+ specialized AI agents"**
- All 7 feature cards (Video Telemetry, AI Self-Healing, Accessibility Scan, Security Sanity, Responsive Testing, API Validation, Auto Jira Bug) now **selected by default** on page load.
- Removed the "Estimated pipeline duration" text below the Run button.
- Custom Test Scenario textarea placeholder updated to a clean, empty hint.
- Browser engine chips upgraded: `text-sm font-bold`, `px-5 py-2.5`, solid indigo active state with white text.

### 3. Parallel Runner — Device Emulation Labels
- Display labels updated: `Desktop → Windows`, `iPhone 13 → iOS`, `Pixel 5 → Android`.
- Internal values (sent to backend) remain unchanged: `Desktop`, `iPhone 13`, `Pixel 5`.
- Selected device chip redesigned: solid cyan bg + white text for strong contrast in both themes.

### 4. Parallel Runner — Live Stream Telemetry Redesign
- Video container replaced with gradient glass panel (indigo→cyan→emerald in light, deep tones in dark).
- Premium empty state with icon card + "Monitoring Station Ready" headline.
- Live Event Feed redesigned: divider-based card rows, emoji status icons, `text-sm` message text, `text-xs` type badges, `time` element for timestamps.
- Source selector chips upgraded to `text-sm font-semibold` with proper active/inactive borders.
- Status indicator badge: semantic colours (emerald/amber/slate) + live pulse dot when `status === "live"`.

### 5. Execution Transcript Redesign (`ReportDetails.jsx`)
- Status-based card colours: emerald (pass), rose (fail), amber (warning), sky (info).
- Status emoji icons: ✅ 🔴 🟡 ℹ️ per event type.
- Action text: `text-[15px] font-bold` (was `text-xs`).
- Timestamp: `font-mono text-[13px] font-bold` (was `text-[10px]`).
- Scenario/value: `text-[13px] font-semibold` (was `text-[10px]`).
- Filter/search controls upgraded to theme-aware `var(--bg-input)` styling.
- Proper empty state with icon and message.
- Panel height increased: 500px → 540px.

### 6. Report / Replay Analytics — Premium Design System (`index.css`)
- Added `.report-tile`, `.report-tile-label`, `.report-tile-value` utility classes.
- Added semantic surface classes: `.panel-success`, `.panel-error`, `.panel-warning`, `.panel-info`, `.panel-neutral`.
- Added `.transcript-item`, `.timeline-item`, `.step-log-row`, `.log-panel`, `.validation-pass`, `.validation-fail`, `.rec-item`, `.issue-item` with full light/dark theming.
- All report page section headings use `.report-section-heading`, page title uses `.report-page-title`.
- Applied to: summary tiles, AI diagnosis, validation checklist, timeline, step logs, recommendations, network issues, raw logs.

### 7. Global Light Mode Visibility Fixes (`index.css`)
- Comprehensive `:root.light` overrides targeting transcript, AI diagnosis, validation, recommendations, network issues, timeline, log panels, step log rows, status badges, glass panels, chips, and all Recharts SVG fill colours.
- Glass panel text defaulted to `#111827`; gradient text guard preserved.
- Status badge colours sharpened: emerald-700, rose-700, amber-700 in light mode.

### 8. Global Typography Enhancement (`index.css`)
- Base body font size: `15px`, line-height `1.65`.
- Headings fluid scale: `h1` `clamp(1.75rem, 3.5vw, 2.5rem)` through `h6` `0.875rem`.
- Form inputs/selects: `0.9375rem` enforced.
- Labels: `13px font-600`, near-black in light mode.
- Tables: headers `0.8125rem font-800` (light) / `font-700` (dark); body cells `0.9375rem font-500`.
- Buttons: `0.9375rem`.
- Recharts chart labels: `12px font-600`, correct fill per theme.

### 9. Dashboard Analytics Typography (`Dashboard.jsx`)
- **Historical Execution Trend chart:**
  - Title: `text-sm` → `text-lg font-bold`
  - X/Y axis tick font: `10px` → `14px font-600`, with `tickMargin` spacing
  - Legend: `11px` → `14px font-600 paddingTop:12px`
  - Tooltip: theme-aware `var(--bg-panel)` colours
  - Area stroke width: `2` → `2.5`
  - Chart height: `256px` → `288px`
- **Cross-Browser Distribution pie chart:**
  - Title: `text-sm` → `text-lg font-bold`
  - Center value: `text-2xl` → `text-4xl font-black`
  - Center subtitle: `9px` → `13px font-bold tracking-widest`
  - Browser legend: `text-xs gap-1.5 w-2 dot` → `text-sm font-semibold gap-2 w-3 dot`
  - Pie radii: `innerRadius 58 / outerRadius 80` → `62 / 88`
  - Chart height: `192px` → `224px`
  - Tooltip: theme-aware colours

### 10. Dashboard Table & Metrics Upgrades (`Dashboard.jsx`)
- Metric cards: value text `text-4xl` → `text-5xl font-black`
- Table headers: `text-[10px] tracking-widest` → `text-sm tracking-wide font-bold`
- Table body cells: `text-sm` → `text-base font-medium`
- Default recent execution records: `25` → `10`; added `100` records option.

### 11. Projects & TestSuites Page Titles
- Page `h1` titles: `text-3xl` → `text-3xl lg:text-4xl font-black`

### 12. Sidebar Navigation (`Layout.jsx`)
- Nav link text: `text-sm` → `text-[15px] font-semibold`
- Active item: `font-bold` via `.nav-item.active span` CSS override
- Nav icons: `w-3.5 h-3.5` → `w-4 h-4`

---


### 13. Final UI Surface Cleanup & Dynamic Tile Styling Standard

**Files changed:** `ReportDetails.jsx`, `index.css`

All remaining dark/gray placeholder surfaces replaced with contextual premium color surfaces. A reusable CSS design system in `index.css` ensures all current and future cards automatically inherit the new visual treatment.

**New CSS classes (consume for any new report widget):**
- `.report-card` — generic card, soft indigo-white gradient
- `.transcript-card` — transcript entries, lavender gradient
- `.diagnosis-card` — AI diagnosis, **status-adaptive surface**
- `.technical-log-card` — technical action bar, indigo→cyan→green gradient
- `.analytics-card` — analytics/timeline panels, indigo-white gradient
- `.status-card` — KPI metric tiles, lavender gradient

**Status modifiers:** `.status-success` `.status-error` `.status-warning` `.status-info` `.status-ai`

**Report JSX surface upgrades:**
- Back button: `bg-slate-900` → indigo→cyan gradient pill
- Browser badge: `bg-slate-800` → sky-blue gradient rounded-full pill
- **View Technical Logs Collapsible Section:** Dull gray layout and black backgrounds completely removed. Replaced with `.technical-logs-collapsible-panel` container with a modern light 3-color gradient (`#EEF4FF`, `#F5F3FF`, `#ECFEFF`), custom 20px rounded borders, and indigo/cyan-themed header (`linear-gradient(90deg, rgba(99,102,241,0.10), rgba(168,85,247,0.08))`).
- **Raw Trace badge/button:** Custom gradient CTA styling (`linear-gradient(135deg, #6366F1, #8B5CF6)`), white text, 12px rounded borders, and dynamic hover lift-shadow effects.
- **Log Entry Card Surfaces:** Color-coded based on log type:
  - Success-related: `#ECFDF5` background, `#A7F3D0` border, `#065f46` text.
  - Error-related: `#FEF2F2` background, `#FECACA` border, `#9f1239` text.
  - Information: `#EEF4FF` background, `#C7D2FE` border, `#1e40af` text.
  - Accessibility: `#F5F3FF` background, `#DDD6FE` border, `#5b21b6` text.
  - Security: `#ECFEFF` background, `#A5F3FC` border, `#0891b2` text.
- **Log Typography:** Upgraded log action title (`font-size: 20px`, `font-weight: 700`) and details description (`font-size: 16px`, `font-weight: 500`, `line-height: 1.7`).
- **Expanded Detail Panels (JSON & Selector Blocks):** Text size upgraded to `15px`–`16px` and code blocks to `15px` with a highly readable `line-height: 1.8`. Prominent labels for `Value` and `Selector`.
- AI Diagnosis card: always-rose → **fully status-adaptive** (emerald/amber/rose per `aiReport.status`)
- Error Classification card: dark glass → `.diagnosis-card.status-error`
- AI Reconstructed Timeline: `bg-slate-900/40` → `.analytics-card` with indigo timeline dots

**Design rule enforced:** `#333`–`#666` and black backgrounds banned from all report surfaces in Light Mode.

---

## Table of Contents

1. [Project Overview & Architecture](#1-project-overview--architecture)
2. [Repository Root](#2-repository-root)
3. [Frontend — `/frontend`](#3-frontend--frontend)
   - [Configuration Files](#31-configuration-files)
   - [Entry Points](#32-entry-points)
   - [Global Styles — `index.css`](#33-global-styles--indexcss)
   - [App Router — `App.jsx`](#34-app-router--appjsx)
   - [Contexts — `src/contexts/`](#35-contexts--srccontexts)
   - [Utils — `src/utils/`](#36-utils--srcutils)
   - [Services — `src/services/`](#37-services--srcservices)
   - [Common Components — `src/components/common/`](#38-common-components--srccomponentscommon)
   - [Pages — `src/pages/`](#39-pages--srcpages)
4. [Node.js Backend — `/backend-node`](#4-nodejs-backend--backend-node)
   - [Entry & App Setup](#41-entry--app-setup)
   - [Routes — `src/routes/`](#42-routes--srcroutes)
   - [Agents — `src/agents/`](#43-agents--srcagents)
   - [Queue — `src/queue/`](#44-queue--srcqueue)
   - [Services — `src/services/`](#45-services--srcservices)
   - [Middleware — `src/middleware/`](#46-middleware--srcmiddleware)
   - [Lib — `src/lib/`](#47-lib--srclib)
   - [Orchestrator — `src/orchestrator/`](#48-orchestrator--srcorchestrator)
   - [Utils — `src/utils/`](#49-utils--srcutils)
   - [Database Schema — `prisma/`](#410-database-schema--prisma)
5. [Python Execution Engine — `/backend`](#5-python-execution-engine--backend)
   - [Entry Points](#51-entry-points)
   - [API Routes — `api/`](#52-api-routes--api)
   - [Execution Engine — `execution/`](#53-execution-engine--execution)
   - [LLM Layer — `llm/`](#54-llm-layer--llm)
   - [Models & Schemas — `models/`](#55-models--schemas--models)
   - [Self-Healing — `self_healing/`](#56-self-healing--self_healing)
   - [Services — `services/`](#57-services--services)
   - [Storage — `storage/`](#58-storage--storage)
   - [Utils — `utils/`](#59-utils--utils)
6. [Environment Variables](#6-environment-variables)
7. [Full API Endpoint Reference](#7-full-api-endpoint-reference)
8. [UI Design System Reference](#8-ui-design-system-reference)
9. [Data Flow Diagrams](#9-data-flow-diagrams)
10. [Running the Platform](#10-running-the-platform)

---

## 1. Project Overview & Architecture

**NovaTest AI** is an enterprise-grade, AI-powered UI testing platform. Users describe what they want to test in plain English; a multi-agent AI system generates test steps, executes them in real browsers via Playwright, self-heals broken selectors, and produces rich reports.

### Three-Service Architecture

| Service | Directory | Language/Framework | Port |
|---|---|---|---|
| Frontend SPA | `/frontend` | React 18 + Vite + Tailwind CSS | **5173** |
| API + Worker | `/backend-node` | Node.js + Express + BullMQ | **8080** |
| Execution Engine | `/backend` | Python + FastAPI + Playwright | **8000** |

### Data & Storage

| Resource | Technology | Purpose |
|---|---|---|
| Primary Database | SQLite (`dev.db`) via Prisma ORM | Users, Projects, Suites, Cases, Executions, Reports |
| Auth | Supabase Auth (JWT) | User login, signup, session management |
| File Storage | Supabase Object Storage | Screenshots, video replays, JSON reports |
| Job Queue | Redis / Upstash via BullMQ | Async browser execution jobs |

### High-Level Data Flow

```
User Browser
  → React Frontend (port 5173)
    → Node.js Express API (port 8080)
      → Prisma → SQLite DB
      → BullMQ → Redis
        → Execution Worker
          → Python FastAPI (port 8000)
            → Playwright Browser
          → Supabase Storage (artifacts)
          → Socket.IO → Frontend (live events)
```

---

## 2. Repository Root

```
Nova-Test-Suite-Generator-main/
├── .github/                        # GitHub Actions CI/CD workflows
├── .gitignore                      # Root gitignore (covers all services)
├── ERROR_CLASSIFICATION_LAYER.md   # Technical doc: how errors are classified by AI agents
├── FRONTEND_DESIGN_GUIDE.md        # Design intent guide for UI
├── PROJECT_FULL_DOCUMENTATION.md   # Original project specification document
├── README.md                       # ← THIS FILE
├── backend/                        # Python FastAPI execution engine
├── backend-node/                   # Node.js Express API + BullMQ worker
├── frontend/                       # React + Vite + Tailwind SPA
└── test_dom_capture.py             # Standalone script: captures DOM of a URL for testing
```

### `ERROR_CLASSIFICATION_LAYER.md`
Documents the multi-tier error classification system used by the Python execution engine. Describes error categories: `SELECTOR_NOT_FOUND`, `NAVIGATION_FAILED`, `ASSERTION_FAILED`, `TIMEOUT`, `NETWORK_ERROR`, and how the self-healing agent responds to each.

### `FRONTEND_DESIGN_GUIDE.md`
Design intent notes. Describes the dark-mode glassmorphism aesthetic, color palette intent (indigo/cyan/violet), font choices (Plus Jakarta Sans, Outfit), and component layout principles.

### `PROJECT_FULL_DOCUMENTATION.md`
High-level project spec covering business requirements, agent responsibilities, database schema rationale, and execution lifecycle.

---

## 3. Frontend — `/frontend`

### 3.1 Configuration Files

#### `frontend/package.json`
- **name:** `ai-qa-frontend`
- **type:** ES Module (`"type": "module"`)
- **scripts:**
  - `dev` → `vite` (starts Vite dev server on port 5173)
  - `build` → `vite build` (production bundle to `/dist`)
  - `preview` → `vite preview` (serve the built dist)
- **Key dependencies:**
  - `react` ^18.3.1 — UI framework
  - `react-dom` ^18.3.1 — DOM renderer
  - `react-router-dom` ^7.15.1 — Client-side routing
  - `@supabase/supabase-js` ^2.106.1 — Auth + storage client
  - `framer-motion` ^12.40.0 — Animations and transitions
  - `lucide-react` ^1.16.0 — Icon library (all icons used throughout UI)
  - `recharts` ^3.8.1 — Charts (AreaChart, PieChart on Dashboard)
  - `socket.io-client` ^4.8.3 — WebSocket for live execution events
  - `swr` ^2.4.1 — Data fetching with cache/revalidation (used in Dashboard)
  - `jspdf` ^4.2.1 + `jspdf-autotable` ^5.0.8 — PDF export in ReportDetails
  - `clsx` ^2.1.1 — Conditional className utility
  - `tailwind-merge` ^3.6.0 — Tailwind class merging
- **Dev dependencies:**
  - `vite` ^7.3.3
  - `@vitejs/plugin-react` ^4.7.0
  - `tailwindcss` ^3.4.17
  - `autoprefixer` ^10.4.20
  - `postcss` ^8.4.49

#### `frontend/vite.config.js`
Minimal Vite config. Registers the `@vitejs/plugin-react` plugin. No proxy config — the frontend calls the Node backend directly via the `VITE_API_BASE` env variable.

```js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()] });
```

#### `frontend/tailwind.config.js`
Configures Tailwind to scan `./src/**/*.{js,jsx}`. No custom theme extensions — all design tokens are applied via inline Tailwind utilities in JSX.

#### `frontend/postcss.config.js`
Enables `tailwindcss` and `autoprefixer` PostCSS plugins.

#### `frontend/.env`
Frontend environment variables (committed — contains public keys only):
```
VITE_SUPABASE_URL="https://bvfylyhugpyeqkbujjbr.supabase.co"
VITE_SUPABASE_ANON_KEY="sb_publishable_pTSsZUN10yRposuAEJIxog_QYRt6qtg"
VITE_API_BASE="http://127.0.0.1:8080"
```

#### `frontend/index.html`
HTML entry point. Contains `<div id="root">` where React mounts. Imports `/src/main.jsx` as a module script.

**Updated (June 2026):**
- `<html class="light">` — default theme is **Light Mode**
- Blocking inline `<script>` reads `localStorage.getItem('novatest_theme')` before first paint to eliminate Flash of Unstyled Content (FOUC)
- Falls back to `light` if no preference is stored
- Title updated to `NovaTest AI – Enterprise QA Platform`

---

### 3.2 Entry Points

#### `frontend/src/main.jsx`
React application bootstrap. Sets up the full provider tree in this order (outermost first):
1. `BrowserRouter` — enables React Router
2. `ToastProvider` — global toast notifications
3. `AuthProvider` — Supabase auth session state
4. `DataProvider` — project/suite/test-case state
5. `App` — the main route component

---

### 3.3 Global Styles — `index.css`

**Location:** `frontend/src/index.css`

Imported once in `main.jsx`. **Fully rewritten (June 2026)** to implement a dual-theme CSS variable system.

#### Fonts
- **Plus Jakarta Sans** (weights: 300–800) — primary UI font
- **Inter** (weights: 300–900) — fallback

#### Dual-Theme Token System
All colours, shadows, and surfaces are defined as CSS custom properties scoped to `:root.light` and `:root.dark`. The `html` element class (`light` or `dark`) is managed by `ThemeContext`.

**Light mode tokens (`:root.light`):**
```css
--bg-page:         #f4f6fb
--bg-sidebar:      #ffffff
--bg-panel:        #ffffff
--bg-input:        #f1f5fe
--text-primary:    #000000
--text-secondary:  #111827
--text-muted:      #374151
--shadow-card:     0 1px 3px rgba(0,0,0,0.05), 0 4px 16px rgba(99,102,241,0.06)
--shadow-hover:    0 8px 30px rgba(99,102,241,0.14)
```

**Dark mode tokens (`:root.dark`):**
```css
--bg-page:         #080c14
--bg-sidebar:      #0d1117
--bg-panel:        rgba(16,22,38,0.70)
--text-primary:    #f1f5f9
--text-secondary:  #94a3b8
--text-muted:      #64748b
--shadow-hover:    0 8px 32px rgba(99,102,241,0.25)
```

#### Utility Classes

| Class | Description |
|---|---|
| `.glass-panel` | Uses `--bg-panel` + `backdrop-blur(18px)` + `--border-subtle`. Hover: `translateY(-2px)` |
| `.card-lift` | `translateY(-4px)` on hover with spring cubic-bezier transition |
| `.glass-input` | `--bg-input` + `--border-input`. Focus: indigo ring + `--bg-input-focus` |
| `.btn-primary` | Indigo→cyan gradient, `box-shadow`, hover `scale(1.02)`, active `scale(0.97)` |
| `.btn-ghost` | `--bg-badge` bg, `--border-input` border, hover border darkens |
| `.nav-item` | `font-weight:600`, uses `--sidebar-text`. Active: `font-weight:700` + left border accent |
| `.metric-card` | `translateY(-5px)` hover + per-accent glow blob via `::after` |
| `.table-row` | `cursor:pointer` + `--bg-badge` background on hover |
| `.gradient-text` | Indigo→cyan→violet `background-clip:text` |
| `.theme-toggle` | Animated 52×28px pill toggle with spring-animated thumb |
| `.skeleton` | Shimmer animation using `--bg-badge` gradient |
| `.animate-float` | 5px vertical float, 4s loop |
| `.animate-pulse-ring` | Expanding ring for status indicators |

#### Light Mode Contrast Enforcement
A dedicated `:root.light` block forces near-black text on all content elements:
```css
:root.light table thead th  { color: #000000; font-weight: 700; }
:root.light table tbody td  { color: #111827; font-weight: 500; }
:root.light input, textarea { color: #000000; }
:root.light label           { color: #111827; font-weight: 600; }
:root.light .text-gray-400  { color: #374151; } /* override weak Tailwind utilities */
```

---

### 3.4 App Router — `App.jsx`

**Location:** `frontend/src/App.jsx`

Defines all client-side routes using React Router v7. Contains a `ProtectedRoute` wrapper that redirects unauthenticated users to `/welcome`.

#### Route Map

| Path | Component | Auth Required | Notes |
|---|---|---|---|
| `/welcome` | `LandingPage` | No | Public marketing page; redirects authenticated users to `/` |
| `/auth` | `AuthPage` | No | Login + Signup form; redirects authenticated users to `/` |
| `/` | `Dashboard` | Yes | Main analytics dashboard |
| `/projects` | `Projects` | Yes | Project workspace management |
| `/suites` | `TestSuites` | Yes | Test suite management per project |
| `/cases` | `TestCases` | Yes | Test case management per suite |
| `/execution` | `Execution` | Yes | Parallel cross-browser test runner |
| `/ai-builder` | `AutonomousQA` | Yes | AI website crawler + flow generator |
| `/autonomous` | `AutonomousRunner` | Yes | One-click full autonomous QA trigger |
| `/schedules` | `Schedules` | Yes | Cron job scheduler for test suites |
| `/reports/:runId` | `ReportDetails` | Yes | Detailed execution report for a run ID |
| `/settings` | `Settings` | Yes | Jira integration configuration |

#### `ProtectedRoute` Component
Checks `currentUser` from `AuthContext`. If null → redirects to `/welcome`. If authenticated → wraps children in `<Layout>`.

---

### 3.5 Contexts — `src/contexts/`

Four React Context providers that supply global state to all pages. A fourth context, `ThemeContext`, was added as part of the June 2026 redesign.

---

#### `AuthContext.jsx`

**Purpose:** Manages Supabase authentication session state.

**Exports:** `AuthProvider`, `useAuth`

**State:**
- `currentUser` — the Supabase `User` object (or `null` if logged out)
- `authLoading` — boolean, true while session is being resolved

**Methods:**
- `login(email, password)` — calls `supabase.auth.signInWithPassword()`, updates token via `api.setToken()`
- `signup(email, password, name, role)` — calls `supabase.auth.signUp()` with metadata: `{ full_name, role }`
- `logout()` — calls `supabase.auth.signOut()`, clears token

**Behavior:** Subscribes to `supabase.auth.onAuthStateChange()` on mount. Keeps `api` token in sync with the Supabase JWT. Renders children only when `authLoading === false`.

**`currentUser` object shape (from Supabase):**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "user_metadata": {
    "full_name": "John Doe",
    "role": "QA Engineer"
  }
}
```
> Note: Pages access `currentUser.full_name` and `currentUser.role` from `user_metadata`. The `Layout.jsx` reads `currentUser?.full_name` and `currentUser?.role` directly.

---

#### `DataContext.jsx`

**Purpose:** Global state for the hierarchical data model: Projects → Suites → Test Cases. Also manages Schedules.

**Exports:** `DataProvider`, `useData`

**State:**
```
projects[]      → All projects for the current user
activeProject   → The currently selected project (drives sidebar selector)
suites[]        → Suites belonging to activeProject
activeSuite     → Currently selected suite
testCases[]     → Test cases belonging to activeSuite
activeCase      → Currently selected test case (pre-populates Execution page)
schedules[]     → All cron schedules
```

**Load Cascade:**
1. On `currentUser` change → `loadProjects()` and `loadSchedules()`
2. On `activeProject` change → `loadSuites(projectId)`
3. On `activeSuite` change → `loadTestCases(suiteId)`

**API calls used:**
- `api.getProjects()` → `GET /api/v1/projects`
- `api.getSuites(projectId)` → `GET /api/v1/projects/:id/suites`
- `api.getTestCases(suiteId)` → `GET /api/v1/suites/:id/cases`
- `api.getSchedules()` → `GET /api/v1/schedules`

**All state setters are exported** so pages can directly mutate state after create/delete operations without a full refetch.

---

#### `ThemeContext.jsx` *(Added June 2026)*

**Purpose:** Manages Light/Dark theme preference.

**Exports:** `ThemeProvider`, `useTheme`

**State:** `theme` — `"light"` (default) or `"dark"`

**Behaviour:**
- Default theme: **Light Mode** (`localStorage.getItem('novatest_theme') || 'light'`)
- On change: removes old class, adds new class to `document.documentElement`
- Persists to `localStorage` under key `novatest_theme`
- `toggleTheme()` — flips between `light` and `dark`

**Provider location:** Registered in `main.jsx` wrapping the entire app.

---

#### `ToastContext.jsx`

**Purpose:** Global toast notification system.

**Exports:** `ToastProvider`, `useToast`

**Method:** `triggerToast(message, isError = false)`
- Success toast: green background + `CheckCircle2` icon, disappears after 5 seconds
- Error toast: red background + `AlertTriangle` icon, disappears after 5 seconds
- Animation: Framer Motion slide-in from top-center (`y: -40` → `y: 0`)
- Position: Fixed, top-center, z-index 999

---

### 3.6 Utils — `src/utils/`

#### `api.js`

**Purpose:** Central HTTP client. All API calls from the frontend go through this object.

**Exports:** `api` (object), `API_BASE` (string), `wsUrl(executionId)` (function)

**`API_BASE`:** Reads from `import.meta.env.VITE_API_BASE` — defaults to `http://127.0.0.1:8080`.

**`wsUrl(executionId)`:** Converts `API_BASE` to a WebSocket URL: `ws://127.0.0.1:8080/api/v1/ws/executions/:id`

**Token Storage:** JWT stored in `localStorage` under key `ai_qa_token`.

**`api.request(path, options)`** — Base fetch wrapper:
- Automatically injects `Authorization: Bearer <token>` header
- Sets `Content-Type: application/json` unless body is `FormData`
- On `401` → clears token, redirects to `/auth`
- On other errors → parses `detail` or `message` from JSON body

**Full Method List:**

| Method | HTTP | Path | Description |
|---|---|---|---|
| `getMe()` | GET | `/api/v1/auth/me` | Get current user info from Node backend |
| `getProjects()` | GET | `/api/v1/projects` | List all projects for the user |
| `createProject(name, desc)` | POST | `/api/v1/projects` | Create a new project |
| `deleteProject(id)` | DELETE | `/api/v1/projects/:id` | Delete project and cascade |
| `getSuites(projectId)` | GET | `/api/v1/projects/:id/suites` | List suites for a project |
| `createSuite(projectId, name, desc)` | POST | `/api/v1/projects/:id/suites` | Create suite |
| `deleteSuite(suiteId)` | DELETE | `/api/v1/suites/:id` | Delete suite |
| `getTestCases(suiteId)` | GET | `/api/v1/suites/:id/cases` | List test cases |
| `createTestCase(suiteId, name, steps, desc)` | POST | `/api/v1/suites/:id/cases` | Create test case |
| `updateTestCase(caseId, name, steps, desc)` | PUT | `/api/v1/cases/:id` | Update test case |
| `deleteTestCase(caseId)` | DELETE | `/api/v1/cases/:id` | Delete test case |
| `getRuns(limit)` | GET | `/api/v1/runs?limit=N` | Recent execution runs |
| `getSchedules()` | GET | `/api/v1/schedules` | List cron schedules |
| `createSchedule(payload)` | POST | `/api/v1/schedules` | Create cron schedule |
| `deleteSchedule(id)` | DELETE | `/api/v1/schedules/:id` | Delete schedule |
| `runMultiTest(payload)` | POST | `/api/v1/executions/run-multi-test` | Launch parallel cross-browser run |
| `getRunDetails(runId)` | GET | `/api/v1/executions/:id` | Execution log with steps, videos, screenshots |
| `getExecutionTrace(runId)` | GET | `/api/v1/executions/:id/trace` | Playwright trace data |
| `getExecutionPlan(runId)` | GET | `/api/v1/executions/:id/plan` | AI-generated plan for execution |
| `generateSuite(prompt, baseUrl)` | POST | `/api/v1/ai/generate-suite` | AI generates test suite from text prompt |
| `runSuiteAndSaveReport(suite, suiteId, baseUrl, browser, headless)` | POST | `/api/v1/ai/run-suite-and-save-report` | Run suite and store report |
| `generatePlaywrightCode(suiteName, url, steps)` | POST | `/api/v1/ai/generate-playwright` | Generate .spec.ts file |
| `crawlWebsite(projectId, baseUrl, maxDepth)` | POST | `/api/v1/discovery/crawl/:projectId` | Crawl a website for flows |
| `generateAutonomousFlows(projectId, targetUrl)` | POST | `/api/v1/discovery/generate-flows/:projectId` | Generate AI flows from crawl |
| `getDiscoveredFlows(projectId)` | GET | `/api/v1/discovery/flows/:projectId` | Get saved discovered flows |
| `triggerAutonomousQA(payload)` | POST | `/api/v1/autonomous/run` | Trigger full autonomous pipeline |

#### `supabase.js`

Initializes and exports the Supabase client:
```js
import { createClient } from "@supabase/supabase-js";
export const supabase = createClient(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY);
```
Used only in `AuthContext.jsx`.

---

### 3.7 Services — `src/services/`

#### `ScenarioParser.js`

**Purpose:** Parses free-text bullet-point test scenarios (typed by users in the `AutonomousRunner` page) into structured step objects.

**Export:** `ScenarioParser` (object with `parse(text)` method)

**Input example:**
```
- Search hotels in Mumbai
- Select future check-in dates
- Verify results appear
```

**Output:** Array of step objects compatible with the execution engine.

---

### 3.8 Common Components — `src/components/common/`

#### `Layout.jsx` *(Fully rewritten June 2026)*

**Purpose:** Main application shell. Contains sidebar, theme toggle, page transition wrapper.

**Structure:**
```
<div> (min-h-screen, uses var(--bg-page), flex row)
  Background gradient blobs (fixed, pointer-events-none, uses CSS blob vars)
  <aside> (Sidebar, w-64, var(--bg-sidebar), var(--shadow-sidebar))
    Logo: NovaTest AI gradient text + live indicator dot + "ENTERPRISE QA PLATFORM" badge
    Theme Toggle: animated pill (Light Mode / Dark Mode) — visible from every page
    Project Selector: <select> using glass-input styling
    <nav> (nav-item CSS class for all items)
    User Profile: avatar initials + name + role + LogOut icon
  <main> (flex-1, p-6/p-8, max-w-1600px)
    <AnimatePresence> → <motion.div> page transition (opacity 0→1, y 12→0, 250ms)
      {children}
```

**Theme Toggle:** Pill-shaped `52×28px` button in sidebar. Sun icon (light) / Moon icon (dark). Spring-animated sliding thumb. Calls `useTheme().toggleTheme()`.

**Sidebar Navigation Items:**

| ID | Path | Label | Icon |
|---|---|---|---|
| dashboard | `/` | Dashboard | `LayoutDashboard` |
| autonomous | `/autonomous` | One-Click QA | `Zap` |
| projects | `/projects` | Projects Space | `FolderOpen` |
| suites | `/suites` | Test Suites | `Layers` |
| cases | `/cases` | Test Cases | `ClipboardList` |
| live | `/execution` | Parallel Runner | `PlayCircle` |
| ai_builder | `/ai-builder` | AI Suite Generator | `Wand2` |
| schedules | `/schedules` | Automation Crons | `Calendar` |
| settings | `/settings` | Team Directory | `Users` |

**Active item styling:** `.nav-item.active` CSS class — `var(--sidebar-active-bg)` gradient, `var(--sidebar-active-text)`, `font-weight:700`, 3px left border with indigo glow. Spring-animated `motion.div` indicator dot.

**Page Transitions:** `AnimatePresence` with `mode="wait"` wraps `{children}`. Each route change animates: `opacity:0 y:12 → opacity:1 y:0` over 250ms.

**User Profile:** Gradient avatar, `var(--text-primary)` name, `var(--text-secondary)` role, logout icon.

---

### 3.9 Pages — `src/pages/`

---

#### `LandingPage.jsx`
**Route:** `/welcome`
**File:** `src/pages/LandingPage.jsx` (101 lines)

Public marketing landing page. Not inside Layout. Three sections:
1. **Nav bar:** Logo (Bot icon + "Novalantis"), "Sign In" and "Get Started" buttons → both navigate to `/auth`
2. **Hero:** Animated badge ("1-Click Autonomous AI QA Framework"), `h1` headline, subtitle text, two CTA buttons ("Start Free Trial", "View Demo"), all animated with Framer Motion (`y: 20 → 0`)
3. **Stats bar:** Four metrics: 10x Faster Generation, 99% Self-Healing Accuracy, 7 Specialized AI Agents, 0 Lines of Code Needed

**Colors:** indigo-400 to violet-400 gradient on headline highlight. Background: `#090d16` with blurred gradient blobs.

---

#### `AuthPage.jsx`
**Route:** `/auth`
**File:** `src/pages/AuthPage.jsx` (168 lines)

Login / Signup form (toggled by state). Not inside Layout.

**Form States:**
- **Login mode** (default): Email + Password fields + "Sign In" button
- **Signup mode**: Full Name + Email + Password + Role select + "Create Enterprise Account" button

**Role options for signup:** Administrator, QA Engineer, Product Owner, Viewer (Read Only)

**Pre-filled test credentials displayed in a sandbox notice box:**
```
User: admin@testplatform.ai
Pass: admin123
```

**Layout:** Full-screen centered card (`glass-panel-heavy`, `rounded-3xl`, `glow-indigo`), animated with Framer Motion. Two background gradient blobs.

---

#### `Dashboard/Dashboard.jsx` *(Rewritten June 2026)*
**Route:** `/`

Main analytics dashboard. Uses `useSWR` for automatic data fetching with 30-second refresh intervals.

**Data Fetched (all via SWR, polled every 30s):**
- `/api/v1/dashboard/summary` → `{ totalExecutions, successRate, passedCount, failedCount, selfHealingCount, avgDuration }`
- `/api/v1/dashboard/execution-trend?days=7` → Array of `{ date, passed, failed }`
- `/api/v1/dashboard/browser-distribution` → Array of `{ browser, count }`
- `/api/v1/dashboard/recent-executions?limit=N` → Recent execution records

**UI Sections:**

1. **Header:** "LIVE ANALYTICS" badge + gradient `h1` "NovaTest AI Dashboard" + `btn-ghost` sync button. Staggered `fadeUp` entrance animation.
2. **Empty state:** `animate-float` icon + heading + description. All using CSS var tokens.
3. **Loading skeletons:** `.skeleton` shimmer class on placeholder cards.
4. **`MetricCard` component (4-column grid):** Each card uses `.metric-card` class with per-accent coloured glow blob (`::after`), `translateY(-5px)` hover lift, large `text-4xl font-black` value, coloured icon chip.
   - Total Executions — indigo accent
   - Platform Run Success — cyan accent
   - Self-Healing Triggers — violet accent
   - Average Duration — rose accent
5. **Charts row (2/3 + 1/3):** Containers use `glass-panel` + `var(--border-subtle)`. Chart logic unchanged.
   - `AreaChart` — 7-day trend, "Last 7 days" badge
   - `PieChart` — browser donut with "Total Runs" centre label
6. **Recent Executions table:** `.table-row` class for hover highlight. Status badges use both `light`/`dark` Tailwind variants. Columns unchanged.

---

#### `Projects/Projects.jsx`
**Route:** `/projects`
**File:** `src/pages/Projects/Projects.jsx` (167 lines)

Project workspace management page.

**Features:**
- **Create Project:** Expandable form (Framer Motion `height: 0 → auto` animation) with Name + Description textarea
- **Project cards grid:** 3-column responsive grid. Each card shows:
  - Project name + `PROJ-{id}` badge
  - Description (3-line clamp)
  - "Set Active" / "✓ Currently Active" toggle button
  - Delete button (Administrators only; `window.confirm()` guard)
  - Active project gets `border-l-4 border-indigo-500` left accent

**Role guard:** Delete button only shown to `Administrator` role.

---

#### `TestSuites/TestSuites.jsx`
**Route:** `/suites`
**File:** `src/pages/TestSuites/TestSuites.jsx` (177 lines)

Test suite management. Requires an active project to be selected.

**Features:**
- Shows "Please select a Project" empty state when no `activeProject`
- **Create Suite:** Expandable form with Name + Description. Requires `activeProject`
- **Suite cards grid:** 3-column responsive. Each card:
  - Suite name + `SUITE-{id}` badge
  - Description
  - "Set Active" toggle
  - Delete button (Administrators + QA Engineers)
  - Active suite gets `border-l-4 border-indigo-500`

---

#### `TestCases/TestCases.jsx`
**Route:** `/cases`
**File:** `src/pages/TestCases/TestCases.jsx` (286 lines)

Test case management per suite. Requires active suite.

**Features:**
- Shows "Please select a Test Suite" empty state when no `activeSuite`
- **Create Test Case form:** Name + Description + expandable step builder
- **Step builder:** Each row has:
  - Step number badge
  - Action selector: `goto`, `click`, `fill`, `assert_text`, `assert_visible`
  - Selector/URL input (changes label based on action)
  - Value input
  - Delete row button (rose)
  - "Add Step" link at bottom
- **Test case cards:** Accordion-style. Clicking header expands step viewer:
  - Step list showing: `[number] ACTION | selector/url | value`
  - Play button → sets as `activeCase` (pre-populates Execution page)
  - Delete button (Administrators + QA Engineers)
  - Step count badge

---

#### `Execution/Execution.jsx`
**Route:** `/execution`
**File:** `src/pages/Execution/Execution.jsx` (492 lines)

Parallel cross-browser test runner with live WebSocket streaming.

**Left Panel — Run Configuration:**
- Execution Name (pre-filled from `activeCase.name` if available)
- Target Base URL input
- Execution Steps JSON textarea (pre-filled from `activeCase.steps`)
- Browser toggle buttons: `chromium`, `firefox`, `webkit`, `edge`
- Device emulation toggles: `Desktop`, `iPhone 13`, `Pixel 5`
- "Launch Parallel Execution" button (gradient, disabled while running)
- "STOP" button (rose, appears only while running)

**Right Panel — Live Stream Telemetry:**
- Connection status badge: `disconnected` / `connecting` / `live`
- Video/screenshot viewer: `<video>` for `.mp4`, `<img>` for screenshots
- Source selector: tabs for each execution ID's stream
- Live log feed: scrollable monospace log showing timestamped events

**WebSocket Events Listened:**
- `queued`, `running`, `browser_log`, `agent_progress`, `screenshot_uploaded`, `live_frame`, `execution_completed`

**Bottom — Results Summary** (shown after execution completes):
- Total / Passed / Failed / Duration summary
- Execution Matrix table: Browser | Status badge | Duration | "View Report" link

**State Management:**
- `execRunning` — disables form, shows spinner
- `execResults[]` — per-browser execution result objects
- `execSummary` — aggregated { total, passed, failed, durationMs }
- `liveStreamFrames{}` — keyed by execution ID, value is base64 frame or URL
- `liveStreamEvents[]` — last 100 events

**Socket.IO Connection:** Connects to `API_BASE` (port 8080). Subscribes to each execution ID. Also handles autonomous navigation state passed via `window.history.state`.

---

#### `Execution/AutonomousRunner.jsx` *(Fully rewritten June 2026)*
**Route:** `/autonomous`

One-click autonomous QA trigger page.

**Input Fields:** Same as before — Target URL, Test Depth, Username, Password, Custom Scenario, Browser Engines. All inputs now use a shared `inputCls` string: `bg-white border-gray-200 text-gray-900` (light) / `bg-slate-950 border-white/10 text-white` (dark), with `focus:ring-2 focus:ring-indigo-200`.

**Browser Engine Chips:**
- **Active:** `bg-indigo-600 text-white border-indigo-600 shadow-md`
- **Inactive:** `bg-white text-gray-900 border-gray-300` with hover to indigo-50

**Feature Toggle Cards (7 cards, 4-col grid):**

| Key | Accent Colour |
|---|---|
| `video` | violet |
| `healing` | indigo |
| `accessibility` | cyan |
| `security` | rose |
| `responsive` | amber |
| `api` | emerald |
| `autoJira` | blue |

**Card States:**
- **Inactive:** `bg-white border-gray-200 shadow-md` — clean white card, hover `–translate-y-1 shadow-xl`
- **Active:** `bg-gradient-to-br from-indigo-50 to-cyan-50 border-indigo-400 shadow-lg` + 3px gradient accent strip at top (`from-indigo-500 via-violet-500 to-cyan-500`)
- **Icon chip:** Per-feature colour (e.g. violet-100 bg + violet-600 icon) when active; gray-100 when inactive
- **Checkmark:** `CheckCircle2` in `text-emerald-600 scale-110 drop-shadow-sm`
- **Title:** `text-gray-900 font-bold` (active) / `text-gray-800` (inactive)
- **Description:** `text-gray-700 font-medium` (active) / `text-gray-600` (inactive)

**Run Button:** `bg-gradient-to-r from-indigo-600 via-violet-600 to-cyan-500`, `hover:scale-[1.01] hover:shadow-2xl`, shimmer sweep `skew-x-12` on hover. Spinner on loading.

**On Submit:** Calls `api.triggerAutonomousQA(payload)` → navigates to `/execution`.

---

#### `Analytics/AutonomousQA.jsx`
**Route:** `/ai-builder`
**File:** `src/pages/Analytics/AutonomousQA.jsx` (195 lines)

AI website crawler and flow generator (separate from the full autonomous runner).

**Left Panel — Discovery Engine:**
- Target URL input with link icon
- "Start Auto-Discovery" button
- Status progression: `idle` → `crawling` (spinner) → `analyzing` (spinner) → `complete`

**Right Panel — Generated User Flows:**
- List of discovered flows, each showing:
  - Flow name + description
  - Flow type badge (violet)
  - First 3 generated steps preview (action + selector/value)
  - "+N more steps" indicator
  - "Export .spec.ts" button — calls `api.generatePlaywrightCode()` and triggers file download

**On load:** Calls `api.getDiscoveredFlows(activeProject.id)` — restores previously discovered flows.

---

#### `Reports/ReportDetails.jsx`
**Route:** `/reports/:runId`
**File:** `src/pages/Reports/ReportDetails.jsx` (very large: 56,566 bytes / ~1,300+ lines)

The most complex page. Detailed execution report viewer.

**Data source:** `api.getRunDetails(runId)` + `api.getExecutionPlan(runId)`

**Sections (tabs or panels):**
1. **Summary header** — Run ID, status badge, test name, browser, duration, timestamps
2. **AI-generated test plan viewer** — Structured plan from the orchestrator
3. **Step-by-step execution log** — Each step with status, selector, action, screenshot
4. **Screenshots gallery** — Thumbnails of execution screenshots from Supabase Storage
5. **Video replay** — Embedded video player for `.mp4` replay
6. **Self-healing events** — Original selector → healed selector pairs
7. **Jira integration** — Ticket ID, URL, sync timestamp if a Jira bug was created
8. **PDF Export** — Uses `jspdf` + `jspdf-autotable` to generate a downloadable report

---

#### `Settings/Settings.jsx` *(Bug-fixed & rewritten June 2026)*
**Route:** `/settings`

Jira integration configuration for the active project.

**Bug fixes applied:**
- `useAuth().currentProject` → `useData().activeProject` ✅
- `showToast` → `triggerToast` ✅
- Page now fully functional

**Form fields:** Jira Base URL, Account Email, API Token, Project Key, Issue Type, Enable Integration checkbox.

**Layout:** `glass-panel card-lift` container with Link2 icon header. Fields arranged in 2-column grid. Labels use `var(--text-secondary)` (near-black in light mode). Inputs use `glass-input` class.

**Actions:**
- `btn-ghost` → "Test Connection" → `POST /api/v1/jira/test`
- `btn-primary` → "Save Configuration" → `POST /api/v1/jira/save`

**Empty state:** Shown when no `activeProject` — floating `Link2` icon + message.

---

#### `Settings/Schedules.jsx`
**Route:** `/schedules`
**File:** `src/pages/Settings/Schedules.jsx` (225 lines)

Cron job scheduler for test suites.

**Create Schedule form fields:**
- Schedule Name
- Environment select: Production, Staging, Development
- Cron Expression input (default: `*/15 * * * *`, with format hint)
- Browser toggle chips: chromium, firefox, webkit, edge

**Schedule cards grid (3-col):**
- Name + "Active" badge
- Cron expression (monospace)
- Browser list
- Environment
- ID (monospace)
- Delete button (Administrators + QA Engineers)

**Guard:** Requires both `activeProject` and `activeSuite` to enable the "New Cron Schedule" button.

---

## 4. Node.js Backend — `/backend-node`

### 4.1 Entry & App Setup

#### `src/index.ts`
Server entry point. Creates the Express app + HTTP server + Socket.IO server. Starts the BullMQ execution worker. Listens on port 8080.

**Key responsibilities:**
- Mounts all API routes under `/api/v1/`
- Initializes Socket.IO with CORS for the frontend origin
- Starts the `executionWorker` (BullMQ job processor)
- Exports `io` for use in routes that emit real-time events

#### `src/app.ts`
Express app configuration:
- `cors()` — allows all origins (or configured origin list)
- `express.json()` — JSON body parsing
- `express-rate-limit` — rate limiter on API routes
- Mounts route modules

#### `src/prisma.ts` / `src/prismaClient.ts`
Creates and exports the singleton `PrismaClient` instance. Used across all route and agent files.

---

### 4.2 Routes — `src/routes/`

All routes are Express routers mounted under `/api/v1/`. All require JWT authentication via the `auth` middleware except where noted.

#### `routes/projects.ts`
| Method | Path | Description |
|---|---|---|
| GET | `/projects` | List all projects for the authenticated user |
| POST | `/projects` | Create a new project |
| DELETE | `/projects/:id` | Delete project (cascades to suites/cases/executions) |

#### `routes/suites.ts`
| Method | Path | Description |
|---|---|---|
| GET | `/projects/:id/suites` | List suites for a project |
| POST | `/projects/:id/suites` | Create a suite |
| DELETE | `/suites/:id` | Delete suite |
| GET | `/suites/:id/cases` | List test cases for a suite |
| POST | `/suites/:id/cases` | Create a test case |
| PUT | `/cases/:id` | Update a test case |
| DELETE | `/cases/:id` | Delete a test case |

#### `routes/executions.ts`
| Method | Path | Description |
|---|---|---|
| POST | `/executions/run-multi-test` | Queue parallel browser executions via BullMQ |
| GET | `/executions/:id` | Get execution log with steps, screenshots, videos, healing events |
| GET | `/executions/:id/trace` | Get Playwright trace data |
| GET | `/executions/:id/plan` | Get AI execution plan data |
| POST | `/executions/:id/cancel` | Cancel a running execution |
| GET | `/runs` | List recent runs (with `?limit=N`) |

#### `routes/dashboard.ts`
| Method | Path | Description |
|---|---|---|
| GET | `/dashboard/summary` | Returns `{ totalExecutions, successRate, passedCount, failedCount, selfHealingCount, avgDuration }` |
| GET | `/dashboard/execution-trend` | Returns per-day pass/fail counts for last N days |
| GET | `/dashboard/browser-distribution` | Returns per-browser execution counts |
| GET | `/dashboard/recent-executions` | Returns recent execution records for the table |

#### `routes/ai.ts`
| Method | Path | Description |
|---|---|---|
| POST | `/ai/generate-suite` | Calls AI agent to generate test suite from text prompt |
| POST | `/ai/run-suite-and-save-report` | Run a suite with AI and save to DB |
| POST | `/ai/generate-playwright` | Generate `.spec.ts` Playwright code from steps |

#### `routes/autonomous.ts`
| Method | Path | Description |
|---|---|---|
| POST | `/autonomous/run` | Triggers the full autonomous QA pipeline |

#### `routes/discovery.ts`
| Method | Path | Description |
|---|---|---|
| POST | `/discovery/crawl/:projectId` | Spider a website using the Python crawler |
| POST | `/discovery/generate-flows/:projectId` | Use AI to generate test flows from crawl data |
| GET | `/discovery/flows/:projectId` | List saved discovered flows |

#### `routes/jira.ts`
| Method | Path | Description |
|---|---|---|
| GET | `/jira/config` | Get Jira config for a project |
| POST | `/jira/save` | Save Jira configuration |
| POST | `/jira/test` | Test Jira API connection |

---

### 4.3 Agents — `src/agents/`

Specialized AI agents that use LangChain + OpenAI GPT-4o-mini. Each agent has a single focused responsibility.

| Agent | File | Responsibility |
|---|---|---|
| `OrchestratorAgent` | `OrchestratorAgent.ts` | Coordinates all other agents; builds the full test execution plan |
| `ExecutionAgent` | `ExecutionAgent.ts` | (39,974 bytes) The main agent driving Playwright via the Python API; handles step execution logic |
| `ScenarioParserAgent` | `ScenarioParserAgent.ts` | Parses free-text test scenarios into structured JSON steps |
| `ScriptGenerationAgent` | `ScriptGenerationAgent.ts` | Generates full Playwright `.spec.ts` files |
| `TestCaseAgent` | `TestCaseAgent.ts` | Generates individual test case objects |
| `PositiveTestGeneratorAgent` | `PositiveTestGeneratorAgent.ts` | Generates happy-path test cases |
| `NegativeTestGeneratorAgent` | `NegativeTestGeneratorAgent.ts` | Generates edge-case/negative test cases |
| `CapabilityAnalyzerAgent` | `CapabilityAnalyzerAgent.ts` | Analyzes a web app's capabilities from DOM |
| `DiscoveryAgent` | `DiscoveryAgent.ts` | (18,344 bytes) Crawls sites and discovers user flows |
| `SelfHealingAgent` | `SelfHealingAgent.ts` | Suggests alternative selectors when a step fails |
| `ReportingAgent` | `ReportingAgent.ts` | Generates AI-written execution reports |
| `ValidationAgent` | `ValidationAgent.ts` | Validates test steps before execution |
| `RequirementsAgent` | `RequirementsAgent.ts` | Extracts requirements from test descriptions |
| `TestDataAgent` | `TestDataAgent.ts` | Generates test data (usernames, emails, etc.) |
| `AccessibilityAgent` | `AccessibilityAgent.ts` | Runs accessibility checks using Axe |
| `SecuritySanityAgent` | `SecuritySanityAgent.ts` | Checks for security issues (HTTPS, form security) |
| `llm.ts` | `llm.ts` | Shared OpenAI/LangChain client setup |
| `test-assertion-healing.ts` | `test-assertion-healing.ts` | Heals failed assertions specifically |

---

### 4.4 Queue — `src/queue/`

#### `executionWorker.ts` (49,965 bytes — largest file in the backend)

The BullMQ worker that processes execution jobs from the Redis queue.

**Responsibilities:**
- Polls `execution-queue` Redis queue for jobs
- For each job: calls the Python FastAPI execution engine, monitors execution, updates `ExecutionLog` in DB
- Emits real-time events to the frontend via Socket.IO: `queued`, `running`, `agent_progress`, `screenshot_uploaded`, `execution_completed`
- After execution: uploads artifacts (screenshots, videos) to Supabase Storage
- Triggers `ReportingAgent` to generate the AI report
- If Jira integration is active and execution failed → calls `JiraService`
- Handles self-healing: calls `SelfHealingAgent` when step fails

**Job payload shape:**
```json
{
  "executionId": "uuid",
  "testName": "string",
  "baseUrl": "string",
  "steps": [...],
  "browser": "chromium",
  "device": "Desktop",
  "projectId": "uuid",
  "suiteId": "uuid | null",
  "testCaseId": "uuid | null"
}
```

---

### 4.5 Services — `src/services/`

#### `JiraService.ts`
Handles Jira API communication:
- `createBugTicket(config, executionLog)` — creates a Jira issue with execution details
- `attachScreenshot(config, issueId, screenshotUrl)` — attaches screenshots to Jira ticket
- `testConnection(config)` — validates Jira credentials

---

### 4.6 Middleware — `src/middleware/`

#### `auth.ts`
Express JWT authentication middleware. Verifies the `Authorization: Bearer <token>` header against Supabase's JWT secret. Attaches `req.user` (with `id`, `email`) to the request. Returns `401` if token is missing or invalid.

---

### 4.7 Lib — `src/lib/`

#### `redis.ts`
Creates and exports the `ioredis` Redis connection using `REDIS_URL` from `.env`. Used by BullMQ for queue management.

---

### 4.8 Orchestrator — `src/orchestrator/`

#### `WorkflowEngine.ts`
Coordinates multi-step agentic workflows. Provides a `run(steps[])` method that executes a sequence of agent calls in order, passing output of one to the input of the next.

---

### 4.9 Utils — `src/utils/`

#### `sanitizer.ts`
Sanitizes AI-generated JSON output to remove markdown code fences (` ```json ` blocks), fix escaped characters, and handle truncated JSON before parsing.

#### `storage.ts`
Supabase Storage helper. Provides `uploadFile(bucket, path, buffer, mimeType)` and `getPublicUrl(bucket, path)` functions. Used by the execution worker to persist screenshots and videos.

---

### 4.10 Database Schema — `prisma/`

#### `prisma/schema.prisma`

**Provider:** `sqlite` (local file `./dev.db`)

**Models:**

```
User
├── id: String (UUID, PK)
├── email: String (unique)
├── name: String?
├── credits: Int (default: 100)
├── createdAt, updatedAt
├── projects: Project[]
├── subscriptions: Subscription[]
└── usage: UsageCredit[]

Subscription
├── id, userId (FK → User)
├── planType: String ("FREE" | "PRO" | "ENTERPRISE")
├── status: String ("ACTIVE")
├── stripeId: String?
└── timestamps

UsageCredit
├── id, userId (FK → User)
├── amount: Int
├── description: String
└── createdAt

Project
├── id, name, description?
├── userId (FK → User)
├── suites: TestSuite[]
├── discoveredFlows: DiscoveredFlow[]
├── jiraIntegration: JiraIntegration?
└── timestamps

TestSuite
├── id, name, description?
├── projectId (FK → Project)
├── tests: TestRun[]
├── executions: ExecutionLog[]
└── timestamps

TestRun
├── id, name, intent, steps: String (JSON)
├── suiteId (FK → TestSuite)
└── timestamps

ExecutionLog
├── id, suiteId (FK → TestSuite)
├── status: String ("PENDING" | "RUNNING" | "PASSED" | "FAILED")
├── browser: String (default: "chromium")
├── durationMs: Int?
├── startedAt, completedAt: DateTime?
├── logs: String? (text log)
├── stepLogs: String? (JSON array of step traces)
├── traceData: String? (Playwright trace)
├── planData: String? (AI plan JSON)
├── reports: Report[]
├── screenshots: Screenshot[]
├── videos: Video[]
├── healingEvents: HealingEvent[]
├── jiraTicketId, jiraTicketUrl: String?
├── jiraAttachmentCount: Int?
├── jiraSyncTimestamp: DateTime?
└── timestamps

JiraIntegration
├── id, projectId (FK → Project, unique)
├── baseUrl, email, apiToken, projectKey
├── issueType: String (default: "Bug")
├── isActive: Boolean
└── timestamps

Screenshot
├── id, executionLogId (FK → ExecutionLog)
├── storagePath, url: String
└── createdAt

Video
├── id, executionLogId (FK → ExecutionLog)
├── storagePath, url: String
└── createdAt

Report
├── id, executionLogId (FK → ExecutionLog)
├── storagePath, url: String
└── createdAt

HealingEvent
├── id, executionLogId (FK → ExecutionLog)
├── originalSelector, healedSelector: String
├── success: Boolean
└── createdAt

DiscoveredFlow
├── id, projectId (FK → Project)
├── name, description?, flowType?
├── steps: String (JSON)
└── createdAt
```

#### `prisma/dev.db`
SQLite database file (9.56 MB). Contains all persisted data for local development.

---

## 5. Python Execution Engine — `/backend`

### 5.1 Entry Points

#### `start.py`
**Main launcher script.** Run with `python start.py` from the `/backend` directory.
- Checks that `.venv/Scripts/python.exe` exists
- Sets default env vars: `AI_ENABLE_TRACE=0`, `AI_ENABLE_VIDEO=0`, `AI_EVIDENCE_LEVEL=minimal`
- Launches: `.venv/Scripts/python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000 --loop asyncio`

#### `start_backend.ps1`
PowerShell equivalent of `start.py`. Sets env vars and launches uvicorn directly.

#### `main.py` (6,667 bytes)
FastAPI application instance. Creates the `FastAPI` app, configures CORS (allows Node backend origin), mounts routers from `api/routes.py`, `api/ai_routes.py`, and `api/discovery_routes.py`.

---

### 5.2 API Routes — `api/`

#### `api/routes.py` (20,542 bytes)
Primary execution and run management routes.

**Key endpoints:**
- `POST /execute` — Execute a test suite (called by Node worker)
- `POST /execute-step` — Execute a single step (used for step-by-step mode)
- `GET /runs/{run_id}` — Get run details
- `GET /runs/{run_id}/steps` — Get step-by-step logs
- `GET /runs/{run_id}/screenshot` — Get screenshot for a step
- `POST /cancel/{run_id}` — Cancel a running execution
- `GET /health` — Health check

#### `api/ai_routes.py` (40,512 bytes — largest Python file)
AI-powered generation endpoints:
- `POST /ai/generate-suite` — Generate test suite JSON from text prompt
- `POST /ai/generate-playwright` — Generate Playwright spec file
- `POST /ai/run-suite` — Execute a generated suite
- `POST /ai/autonomous-run` — Full autonomous pipeline
- WebSocket endpoints for live streaming

#### `api/discovery_routes.py` (2,176 bytes)
Website crawling routes:
- `POST /discovery/crawl/{project_id}` — Crawl a URL
- `POST /discovery/generate-flows/{project_id}` — Generate flows from crawl
- `GET /discovery/flows/{project_id}` — Get saved flows

---

### 5.3 Execution Engine — `execution/`

The core browser automation layer.

| File | Size | Purpose |
|---|---|---|
| `runner.py` | 38,530 bytes | Main test runner; orchestrates Playwright, step execution, self-healing |
| `actions.py` | 36,454 bytes | All Playwright action implementations (click, fill, goto, assert, etc.) |
| `self_healing.py` | 14,709 bytes | Selector healing logic; tries alternative strategies when selectors fail |
| `multi_executor.py` | 6,100 bytes | Parallel execution across multiple browsers |
| `console_handler.py` | 5,747 bytes | Captures browser console logs and errors |
| `selector_utils.py` | 5,322 bytes | CSS/XPath selector utilities and validators |
| `executor_patch.py` | 5,289 bytes | Patches to Playwright executor for edge cases |
| `error_classifier.py` | 5,893 bytes | Classifies execution errors into types (SELECTOR, NETWORK, ASSERTION, etc.) |
| `dom_analyzer.py` | 3,198 bytes | Analyzes DOM structure to find alternative selectors |
| `live.py` | 3,783 bytes | Live frame streaming (base64 screenshots over WebSocket) |
| `artifacts.py` | 2,867 bytes | Saves screenshots, videos, traces to local storage |
| `decision_engine.py` | 985 bytes | Decides next action based on execution state |
| `retry_handler.py` | 991 bytes | Retry logic with backoff for flaky steps |

---

### 5.4 LLM Layer — `llm/`

| File | Purpose |
|---|---|
| `generator.py` | (53,347 bytes) Core LLM prompt templates and OpenAI API calls for test generation |
| `autonomous_generator.py` | Prompt chains for the autonomous QA pipeline |
| `bug_classifier.py` | Classifies test failures as bugs using LLM |

---

### 5.5 Models & Schemas — `models/`

#### `models/schemas.py` (19,091 bytes)
All Pydantic v2 request/response models:
- `ExecuteRequest` — payload for `POST /execute`
- `StepResult` — result of a single step
- `RunResult` — full run result
- `TestCase`, `TestSuite`, `TestStep` — core domain models
- `AutonomousRunRequest` — payload for autonomous pipeline
- `GenerateSuiteRequest/Response` — AI generation models

#### `models/db_models.py` (6,716 bytes)
SQLAlchemy ORM models for the local SQLite database (`qa_platform.db`):
- `Run`, `Step`, `DiscoveredPage`, `UserFlow`

#### `models/database.py` (1,508 bytes)
SQLAlchemy engine and session creation for `qa_platform.db`.

---

### 5.6 Self-Healing — `self_healing/`

#### `self_healing/llm_healer.py` (4,848 bytes)
LLM-powered selector healing. When a Playwright step fails due to selector not found:
1. Takes the failed selector + current DOM snapshot
2. Sends to GPT-4o-mini with a healing prompt
3. Returns an array of alternative selectors to try
4. Stores the successful heal in `HealingEvent` DB record

---

### 5.7 Services — `services/`

| File | Purpose |
|---|---|
| `run_service.py` | Service layer for creating/updating run records in SQLite |
| `project_service.py` | Project and flow persistence in SQLite |
| `crawler.py` | Web crawler using `httpx` to spider pages |
| `scheduler.py` | APScheduler integration for cron job execution |
| `codegen.py` | Playwright code generation from step arrays |

---

### 5.8 Storage — `storage/`

Local file storage structure:
```
storage/
├── artifacts/      # Trace files (.zip)
├── executions/     # Execution JSON result files
├── logs/           # Execution log text files
├── reports/        # JSON report files
├── screenshots/    # PNG screenshots per step
├── platform.db     # Local SQLite for Python service data
└── selector_memory.json  # Cached healed selectors
```

---

### 5.9 Utils — `utils/`

#### `utils/auth.py` (4,051 bytes)
JWT verification for the Python service. Verifies Supabase JWT tokens on incoming requests.

#### `utils/logger.py` (4,657 bytes)
Structured logging setup. Outputs JSON-formatted logs with run ID context.

---

## 6. Environment Variables

### Frontend — `frontend/.env`
| Variable | Example | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://xxx.supabase.co` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_...` | Public Supabase anon key |
| `VITE_API_BASE` | `http://127.0.0.1:8080` | Node.js backend base URL |

### Node Backend — `backend-node/.env`
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (pooled via pgBouncer) |
| `DIRECT_URL` | Direct PostgreSQL URL (for migrations) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (server-side, bypasses RLS) |
| `OPENAI_API_KEY` | OpenAI API key for all AI agents |
| `REDIS_URL` | Redis connection string (Upstash format: `rediss://...`) |
| `OPENAI_MODEL` | Model to use (default: `gpt-4o-mini`) |

### Python Backend — environment only (no `.env` file)
| Variable | Default | Purpose |
|---|---|---|
| `AI_ENABLE_TRACE` | `0` | Enable Playwright trace recording |
| `AI_ENABLE_VIDEO` | `0` | Enable video recording |
| `AI_EVIDENCE_LEVEL` | `minimal` | Evidence capture level (`minimal` / `full`) |
| `AI_BACKEND_HOST` | `127.0.0.1` | Host to bind to |
| `AI_BACKEND_PORT` | `8000` | Port to bind to |

---

## 7. Full API Endpoint Reference

### Authentication (via Supabase — not Express routes)
All routes require `Authorization: Bearer <supabase_jwt>` header.

### Base URL: `http://127.0.0.1:8080/api/v1`

| Method | Endpoint | Description |
|---|---|---|
| GET | `/auth/me` | Get current user profile |
| GET | `/projects` | List projects |
| POST | `/projects` | Create project `{ name, description }` |
| DELETE | `/projects/:id` | Delete project |
| GET | `/projects/:id/suites` | List suites |
| POST | `/projects/:id/suites` | Create suite `{ name, description }` |
| DELETE | `/suites/:id` | Delete suite |
| GET | `/suites/:id/cases` | List test cases |
| POST | `/suites/:id/cases` | Create case `{ name, steps, description }` |
| PUT | `/cases/:id` | Update case `{ name, steps, description }` |
| DELETE | `/cases/:id` | Delete case |
| GET | `/runs` | List runs `?limit=N` |
| POST | `/executions/run-multi-test` | Launch execution `{ test_name, base_url, steps, browsers, devices, environment, project_id, suite_id?, test_case_id? }` |
| GET | `/executions/:id` | Get execution detail |
| GET | `/executions/:id/trace` | Get trace |
| GET | `/executions/:id/plan` | Get AI plan |
| POST | `/executions/:id/cancel` | Cancel execution |
| GET | `/dashboard/summary` | Analytics summary |
| GET | `/dashboard/execution-trend` | `?days=7` trend data |
| GET | `/dashboard/browser-distribution` | Browser breakdown |
| GET | `/dashboard/recent-executions` | `?limit=N` recent runs |
| POST | `/ai/generate-suite` | `{ prompt, base_url }` |
| POST | `/ai/run-suite-and-save-report` | `{ suite, suite_id, base_url, browser, headless }` |
| POST | `/ai/generate-playwright` | `{ suiteName, url, steps }` |
| POST | `/autonomous/run` | `{ targetUrl, credentials, depth, features, browsers, projectId, customScenario? }` |
| POST | `/discovery/crawl/:projectId` | `?base_url=...&max_depth=2` |
| POST | `/discovery/generate-flows/:projectId` | `?base_url=...` |
| GET | `/discovery/flows/:projectId` | Get saved flows |
| GET | `/schedules` | List schedules |
| POST | `/schedules` | Create schedule `{ name, cron_expression, project_id, suite_id, environment, browsers, devices }` |
| DELETE | `/schedules/:id` | Delete schedule |
| GET | `/jira/config` | `?projectId=...` |
| POST | `/jira/save` | Save Jira config |
| POST | `/jira/test` | Test Jira connection |

### WebSocket Events (Socket.IO on port 8080)
| Event (Server → Client) | Payload | Trigger |
|---|---|---|
| `queued` | `{ message, executionId }` | Job added to queue |
| `running` | `{ message, executionId }` | Playwright browser launched |
| `browser_log` | `{ message, executionId }` | Console log from browser |
| `agent_progress` | `{ message, executionId, stepIndex }` | Each agent step completed |
| `screenshot_uploaded` | `{ url, executionId }` | Screenshot saved to Supabase |
| `live_frame` | `{ frame: base64, executionId }` | Live screenshot frame (streaming) |
| `execution_completed` | `{ status, durationMs, executionId }` | Run finished |

---

## 8. UI Design System Reference

This section documents the current design language for reference during redesign.

### Color Palette (Current)

| Role | Tailwind Class | Hex |
|---|---|---|
| Page background | `bg-[#070b13]` / `bg-[#090d16]` | `#070b13` |
| Panel background | `bg-slate-900/40` | semi-transparent dark |
| Primary accent | `from-indigo-600 to-cyan-500` | Indigo → Cyan gradient |
| Secondary accent | `from-violet-600 to-indigo-500` | Violet → Indigo |
| Text primary | `text-white` / `text-slate-100` | White |
| Text secondary | `text-slate-400` | Medium gray |
| Text muted | `text-slate-500` / `text-slate-600` | Dark gray |
| Success | `text-emerald-400`, `bg-emerald-500/10` | Green |
| Error/Danger | `text-rose-400`, `bg-rose-500/10` | Red |
| Warning | `text-amber-400`, `bg-amber-500/10` | Amber |
| Info | `text-cyan-400`, `bg-cyan-500/10` | Cyan |
| Indigo highlight | `text-indigo-400` | Indigo |
| Violet highlight | `text-violet-400` | Violet |

### Typography

| Use | Size | Weight | Font |
|---|---|---|---|
| Page title | `text-2xl` / `text-3xl` | `font-extrabold` | Plus Jakarta Sans |
| Section title | `text-lg` | `font-bold` | Plus Jakarta Sans |
| Body text | `text-sm` | `font-normal` | Plus Jakarta Sans |
| Label | `text-xs` | `font-semibold` uppercase | Plus Jakarta Sans |
| Micro label | `text-[10px]` | `font-bold` uppercase tracked | Plus Jakarta Sans |
| Monospace | `font-mono text-xs` | — | System monospace |

### Component Patterns

**Card:** `glass-panel p-5 rounded-2xl shadow-xl border border-white/5 bg-slate-900/40`

**Button (Primary):** `bg-gradient-to-r from-indigo-600 to-cyan-500 hover:from-indigo-500 hover:to-cyan-400 text-white rounded-xl font-semibold text-xs px-3.5 py-2 transition shadow-lg shadow-indigo-600/20`

**Button (Secondary):** `bg-slate-900 border border-white/10 text-white rounded-xl text-xs font-semibold px-3 py-1.5 hover:bg-slate-800`

**Button (Danger):** `bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 border border-rose-500/50 rounded-xl`

**Input:** `glass-input rounded-xl bg-slate-900 border border-white/10 px-3 py-2 text-sm`

**Status Badge (Success):** `bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 px-2 py-0.5 rounded-full text-[10px] font-bold`

**Status Badge (Failed):** `bg-rose-500/10 border border-rose-500/25 text-rose-400 px-2 py-0.5 rounded-full text-[10px] font-bold`

**Active Sidebar Item:** `bg-gradient-to-r from-indigo-950/60 to-indigo-900/30 text-white border-l-2 border-indigo-500 shadow-md shadow-indigo-950/40`

### Animations Used

| Animation | Usage | Duration |
|---|---|---|
| `animate-spin` | Loading spinners on buttons | Continuous |
| `animate-pulse` | Skeleton loading placeholders | Continuous |
| `animate-float` | Logo icon on AuthPage | 4s loop |
| `animate-pulse-subtle` | — | 3s loop |
| Framer Motion `initial y:20 → 0` | Page headers, auth card | 0.6s |
| Framer Motion `height: 0 → auto` | Create forms expanding | 0.3s |
| Framer Motion `AnimatePresence` | Toast notifications | Slide in/out |

---

## 9. Data Flow Diagrams

### Test Execution Flow

```
1. User fills Execution form on /execution
2. Frontend → POST /api/v1/executions/run-multi-test
3. Node backend creates ExecutionLog records (status: PENDING)
4. Node backend enqueues N jobs (one per browser) into BullMQ/Redis
5. Node backend returns { executionIds: [...] }
6. Frontend connects Socket.IO, subscribes to each executionId
7. BullMQ worker picks up job
8. Worker → POST http://127.0.0.1:8000/execute (Python)
9. Python: launches Playwright browser
10. Python: executes each step, emits live_frame via Socket.IO
11. Python: on step failure → calls self-healing LLM
12. Python: captures screenshots per step
13. Python: returns result JSON to worker
14. Worker: uploads artifacts to Supabase Storage
15. Worker: updates ExecutionLog in SQLite (status: PASSED/FAILED)
16. Worker: calls ReportingAgent for AI report
17. Worker: calls JiraService if jira integration active + execution failed
18. Worker: emits execution_completed via Socket.IO
19. Frontend: shows results, enables "View Report" link
```

### Authentication Flow

```
1. User enters email/password on /auth
2. Frontend → Supabase.auth.signInWithPassword()
3. Supabase returns { session: { access_token, user } }
4. AuthContext stores token via api.setToken(token)
5. Token saved to localStorage('ai_qa_token')
6. All subsequent api.request() calls send Authorization: Bearer <token>
7. Node.js auth middleware verifies JWT against Supabase secret
8. Request passes through to route handlers
```

---

## 10. Running the Platform

### Prerequisites
- Node.js v18+
- Python 3.11+
- Git
- All API keys configured in `backend-node/.env`

### Terminal 1 — Node.js Backend (Port 8080)
```powershell
cd backend-node
npm run dev
```
Starts nodemon watching `src/index.ts`. The BullMQ worker starts automatically.

### Terminal 2 — Python Execution Engine (Port 8000)
```powershell
cd backend

# Activate virtual environment (already exists)
.\.venv\Scripts\Activate.ps1

# Start the FastAPI server
python start.py
```
Starts uvicorn on `http://127.0.0.1:8000`. API docs at `http://127.0.0.1:8000/docs`.

### Terminal 3 — React Frontend (Port 5173)
```powershell
cd frontend
npm run dev
```
Starts Vite dev server. Open `http://localhost:5173` in your browser.

### Default Login
```
Email:    admin@testplatform.ai
Password: admin123
```

### Troubleshooting Quick Reference
| Issue | Fix |
|---|---|
| Redis timeout on Node start | Check `REDIS_URL` in `backend-node/.env`; restart Node server |
| Playwright browser not found | Run `.venv/Scripts/playwright install chromium` in `/backend` |
| Missing AI reports | Verify `OPENAI_API_KEY` in `backend-node/.env` |
| DB schema errors | Run `npx prisma db push` in `/backend-node` |
| Port already in use | Kill the process on 8080/8000/5173 and restart |

---

*Document generated by scanning all source files in the repository. Last updated: June 2026.*
