# AI Testing Platform backend launcher with persistent defaults

$env:AI_ENABLE_TRACE = if ($env:AI_ENABLE_TRACE) { $env:AI_ENABLE_TRACE } else { "0" }
$env:AI_ENABLE_VIDEO = if ($env:AI_ENABLE_VIDEO) { $env:AI_ENABLE_VIDEO } else { "0" }
$env:AI_EVIDENCE_LEVEL = if ($env:AI_EVIDENCE_LEVEL) { $env:AI_EVIDENCE_LEVEL } else { "minimal" }
$env:AI_BACKEND_HOST = if ($env:AI_BACKEND_HOST) { $env:AI_BACKEND_HOST } else { "127.0.0.1" }
$env:AI_BACKEND_PORT = if ($env:AI_BACKEND_PORT) { $env:AI_BACKEND_PORT } else { "8000" }

Write-Host "[INFO] Starting backend with defaults" -ForegroundColor Cyan
Write-Host "[INFO] AI_ENABLE_TRACE=$env:AI_ENABLE_TRACE"
Write-Host "[INFO] AI_ENABLE_VIDEO=$env:AI_ENABLE_VIDEO"
Write-Host "[INFO] AI_EVIDENCE_LEVEL=$env:AI_EVIDENCE_LEVEL"
Write-Host "[INFO] URL=http://$($env:AI_BACKEND_HOST):$($env:AI_BACKEND_PORT)"

$pythonPath = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $pythonPath)) {
  Write-Host "[ERROR] Virtual environment python not found at $pythonPath" -ForegroundColor Red
  exit 1
}

& $pythonPath -m uvicorn main:app --host $env:AI_BACKEND_HOST --port $env:AI_BACKEND_PORT --loop asyncio
