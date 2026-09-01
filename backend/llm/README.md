# AI Test Generation

This module adds natural language test generation capabilities to the AI Test Execution Platform.

## Features

- **Natural Language Input**: Convert plain English test descriptions into executable Playwright tests
- **LLM-Powered**: Uses OpenAI GPT-4 for intelligent test generation
- **Validation**: Pydantic models ensure generated tests are valid and safe
- **Integration**: Seamlessly works with existing execution engine

## API Endpoints

### POST /api/v1/ai/generate-test

Generate a structured test from natural language.

**Request:**
```json
{
  "prompt": "Test login with invalid password on saucedemo"
}
```

**Response:**
```json
{
  "test_name": "Invalid Login Test",
  "base_url": "https://www.saucedemo.com",
  "steps": [
    {"action": "goto", "url": "/"},
    {"action": "fill", "selector": "#user-name", "value": "standard_user"},
    {"action": "fill", "selector": "#password", "value": "wrong_password"},
    {"action": "click", "selector": "#login-button"},
    {"action": "assert_visible", "selector": ".error-message-container"}
  ]
}
```

### POST /api/v1/ai/generate-and-run

Generate and execute a test in one request.

**Request:**
```json
{
  "prompt": "Test successful login",
  "browser": "chromium",
  "headless": true
}
```

**Response:**
```json
{
  "generated_test": {
    "test_name": "Successful Login Test",
    "base_url": "https://www.saucedemo.com",
    "steps": [...]
  },
  "execution_result": {
    "test_name": "Successful Login Test",
    "status": "passed",
    "steps_executed": [...],
    "total_duration_ms": 2500.5,
    ...
  }
}
```

## Supported Actions

The LLM generates tests using these safe, predefined actions:

- `goto`: Navigate to a URL
- `fill`: Fill a form field
- `click`: Click an element
- `assert_visible`: Assert element is visible
- `assert_text`: Assert element contains specific text

## Setup

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Set OpenAI API key:
```bash
export OPENAI_API_KEY="your-api-key-here"
```

3. Start the server:
```bash
python -m uvicorn main:app --reload
```

## Example Usage

### Generate Test Only
```bash
curl -X POST "http://localhost:8000/api/v1/ai/generate-test" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Test adding an item to cart on SauceDemo"}'
```

### Generate and Run
```bash
curl -X POST "http://localhost:8000/api/v1/ai/generate-and-run" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Test login with valid credentials",
    "browser": "chromium",
    "headless": false
  }'
```

## Architecture

```
User Input → LLM Generator → Validation → Execution Engine → Results
```

- **LLM Generator** (`llm/generator.py`): Calls OpenAI API with engineered prompts
- **Validation** (`models/schemas.py`): Pydantic models ensure safety and correctness
- **API Routes** (`api/ai_routes.py`): FastAPI endpoints for generation and execution
- **Integration** (`api/routes.py`): Routes included in main API

## Prompt Engineering

The system uses few-shot learning with examples:

- Successful login flow
- Invalid login flow
- Add to cart flow

This ensures consistent, realistic test generation.

## Safety

- Only predefined actions allowed
- No arbitrary code execution
- Selector validation
- JSON-only output from LLM
- Retry logic for failed generations

## Error Handling

- Invalid JSON from LLM → Retry
- Unsupported actions → Validation error
- Missing fields → Validation error
- OpenAI API errors → Retry with backoff