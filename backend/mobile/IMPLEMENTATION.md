# Apptesting — Implementation & Integration Guide

Android mobile-app testing engine: upload any APK, generate tests (from
natural language, a requirements doc, or a QA test‑case sheet), run them on a
real device or emulator, self‑heal broken locators, and get a report that
maps back to the client's original test cases.

This document is the hand‑off for integrating the engine into a larger
product (new UI + other software features). It covers architecture, the full
API surface, data model, configuration, and the integration seams.

---

## 1. Architecture at a glance

```
┌─────────────┐      REST + WebSocket           ┌──────────────────────────────┐
│  Your UI /  │  ─────────────────────────────▶ │  FastAPI backend  (port 8001)│
│  software   │  ◀───────────────────────────── │  backend/main.py             │
└─────────────┘                                 │   └─ backend/mobile/*        │
                                                └──────┬───────────────────────┘
                                                       │ spawns / drives
                          ┌────────────────────────────┼───────────────────────────┐
                          ▼                            ▼                           ▼
                   ┌────────────┐              ┌──────────────┐            ┌───────────────┐
                   │  Appium 2  │  ─ADB/UIA2─▶ │ Android device│           │  OpenAI API   │
                   │ (on-demand)│              │  or emulator  │           │ (generation + │
                   └────────────┘              │  (on-demand)  │           │  heal assist) │
                                               └──────────────┘            └───────────────┘

  Storage: local disk  backend/storage/mobile/{apks,screenshots,hierarchy,videos,appium_logs}
  DB:      SQLite by default, or Postgres/Supabase if DATABASE_URL is set
           (evidence files ALWAYS live on local disk, never in the DB)
```

**Key properties**

- **Application‑agnostic.** Nothing is hard‑coded to a specific app. The
  engine discovers each APK's screens/elements at runtime.
- **No auth.** The backend has no login/session/tenant concept. CORS is wide
  open (`allow_origins=["*"]`). If you need auth/multi‑tenant, it goes in a
  gateway in front, or is added to `backend/main.py`.
- **Stateless-ish HTTP, stateful runs.** Runs execute in background threads
  inside the backend process. Progress is polled (`GET .../executions/{id}`)
  or streamed (`WS .../executions/{id}/ws`).
- **Single process.** No queue/worker/redis. Concurrency is OS threads.
  Horizontal scaling is not built in.

---

## 2. Repository layout

```
backend/
  main.py                 FastAPI app factory + lifespan (schema, reaper, emulator reaper)
  .env                    secrets + config (NOT committed-safe — contains live keys)
  requirements.txt
  mobile/
    api.py                ALL REST + WebSocket endpoints (router prefix /api/v1/mobile)
    schemas.py            Pydantic request/response contracts + action vocabulary
    models.py             SQLAlchemy ORM models
    database.py           engine/session + additive-migration runner
    engine.py             run_execution() — single test run, golden path + AutoHeal
    suite_engine.py       run_suite() — many tests back-to-back on one session;
                          reap_interrupted_runs() (startup recovery)
    actions.py            ACTION_REGISTRY — TAP / ENTER_TEXT / ASSERT_* / WAIT / ...
    locators.py           hierarchy parsing, multi-strategy + semantic locator resolution,
                          wait_for_stable_content()
    device_manager.py     adb discovery / health / reserve / release
    appium_manager.py     on-demand Appium server + UiAutomator2 session (with retries)
    emulator_manager.py   on-demand AVD lifecycle (opt-in)   ← NEW
    explorer.py           bounded app crawl → ScreenMap; run_exploration()   ← NEW
    automatability.py     "can a UI driver even do this test?" classifier    ← NEW
    ai_gateway.py         the ONLY place OpenAI is called (generation + heal suggestion)
    document_ingest.py    PDF/DOCX/XLSX/TXT → text
    test_import.py        strict CSV/JSON (one row per step) → tests
    batch_generate.py     flexible QA-tracker CSV/XLSX → one AI-generated test per row
    evidence.py           screenshot / hierarchy / video capture + storage
    failure.py            deterministic failure classification
    video.py              adb screenrecord lifecycle
    live.py               per-execution event bus + frame streamer (WebSocket)
    system_dialogs.py     ANR / "app not responding" detection + safe recovery
    healing/
      engine.py           AutoHeal orchestration (analyze → policy → validate → persist)
      candidate_generator.py, scorer.py, policy.py, validator.py, memory.py
  storage/mobile/         runtime artifacts (see §9)

frontend/                 reference UI (React 18 + Vite + Tailwind + framer-motion)
  src/pages/MobileTesting/MobileTesting.jsx   the entire UI, one file
  src/utils/mobileApi.js                      REST + WS client (good API contract reference)

sample-apks/              deskclock-sample.apk (native), vulnbank3.apk (React Native), mda-*.apk
```

---

## 3. Setup

### Prerequisites (host machine)

- **Android SDK** with `platform-tools` (`adb`) and `build-tools` (`aapt`);
  `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) set.
- **Node.js + npm**, and **Appium 2** with the UiAutomator2 driver:
  `npm i -g appium && appium driver install uiautomator2`
- **Python 3.11+**
- A device/emulator — either connected manually via `adb`, **or** an AVD
  present (`emulator -list-avds`) if you use on‑demand emulators (§6).
- **`ffmpeg`** on PATH (optional — only for the stitched whole‑suite video;
  per‑test videos work without it).

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python main.py          # http://localhost:8001  — docs at /docs
```

Port via `PORT` env (default 8001). Runs **without** `--reload` by default —
set `RELOAD=1` for dev (see §10 for why it's off).

### Frontend (reference UI)

```bash
cd frontend
npm install
npm run dev                            # http://localhost:5174
```

`VITE_MOBILE_API_BASE` overrides the backend URL (default `http://127.0.0.1:8001`).

---

## 4. Configuration (env vars)

Set in `backend/.env` (loaded at startup) or the process environment.

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8001` | Backend HTTP port |
| `RELOAD` | off | `1` → uvicorn `--reload` (dev only; see §10) |
| `DATABASE_URL` | local SQLite | Postgres/Supabase URL → uses Postgres instead. `postgres://` is auto‑rewritten to `postgresql://` |
| `OPENAI_API_KEY` | — | Enables AI generation + AI heal‑assist. **Without it, `/tests/generate` and `/tests/generate-batch` return 503**; everything else works |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model for generation + heal suggestion |
| `AI_MODE` | `AI_ALLOWED` | `AI_DISABLED` hard‑off; other values currently behave as allowed |
| `ADB_PATH` | `adb` on PATH | Explicit adb binary |
| `APPIUM_BIN` | auto (`appium.cmd`/`appium`) | Explicit Appium binary |
| `APPIUM_HOST` | — | Use an **externally‑managed** Appium server (`http://host:4723`) instead of on‑demand |
| `APPIUM_START_ON_DEMAND` | `true` | `false` + no `APPIUM_HOST` → error |
| **Emulator lifecycle (opt‑in, §6)** | | |
| `EMULATOR_AUTO_START` | off | `1` → boot an AVD when a run has no device |
| `EMULATOR_AVD` | first of `emulator -list-avds` | Which AVD to launch |
| `EMULATOR_POOL_MAX` | `1` | Max concurrently‑managed emulators |
| `EMULATOR_HEADLESS` | `1` | `0` → show the emulator window |
| `EMULATOR_IDLE_SHUTDOWN_SEC` | `600` | Kill a managed emulator after N s idle; `0` = never |
| `EMULATOR_BOOT_TIMEOUT_SEC` | `240` | Boot wait ceiling |
| `EMULATOR_ACQUIRE_TIMEOUT_SEC` | `300` | Wait for a free device when pool is full |
| `EMULATOR_EXTRA_ARGS` | — | Extra space‑separated `emulator` args |

`.env` currently also contains `SUPABASE_*` keys and a live `OPENAI_API_KEY`
— **rotate these before sharing the repo more widely.** `.gitignore` covers
`.env`.

---

## 5. Data model

SQLAlchemy models in `backend/mobile/models.py`. Tables auto‑create on
startup; new columns are added by a minimal additive migration runner
(`database.py::run_additive_migrations` — `ADD COLUMN` only, never destructive).

| Entity | Table | Notes |
|---|---|---|
| **MobileApplication** | `mobile_applications` | One row per package name |
| **MobileApplicationVersion** | `mobile_application_versions` | One per uploaded APK build (`sha256`). Holds `framework_hint` (NATIVE_VIEWS/COMPOSE/REACT_NATIVE/FLUTTER/WEBVIEW/UNKNOWN), `launchable_activity`, permissions, and the cached **`screen_map`** (JSON) + `screen_map_captured_at` |
| **MobileDevice** | `mobile_devices` | Discovered via `adb`. `status`: AVAILABLE / RESERVED / UNHEALTHY / OFFLINE / QUARANTINED |
| **MobileTest** | `mobile_tests` | `steps` = JSON list of TestStep. `suite_id` (nullable). **`source_meta`** (JSON) carries the origin row: `test_case_id, module, expected_result, type, priority, data, automatable, not_automatable_reason, needs` |
| **MobileTestSuite** | `mobile_test_suites` | A group of tests created together and run as one unit. `status`: QUEUED / RUNNING / COMPLETED / **INTERRUPTED** (backend restarted mid‑run). `combined_video_path`, `source` (CSV_IMPORT / XLSX_BATCH / NL_GENERATE / MANUAL) |
| **MobileExecution** | `mobile_executions` | One run of one test. `status` — see §11. `result_json`, `environment_snapshot` (holds `execution_policy`), `video_path` |
| **MobileStepResult** | `mobile_step_results` | Per‑step outcome: `status` (PASSED/FAILED/HEALED/SKIPPED/BLOCKED), `locator`, `resolved_locator`, `actual`, `failure_id`, `healing_id` |
| **MobileEvidence** | `mobile_evidence` | Immutable artifact rows. `artifact_type`: SCREENSHOT / VIDEO / UI_HIERARCHY / APPIUM_LOG / … `storage_path` is repo‑root‑relative |
| **MobileHealingRecord** | `mobile_healing_records` | One AutoHeal attempt. `status`: PENDING_VALIDATION / APPLIED / VALIDATED / VALIDATION_FAILED / PENDING_APPROVAL / APPROVED / REJECTED / ROLLED_BACK / REQUIRES_REVIEW |
| **MobileFailure** | `mobile_failures` | Classified failure (`category`, `error_code`, `recommended_action`) |
| **MobileLocatorMemory** | `mobile_locator_memory` | Learned locator fixes, reused automatically on later runs |
| **MobileCompatibilityRun** | `mobile_compatibility_runs` | One test fanned out across ≥2 devices concurrently |

### TestStep shape

```jsonc
{
  "action": "TAP",                       // see ACTION vocabulary below
  "locator": {                           // null for actions that don't need one
    "strategy": "resource_id|accessibility_id|text|xpath|class_name|semantic",
    "value": "com.app:id/login_btn",
    "hint": "the login button"           // human description — drives semantic resolution + healing
  },
  "value": "alice@test.com",             // text to type, WAIT ms, keycode, etc.
  "timeout_ms": 8000,
  "risk": "LOW_RISK|MEDIUM_RISK|HIGH_RISK|CRITICAL",
  "expected": "Dashboard is shown"       // for ASSERT_* steps
}
```

`strategy: "semantic"` means "resolve by the human description at run time"
— the engine matches `hint`/`value` against the live screen (role + fuzzy
label/id/desc + proximity to a nearby label). It's the safe default when an
exact identifier isn't known, and what the AI generator emits when it isn't
sure.

### ACTION vocabulary (`schemas.BASELINE_ACTIONS`)

`LAUNCH, TERMINATE, RESTART, RESET_APP, CLEAR_DATA, TAP, DOUBLE_TAP,
LONG_PRESS, ENTER_TEXT, REPLACE_TEXT, APPEND_TEXT, CLEAR_TEXT, DELETE_TEXT,
PRESS_KEY, BACK, HOME, RECENT_APPS, SWIPE, SCROLL, SCROLL_TO_TEXT, DRAG,
PINCH, ZOOM, SET_ORIENTATION, WAIT, WAIT_FOR_ELEMENT, WAIT_FOR_TEXT,
WAIT_FOR_ACTIVITY, WAIT_FOR_GONE, ASSERT_VISIBLE, ASSERT_NOT_VISIBLE,
ASSERT_TEXT, ASSERT_ENABLED, ASSERT_DISABLED, ASSERT_SELECTED,
ASSERT_CHECKED, ASSERT_ATTRIBUTE, ASSERT_ACTIVITY, ASSERT_CRASH_FREE,
TAKE_SCREENSHOT, CAPTURE_HIERARCHY`

The registry is data‑driven (`actions.ACTION_REGISTRY`); adding an action is
one function + one dict entry, no engine change.

### ExecutionPolicy (`schemas.ExecutionPolicy`)

```jsonc
{
  "healing":  { "enabled": true, "auto_apply_threshold": 95.0,
                "review_threshold": 80.0, "critical_action_approval_required": true },
  "evidence": { "screenshot_mode": "IMPORTANT_STEPS",   // NONE|FAILURE_ONLY|IMPORTANT_STEPS|EVERY_STEP|FULL
                "capture_hierarchy_on_failure": true,
                "video_mode": "FULL_TEST" },             // OFF|FAILURE_ONLY|FULL_TEST
  "retry_transient_failures": true,
  "max_retries": 1,
  "step_timeout_ms": 15000,
  "test_timeout_ms": 300000,
  "reset_between_tests": true,          // suite: relaunch app before each test (isolation)
  "clear_data_between_tests": false,    // suite: also wipe app data
  "continue_on_blocked_heal": true      // suite: BLOCK the one test, keep going
}
```

---

## 6. On‑demand emulator lifecycle (`emulator_manager.py`)

**Opt‑in** — inert unless `EMULATOR_AUTO_START=1`.

When a run needs a device and none is connected/free:

1. `acquire_device()` refreshes `adb` discovery and returns any already‑free
   device (physical **or** an emulator someone else started).
2. Otherwise, if under `EMULATOR_POOL_MAX`, it boots a headless AVD
   (`emulator -avd <name> -no-window -no-boot-anim -no-audio -no-snapshot`),
   waits for `adb` registration then `sys.boot_completed`, dismisses the
   keyguard, registers it, and returns it.
3. Otherwise it waits up to `EMULATOR_ACQUIRE_TIMEOUT_SEC` for one to free up.

After a run the device is released; an **idle reaper** thread kills managed
emulators idle > `EMULATOR_IDLE_SHUTDOWN_SEC` (unless RESERVED). On backend
shutdown, `shutdown_all()` kills every managed emulator. **Only emulators the
platform launched are ever killed** — a physical device or externally‑started
emulator is never touched.

Wiring:
- `engine.run_execution` / `suite_engine.run_suite`: acquire when
  `execution.device_id` / `suite.device_id` is null and auto‑start is on.
- `api.create_execution`: no longer 400s on a missing device when auto‑start
  is on — the run provisions one.
- Suite auto‑run paths (`_autorun_possible`) fire without a device when
  auto‑start is on.
- `GET /capabilities` → `features.emulator_auto_start` tells the UI whether
  a device selection is optional.
- `POST /devices/provision` pre‑warms one (for demos).

Verified end‑to‑end: `POST /executions {"test_id": N}` with no device →
Pixel_4 booted headless in ~60 s → full run passed → emulator reaped.

---

## 7. The pipelines

### 7.1 APK ingest

`POST /applications` (multipart `file`) → `apk_inspector` validates + hashes +
`aapt`‑extracts package/version/permissions/activities/**framework_hint** →
`MobileApplication` + `MobileApplicationVersion` rows. Duplicate SHA → returns
the existing version. Response includes a `compatibility_warning` for
Flutter (opaque canvas → locators won't work), React Native, Compose.

### 7.2 App exploration → ScreenMap  (grounding)

`POST /applications/{id}/explore?device_id=N` → background
`explorer.run_exploration()`:

- Cold‑launches the APK, does a **bounded BFS crawl** (default ≤14 screens,
  depth ≤3, ≤6 taps/screen, ≤210 s): dump the accessibility tree, record
  every interactive element (`resource-id` / `text` / `content-desc` /
  widget class + `clickable`/`editable`/`bounds`), plus the **tap‑path** to
  reach each screen. Screens deduped by structural signature.
- Result (`ScreenMap`) is cached on `MobileApplicationVersion.screen_map`.
  Crawl once per APK build; every later generation reuses it.
- Auth‑gated screens are only mapped if reachable without credentials
  (known limitation — see §12).

`GET /applications/{id}/screen-map` returns the cached map.

**Why it matters:** without a ScreenMap the AI invents locators that don't
exist. With it, the model may only use identifiers that literally appear in
the map (anything else must be `strategy: "semantic"`), and it must emit the
real navigation steps.

### 7.3 Test generation — four entry points

| Input | Endpoint | Path | AI? |
|---|---|---|---|
| Natural‑language objective, or a PDF/DOCX/XLSX/TXT requirements doc | `POST /tests/generate` | grounded on ScreenMap; returns a **draft** (`steps` + `warnings`); if a device is available it also saves + auto‑runs as a suite‑of‑one | ✅ |
| Machine‑format CSV/JSON (one row per step, our schema) | `POST /tests/import` | deterministic 1:1 mapping, no AI; multi‑file | ❌ |
| QA test‑case tracker CSV/XLSX (Test Case / Steps / Expected Result — column names vary) | `POST /tests/generate-batch` | background job, one AI‑generated test per row, grounded on ScreenMap, uses the "Test Data" column | ✅ |
| Hand‑built steps | `POST /tests` | direct | ❌ |

All AI output goes through `ai_gateway._sanitize_steps`:
- strip whitespace; drop/convert placeholder locator values
  (`unknown_*`, `<...>`, value == hint, …) → `semantic`;
- `ENTER_TEXT`/`REPLACE_TEXT`/`CLEAR_TEXT` on a non‑editable strategy →
  `semantic` (forces run‑time field resolution);
- collapse runs of empty `WAIT`; default a valueless `WAIT` to 1000 ms;
- cap at 40 steps/test.

Each generated test also gets an **automatability verdict**
(`automatability.classify`): rows describing things a UI driver can't do
(TLS/MITM inspection, clipboard, insecure‑storage/logcat checks,
process‑death, screenshot privacy, backend fault injection, server‑side
authz) are stored with `source_meta.automatable=false` and are **SKIPPED**
(not executed, not counted as failures) at run time, with the reason in the
report.

### 7.4 Single execution (`engine.run_execution`)

`POST /executions` → row created `QUEUED` → background thread:

```
ALLOCATING_DEVICE → (acquire emulator if needed) → reserve → health_check
  → STARTING_APPIUM  (appium_manager.start_server, retried 3×, 120s each)
  → STARTING_SESSION (create_uiautomator2_session, retried 3×)
  → RUNNING → for each step:
        execute (actions.ACTION_REGISTRY)
        on ELEMENT_NOT_FOUND + locator-dependent action + healing enabled:
             HEALING → _attempt_heal:
                 1. fast path: resolve by the step's hint against the LIVE screen,
                    swap in a "semantic" locator, re-run
                 2. else: healing/engine.analyze → memory → deterministic candidates
                    → (optional) 1 AI suggestion → policy → validate → persist
        capture evidence per policy
        classify failure (failure.classify_and_record)
        stop at the first unresolved hard failure
  → PASSED | FAILED | BLOCKED | REQUIRES_REVIEW | INFRA_FAILURE | CANCELLED
  → CLEANUP: quit session, stop Appium, release device, attach appium log
```

`wait_for_stable_content()` (in `locators.py`) is called after LAUNCH / TAP /
BACK — it polls the tree until real content has rendered *and* stopped
changing, so a step never runs against a half‑rendered React‑Native /
Compose screen.

### 7.5 Suite run (`suite_engine.run_suite`)

One Appium server + one session + one device reservation shared across every
test in the suite (≈15–30 s saved per test). Per test:
`RESET_APP` (if `reset_between_tests`) → per‑test screen recording →
`execute_test_steps` → per‑test `result_json` → next test (a failed/blocked
test never stops the suite). After all tests: per‑test videos, optional
ffmpeg‑stitched `combined_video`, shared appium log linked to every execution.

Auto‑run triggers: `POST /tests/import` / `/tests/generate` / `/tests` with a
`device_id` (or with `EMULATOR_AUTO_START`); `/tests/generate-batch` when its
job finishes. Manual: `POST /suites/{id}/run`.

### 7.6 AutoHeal lifecycle

`detect → capture live tree → check learned memory → generate scored
candidates → (AI adds ≤1) → policy decision → validate → execute → persist →
learn`. Policy gates on confidence (`auto_apply_threshold` / `review_threshold`)
and step risk. `CRITICAL` steps never auto‑apply. A `REQUIRES_REVIEW` /
`PENDING_APPROVAL` record surfaces in the UI; `POST /healing/{id}/approve`
authorises the top candidate and queues a re‑run; `.../reject`, `.../rollback`
(un‑learn) also available. A validated fix is written to `MobileLocatorMemory`
and reused automatically on the next run — no approval the second time.

### 7.7 Compatibility runs

`POST /compatibility-runs` (`test_id`, `device_ids` ≥2) fans one test across
several devices with **independent OS threads** (genuinely concurrent), and
returns one per‑device pass/fail report.

---

## 8. REST API reference

Base URL: `http://<host>:8001`  ·  Router prefix: `/api/v1/mobile`  ·  no auth
· CORS `*` · JSON unless noted. Interactive docs at `/docs`, `/redoc`.

### Health & capabilities

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | `{status, service}` — liveness |
| `GET` | `/api/v1/mobile/capabilities` | `features.{autoheal, video, live_view, ai_gateway, emulator_auto_start, …}`. Poll on load to decide UI affordances |

### Applications

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/applications` | multipart: `file` (.apk), optional `project_id` | `{application, version_id, duplicate, compatibility_warning}` |
| `GET` | `/applications` | — | `[ApplicationOut]` (each with `versions[]`) |
| `GET` | `/applications/{id}` | — | `ApplicationOut` |
| `GET` | `/applications/{id}/screen-map` | — | `{application_version_id, captured_at, screen_map}` — 404 if no valid version |
| `POST` | `/applications/{id}/explore` | query `device_id` | `202 {status:"exploring", application_version_id, device_id}` — background crawl |

`ApplicationVersionOut` fields: `id, version_name, version_code, sha256,
size, min_sdk, target_sdk, permissions[], activities[], launchable_activity,
framework_hint, status, validation_error`.

### Devices

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/devices` | — | `[DeviceOut]` — **live `adb` sync on every call**; upserts rows |
| `POST` | `/devices/{id}/health` | — | `{healthy, checks:{adb_connected, boot_completed, package_manager_responsive, storage_available}}` |
| `POST` | `/devices/provision` | — | `202` — boot an on‑demand emulator now. 400 if `EMULATOR_AUTO_START` off |

`DeviceOut`: `id, serial, manufacturer, model, android_version, api_level,
is_emulator, battery_level, battery_status, status, last_health_check`.

### Tests

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/tests` | `TestCreateRequest` (JSON): `name, description?, application_id?, steps[], evidence_policy?, healing_policy?, risk_level, device_id?` | `{id, name, suite_id}` (suite_id set iff auto‑run fired) |
| `GET` | `/tests` | — | `[{id, name, description, application_id, steps, risk_level, created_at}]` |
| `GET` | `/tests/{id}` | — | single test |
| `POST` | `/tests/generate` | multipart: `text?`, `file?` (.pdf/.docx/.xlsx/.txt), `application_id?`, `device_id?` | `{steps[], warnings[], grounded, screen_map_screens, grounding_element_count, automatable, not_automatable_reason, test_id?, suite_id?}`. **503 if no `OPENAI_API_KEY`** |
| `POST` | `/tests/import` | multipart: `files[]` (.csv/.json, our step schema), `device_id?`, `application_id?` | `{created[], errors[], suite_id?}` |
| `POST` | `/tests/generate-batch` | multipart: `file` (.csv/.xlsx QA tracker), `application_id?`, `device_id?` | `201` job object (poll it). **503 if no key** |
| `GET` | `/tests/generate-batch/{job_id}` | — | job: `{id, status: RUNNING\|COMPLETED, filename, detected_columns, total_rows, skipped_rows, processed, has_grounding, grounded_on, screen_map_screens, not_automatable_rows, suite_id, created[], failed[], started_at, completed_at}` (in‑memory — lost on restart) |

### Suites

| Method | Path | Response |
|---|---|---|
| `GET` | `/suites?limit=20` | `[SuiteOut]` |
| `GET` | `/suites/{id}` | `SuiteOut` |
| `POST` | `/suites/{id}/run` | re‑run / run a suite. 409 if already RUNNING; 400 if no device & no auto‑start |

`SuiteOut`:
```jsonc
{
  "id": 3, "name": "VulnBank_Manual_Test_Cases.csv", "source": "XLSX_BATCH",
  "status": "RUNNING|COMPLETED|QUEUED|INTERRUPTED",
  "application_id": 3, "application_name": "com.vulnerablebankapp", "device_id": 1,
  "test_count": 124, "passed_count": 40, "failed_count": 57, "skipped_count": 27,
  "combined_video_url": "/storage/mobile/suite_videos/3/combined.mp4",
  "created_at": "...", "completed_at": null,
  "tests": [
    { "test_id": 632, "name": "VB-001 — Launch application successfully",
      "execution_id": 777, "status": "PASSED", "duration_ms": 21100,
      "video_url": "/storage/mobile/videos/777/recording.mp4",
      "test_case_id": "VB-001", "module": "Authentication", "priority": "Critical",
      "expected_result": "App opens without crash; landing screen renders.",
      "actual_result": "All steps passed.",
      "not_automatable_reason": null }
  ]
}
```

### Executions

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/executions` | `ExecutionCreateRequest`: `test_id, device_id?, device_serial?, application_version_id?, environment="DEV", data_set?, execution_policy?, idempotency_key?` | `201` ExecutionOut (status `QUEUED`). Without a device: 400, unless `EMULATOR_AUTO_START` |
| `GET` | `/executions?limit=50` | — | recent runs (any origin): `[{id, status, test_id, test_name, device_id, started_at, completed_at, duration_ms}]` |
| `GET` | `/executions/{id}` | — | ExecutionOut (poll this for progress) |
| `POST` | `/executions/{id}/cancel` | — | sets `cancel_requested`; the run stops before its next step |
| `GET` | `/executions/{id}/evidence` | — | `[{id, step_index, artifact_type, url, sha256, mime_type, size, captured_at}]` |

`ExecutionOut`:
```jsonc
{
  "id": 777, "execution_uid": "…", "status": "PASSED",
  "test_id": 634, "device_id": 1,
  "started_at": "…", "completed_at": "…", "duration_ms": 21100,
  "result_json": { "status": "PASSED", "step_count": 6, "artifacts": [1,2], "failures": [] },
  "step_results": [
    { "step_index": 0, "action": "LAUNCH", "status": "PASSED",
      "locator": null, "resolved_locator": null, "actual": ".MainActivity",
      "duration_ms": 2381, "failure_id": null, "healing_id": null }
  ]
}
```

### Compatibility runs

| Method | Path | Notes |
|---|---|---|
| `POST` | `/compatibility-runs` | `{test_id, device_ids[≥2], application_version_id?, environment, execution_policy?}` |
| `GET` | `/compatibility-runs?limit=20` | list |
| `GET` | `/compatibility-runs/{id}` | `{id, test_id, test_name, status, device_count, passed_count, devices:[{execution_id, device_id, device_label, status, duration_ms, failure_summary}]}` |

### Healing

| Method | Path | Notes |
|---|---|---|
| `GET` | `/healing/history?test_id=&execution_id=` | `[HealingRecordOut]` |
| `POST` | `/healing/{id}/approve` | authorise top candidate → queues a re‑run → `{status, rerun_execution_id}` |
| `POST` | `/healing/{id}/reject` | — |
| `POST` | `/healing/{id}/rollback` | invalidate a learned locator |

`HealingRecordOut`: `id, execution_id, step_index, original_locator,
candidate_locators[], replacement_locator, confidence, risk_level, status, reason`.

---

## 9. WebSocket live stream

`WS /api/v1/mobile/executions/{execution_id}/ws`

- Connect any time — recent history is **replayed** on connect, so a late tab
  still sees what already happened.
- Client sends nothing meaningful; server pushes JSON messages.
- One message per event. Fields vary by `event`:

| `event` | Payload | Meaning |
|---|---|---|
| `frame` | `{mime_type:"image/png", frame_b64}` | Live device screenshot (~1.4 fps) while RUNNING — render as `data:` URL |
| `status` | `{status, detail?}` | Execution status transitions |
| `step_started` | `{step_index, action, locator}` | |
| `step_completed` | `{step_index, action, status, duration_ms, actual, error}` | |
| `healing_started` | `{step_index, original_locator}` | |
| `healing_result` | `{step_index, healing_id, healed, status}` | |
| `evidence` | `{artifact_type, step_index, url}` | Screenshot / hierarchy / appium log captured |
| `failure` | `{step_index, category, error_code, message}` | |
| `video_ready` | `{url}` | Per‑run recording saved |
| `execution_completed` | `{status, duration_ms, error?, reason?}` | Terminal — safe to close the socket |
| `log` | `{level, message}` | Free‑form |

The reference client: `frontend/src/utils/mobileApi.js` (`mobileWsUrl`) and
`MobileTesting.jsx` (`connectLiveSocket`, `formatLogLine`).

---

## 10. Static files / evidence

`GET /storage/...` serves `backend/storage/` directly (mounted in
`main.py`). Every evidence/video URL the API returns is a repo‑root‑relative
path with a leading `/` (e.g. `/storage/mobile/screenshots/777/step5_….png`)
— prefix with the backend origin. Windows backslashes in stored paths are
normalised to `/` in API responses.

```
backend/storage/
  logs/app.log
  mobile/
    apks/<sha256>.apk
    screenshots/<execution_id>/stepN_<ts>.png
    hierarchy/<execution_id>/stepN_<ts>.xml        (password fields redacted)
    videos/<execution_id>/recording.mp4
    suite_videos/<suite_id>/combined.mp4
    appium_logs/<execution_id>/appium.log
```

Files are immutable and never deleted by the app. There is **no retention /
cleanup job** — plan disk usage (videos dominate).

---

## 11. Status enums

**Execution.status:** `CREATED, QUEUED, ALLOCATING_DEVICE, STARTING_APPIUM,
STARTING_SESSION, RUNNING, HEALING, RETRYING, WAITING_APPROVAL, CLEANUP,
PASSED, FAILED, BLOCKED, CANCELLED, TIMEOUT, INFRA_FAILURE, REQUIRES_REVIEW,
SKIPPED`

Terminal set the engine treats as "done":
`PASSED, FAILED, BLOCKED, CANCELLED, REQUIRES_REVIEW, INFRA_FAILURE`
(+ `SKIPPED` for suite members that are not automatable).

**Suite.status:** `QUEUED, RUNNING, COMPLETED, INTERRUPTED`
**StepResult.status:** `PASSED, FAILED, HEALED, SKIPPED, BLOCKED`
**Device.status:** `AVAILABLE, RESERVED, UNHEALTHY, OFFLINE, QUARANTINED`

---

## 12. Integration notes (for the new UI + surrounding software)

### Auth / multi‑tenant
None exists. Add it as a reverse‑proxy/gateway concern, or bolt middleware
onto `backend/main.py`. `MobileApplication.project_id` and
`MobileTest.project_id` are loose, unenforced ints reserved for a future
project scoping — currently ignored by all queries.

### Progress: poll vs stream
- **Poll** `GET /executions/{id}` (and `/suites/{id}`) every 3–5 s for
  status/step tables. The reference UI polls suites every 5 s.
- **Stream** the WebSocket for the live device frame + event log during a
  run. Both are fine to use together.

### Triggering a run from other software
Minimum path: `POST /applications` (once per APK) → `POST /executions
{test_id}` (with `EMULATOR_AUTO_START=1` you don't even need a device) →
poll `GET /executions/{id}` until terminal → `GET /executions/{id}/evidence`.
For a whole sheet: `POST /tests/generate-batch` → poll the job → poll
`GET /suites/{suite_id}`.

### Idempotency
`POST /executions` accepts `idempotency_key` — a repeat with the same key
returns the original execution instead of starting a new one. Use it if your
caller might retry.

### What the reference UI does that a new UI must cover
`frontend/src/pages/MobileTesting/MobileTesting.jsx` is the full contract in
one file. Sections: APK upload + framework warning + **Explore** button;
device list + health; recent executions (reattach to any run); saved tests;
suites (expandable, per‑test expected‑vs‑actual, SKIPPED badge, Run/Re‑run);
compatibility runs; build/generate/import tabs; live execution panel
(device frame + event log + step list + evidence gallery + video + AutoHeal
approve/reject cards).

### Startup recovery
On boot, `reap_interrupted_runs()` marks any execution/suite left non‑terminal
by a previous crash as `INFRA_FAILURE` / `INTERRUPTED` and releases stuck
device reservations. Nothing auto‑resumes — the user re‑runs via
`POST /suites/{id}/run`.

### Concurrency limits
- One backend process. Parallel executions = OS threads sharing one
  SQLite/Postgres connection pool. SQLite is put in WAL + `busy_timeout` mode
  for this; Postgres handles it natively.
- Appium servers are started per run on ports 4723–4823.
- `EMULATOR_POOL_MAX` caps concurrent managed emulators (default 1 → runs
  queue for the device).
- Not designed for high throughput or multi‑node. For that you'd add a real
  job queue and make device allocation a shared lock.

---

## 13. Known limitations & gotchas

- **AI generation needs `OPENAI_API_KEY`.** No key → `/tests/generate*` return
  503; deterministic `/tests/import` and hand‑built `/tests` still work.
- **Flutter apps** render as one opaque canvas — UiAutomator2 sees nothing;
  locator automation cannot work. The upload response warns about this; the
  ScreenMap will come back nearly empty (which is the honest signal).
- **Auth‑gated screens** aren't crawled unless reachable without credentials.
  A test account isn't wired in yet (`explorer.explore_app` has a reserved
  `credentials=` param). Deep flows (transfers, etc.) lean on run‑time
  semantic resolution + healing instead of the map.
- **Batch job state is in‑memory** (`batch_generate._jobs`). A backend restart
  during generation loses the job (the already‑created tests + suite survive
  in the DB; re‑trigger with `POST /suites/{id}/run`).
- **No evidence retention policy** — disk grows unbounded.
- **Non‑automatable classification is heuristic** (keyword + the tracker's
  `Type` column). It can be over/under‑eager on borderline security rows;
  the reason is always shown so a human can override by editing the test.
- **`ffmpeg` optional** — without it, per‑test suite videos exist but there's
  no stitched whole‑suite video.
- **Compatibility runs need ≥2 real devices** — `EMULATOR_POOL_MAX=1` won't
  satisfy them; raise the pool or connect devices.

### Windows / environment specifics
- Appium is spawned via `cmd.exe` (`shell=True`) because a bare `.cmd` Popen
  on this Node/Python combo intermittently produced a mute, never‑ready
  server. Server start is retried 3× at 120 s; session create 3×.
- `uvicorn --reload` is **off by default** (`RELOAD=1` to enable): the file
  watcher was unreliable here (silently serving stale code) and a reload
  kills any in‑flight run. For a service deployment, keep it off.
- If the emulator/UIA2 server wedges (`socket hang up`, "instrumentation
  process cannot be initialized"): `adb -s <serial> emu kill` (or kill the
  `qemu-system-*` process) and let the on‑demand manager cold‑boot a fresh
  one, or `adb kill-server && adb start-server`.

---

## 14. What changed in this iteration (changelog)

New modules: `explorer.py`, `automatability.py`, `emulator_manager.py`.

- **Live‑app grounding.** `POST /applications/{id}/explore` + cached
  `MobileApplicationVersion.screen_map`; generation now feeds the model the
  real screen/element/navigation map instead of stale hierarchy dumps.
- **AI output sanitization** (`ai_gateway._sanitize_steps`) — placeholder
  locators, label‑as‑locator, whitespace, empty‑WAIT runs, step‑count blowups
  all fixed automatically; every fix recorded in `warnings`.
- **Semantic locator resolution** (`locators.resolve_by_hint`) + `strategy:
  "semantic"` — resolve a step by its human description against the live
  screen (role + nearby‑label matching). `ENTER_TEXT` now always lands on a
  real editable field.
- **`wait_for_stable_content`** — no step runs against a half‑rendered
  screen (RN/Compose cold‑render race).
- **Hint‑first live re‑grounding** in `_attempt_heal` — the common
  "generated locator never matched" case self‑corrects on device, no OpenAI
  call, no learned data.
- **Automatability classifier** — non‑UI‑testable rows are `SKIPPED` with a
  reason instead of producing misleading FAIL/PASS.
- **`source_meta`** on `MobileTest` — test‑case id / expected result / type /
  priority / test data flow through to the suite report (`expected_result`
  vs `actual_result` per row, `skipped_count`).
- **Suite runner:** per‑test app reset (isolation), one‑commit bulk insert of
  execution rows (was ~2 min for 124 rows on remote Postgres), continue‑on‑
  blocked‑heal, `ExecutionPolicy.reset_between_tests` / `continue_on_blocked_heal`.
- **Reliability:** Appium server + session retries; `emulator_manager` with
  idle shutdown; `reap_interrupted_runs()` on startup; `POST /suites/{id}/run`
  manual trigger; `RELOAD` env (default off); `_wait` guard.
- **Frontend:** Test Suites panel (expected/actual, SKIPPED badge, Run/Re‑run),
  Explore button, auto‑select lone device/app, device selection optional when
  `emulator_auto_start`.

---

## 15. Quick verification

```bash
# backend up
curl localhost:8001/health
curl localhost:8001/api/v1/mobile/capabilities

# ingest the sample RN app
curl -F "file=@sample-apks/vulnbank3.apk" localhost:8001/api/v1/mobile/applications

# connect an emulator (or set EMULATOR_AUTO_START=1), then:
curl "localhost:8001/api/v1/mobile/devices"
curl -X POST "localhost:8001/api/v1/mobile/applications/1/explore?device_id=1"
curl localhost:8001/api/v1/mobile/applications/1/screen-map        # after ~1 min

# generate + auto-run one test
curl -F "text=Log in with username alice and password Password123, verify the home screen" \
     -F "application_id=1" -F "device_id=1" \
     localhost:8001/api/v1/mobile/tests/generate

# or the whole client sheet
curl -F "file=@path/to/tracker.csv" -F "application_id=1" -F "device_id=1" \
     localhost:8001/api/v1/mobile/tests/generate-batch
```

The reference UI at `http://localhost:5174` exercises every one of these.
