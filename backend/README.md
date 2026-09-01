# AI Test Execution Engine

A production-ready, async Playwright-powered test execution backend built with **FastAPI**.

---

## 🚀 Quick Start

### 1. Setup Virtual Environment

```bash
# Create and activate virtual environment
python -m venv .venv
.\.venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

### 2. Install Playwright Browsers

```bash
# Install Playwright browsers (required for test execution)
playwright install
```

### 3. Start the Server

**Windows (Required for Playwright compatibility):**
```bash
# Use the Python startup script (includes stable defaults)
python start.py

# Or use PowerShell launcher with defaults
.\start_backend.ps1
```

**Or manually:**
```bash
# Critical: Use --loop asyncio for Windows Playwright compatibility
uvicorn main:app --host 127.0.0.1 --port 8000 --loop asyncio
```

**Linux/Mac:**
```bash
uvicorn main:app --host 127.0.0.1 --port 8000
```

Default runtime flags in startup scripts:
- `AI_ENABLE_TRACE=0`
- `AI_ENABLE_VIDEO=0`
- `AI_EVIDENCE_LEVEL=minimal`
- `AI_BACKEND_HOST=127.0.0.1`
- `AI_BACKEND_PORT=8000`

### 4. Verify Installation

- **API**: http://127.0.0.1:8000
- **Docs**: http://127.0.0.1:8000/docs
- **Health**: http://127.0.0.1:8000/api/v1/health

---

## ✨ New: AI-Powered Test Generation

Convert natural language descriptions into executable Playwright tests using OpenAI GPT-4.

**Example:** `"Test login with invalid password"` → Structured JSON test with steps, selectors, and assertions.

### AI Endpoints

- `POST /api/v1/ai/generate-test` — Generate test JSON from natural language
- `POST /api/v1/ai/generate-and-run` — Generate and execute in one request

See `llm/README.md` for complete documentation and examples.

---

## Project Structure

```
backend/
├── main.py                   # FastAPI app entry point
├── requirements.txt
├── .env                      # Environment config
├── example_request.json      # Ready-to-use test payload
├── demo_ai.py                # AI generation demo script
│
├── api/
│   ├── routes.py             # POST /api/v1/run-test  |  GET /api/v1/health
│   └── ai_routes.py          # AI generation endpoints
│
├── execution/
│   ├── runner.py             # Browser lifecycle + sequential step orchestration
│   └── actions.py            # Action handlers (goto, fill, click, …)
│
├── llm/
│   ├── generator.py          # OpenAI integration + prompt engineering
│   └── README.md             # AI features documentation
│
├── models/
│   └── schemas.py            # Pydantic request / response models
│
├── utils/
│   └── logger.py             # App logger + per-run in-memory RunLogger
│
└── storage/
    ├── screenshots/          # PNG captures (failure + on-demand)
    └── logs/                 # Per-run .log files
```

---

## Supported Actions

| Action           | Required fields          | Optional fields              |
|------------------|--------------------------|------------------------------|
| `goto`           | `url`                    | —                            |
| `fill`           | `selector`, `value`      | —                            |
| `click`          | `selector`               | —                            |
| `wait_for`       | —                        | `selector`, `timeout`        |
| `assert_visible` | `selector`               | `retries`                    |
| `screenshot`     | —                        | `name`                       |

Every step also supports:
- `retries` (0–5) — automatic retry with exponential back-off
- `capture_screenshot: true` — save a screenshot after this specific step
- `timeout` — per-step timeout override (ms)

---

## Quick Start

### 1. Create & activate a virtual environment

```powershell
# Windows PowerShell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2. Install dependencies

```powershell
pip install -r requirements.txt
```

### 3. Set up AI features (optional)

Create a `.env` file with your OpenAI API key:

```bash
echo "OPENAI_API_KEY=your-api-key-here" > .env
```

### 4. Install Playwright browsers

```powershell
playwright install chromium
# or install all:  playwright install
```

### 4. Start the server

```powershell
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Interactive API docs → **http://localhost:8000/docs**

---

## Running AI-Generated Tests

### Generate Test from Natural Language

```bash
curl -X POST http://localhost:8000/api/v1/ai/generate-test \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Test login with invalid password on SauceDemo"}'
```

### Generate and Run in One Request

```bash
curl -X POST http://localhost:8000/api/v1/ai/generate-and-run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Test successful login on SauceDemo",
    "browser": "chromium",
    "headless": true
  }'
```

### Run the Demo Script

```powershell
python demo_ai.py
```

---

## Running a Test

### via curl

```bash
curl -X POST http://localhost:8000/api/v1/run-test \
  -H "Content-Type: application/json" \
  -d @example_request.json
```

### via PowerShell

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:8000/api/v1/run-test" `
  -ContentType "application/json" `
  -InFile "example_request.json"
```

### via Python (httpx)

```python
import httpx, json

with open("example_request.json") as f:
    payload = json.load(f)

r = httpx.post("http://localhost:8000/api/v1/run-test", json=payload, timeout=120)
print(r.json())
```

---

## Example Request (`example_request.json`)

```json
{
  "test_name": "Login Error Flow",
  "base_url": "https://the-internet.herokuapp.com",
  "headless": true,
  "browser": "chromium",
  "default_timeout": 30000,
  "steps": [
    { "action": "goto",           "url": "/login" },
    { "action": "assert_visible", "selector": "#username" },
    { "action": "fill",           "selector": "#username", "value": "tomsmith" },
    { "action": "fill",           "selector": "#password", "value": "wrongpassword" },
    { "action": "click",          "selector": "button[type='submit']" },
    { "action": "assert_visible", "selector": "#flash.error", "retries": 2 }
  ]
}
```

---

## Example Response

```json
{
  "test_name": "Login Error Flow",
  "status": "passed",
  "steps_executed": [
    {
      "step_index": 0,
      "action": "goto",
      "status": "passed",
      "duration_ms": 1243.5,
      "screenshot_path": null,
      "error": null,
      "retries_used": 0,
      "logs": ["[17:40:01.123] INFO    | goto → https://the-internet.herokuapp.com/login"]
    }
  ],
  "error": null,
  "screenshot_path": null,
  "logs": ["...full run log lines..."],
  "total_duration_ms": 4312.8,
  "browser": "chromium",
  "base_url": "https://the-internet.herokuapp.com"
}
```

---

## Health Check

```bash
curl http://localhost:8000/api/v1/health
# {"status":"ok","service":"ai-test-execution-engine"}
```

---

## Extending with New Actions

1. Add a new value to `ActionType` enum in `models/schemas.py`
2. Implement `handle_<action>` in `execution/actions.py` with the standard signature
3. Register it in the `ACTION_HANDLERS` dict at the bottom of `actions.py`

That's it — no changes needed to the runner or API layer.

---

## Non-Functional Highlights

| Concern              | Implementation                                              |
|----------------------|-------------------------------------------------------------|
| No flaky waits       | `locator.wait_for(state="visible")` before every interact   |
| Deterministic nav    | `wait_until="domcontentloaded"` on every `goto`             |
| Configurable timeout | Per-run `default_timeout` + per-step `timeout` override     |
| Retry mechanism      | Exponential back-off, configurable 0–5 retries per step     |
| Failure screenshot   | Always captured on step failure, saved to `storage/screenshots/` |
| Isolated contexts    | Fresh `BrowserContext` per run — no state leakage           |
| Async throughout     | All I/O is `async/await` — no blocking calls                |
| Structured logging   | Rotating file handler + per-run in-memory buffer            |
