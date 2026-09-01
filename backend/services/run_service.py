"""
SaaS Dashboard metrics engine and TestRun CRUD transactions.
"""
from __future__ import annotations

import datetime
from typing import Any, Dict, List, Optional
from sqlalchemy import func
from sqlalchemy.orm import Session
from models.db_models import TestRun


def create_test_run(
    db: Session,
    run_id: str,
    project_id: int,
    browser: str,
    status: str,
    duration_ms: int,
    suite_id: Optional[int] = None,
    test_case_id: Optional[int] = None,
    device: Optional[str] = None,
    environment: str = "Production",
    error: Optional[str] = None,
    error_type: Optional[str] = None,
    screenshot_url: Optional[str] = None,
    video_url: Optional[str] = None,
    trace_url: Optional[str] = None,
    execution_result: Optional[Dict[str, Any]] = None,
) -> TestRun:
    run = TestRun(
        run_id=run_id,
        project_id=project_id,
        suite_id=suite_id,
        test_case_id=test_case_id,
        browser=browser,
        device=device,
        environment=environment,
        status=status.lower(),
        duration_ms=duration_ms,
        error=error,
        error_type=error_type,
        screenshot_url=screenshot_url,
        video_url=video_url,
        trace_url=trace_url,
        execution_result=execution_result,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def get_test_runs(
    db: Session,
    project_id: Optional[int] = None,
    suite_id: Optional[int] = None,
    limit: int = 100,
) -> List[TestRun]:
    query = db.query(TestRun)
    if project_id is not None:
        query = query.filter(TestRun.project_id == project_id)
    if suite_id is not None:
        query = query.filter(TestRun.suite_id == suite_id)
    return query.order_by(TestRun.created_at.desc()).limit(limit).all()


def get_dashboard_summary(db: Session, project_id: Optional[int] = None) -> Dict[str, Any]:
    query = db.query(TestRun)
    if project_id is not None:
        query = query.filter(TestRun.project_id == project_id)

    runs = query.all()
    total_executions = len(runs)
    passed_count = sum(1 for r in runs if r.status == "passed")
    failed_count = sum(1 for r in runs if r.status == "failed")
    
    success_rate = round((passed_count / total_executions * 100), 1) if total_executions > 0 else 0

    self_healing_count = 0
    durations = []

    for r in runs:
        if r.duration_ms:
            durations.append(r.duration_ms)

        res = r.execution_result or {}
        steps = res.get("steps_executed") or []
        for step in steps:
            if step.get("healed") or step.get("memory_used"):
                self_healing_count += 1

    avg_duration = round(sum(durations) / len(durations) / 1000.0, 2) if durations else 0

    return {
        "totalExecutions": total_executions,
        "successRate": success_rate,
        "selfHealingCount": self_healing_count,
        "avgDuration": avg_duration,
        "passedCount": passed_count,
        "failedCount": failed_count
    }


def get_execution_trend(db: Session, project_id: Optional[int] = None, days: int = 7) -> List[Dict[str, Any]]:
    query = db.query(TestRun)
    if project_id is not None:
        query = query.filter(TestRun.project_id == project_id)
        
    runs = query.all()
    
    history_buckets = {}
    # Initialize past N days with 0
    today = datetime.datetime.utcnow().date()
    for i in range(days - 1, -1, -1):
        d = today - datetime.timedelta(days=i)
        history_buckets[d.isoformat()] = {"passed": 0, "failed": 0}

    for r in runs:
        if not r.created_at:
            continue
        date_iso = r.created_at.date().isoformat()
        if date_iso in history_buckets:
            if r.status == "passed":
                history_buckets[date_iso]["passed"] += 1
            elif r.status == "failed":
                history_buckets[date_iso]["failed"] += 1

    trend = []
    for date_iso, counts in history_buckets.items():
        trend.append({
            "date": date_iso,
            "passed": counts["passed"],
            "failed": counts["failed"]
        })
        
    return trend


def get_browser_distribution(db: Session, project_id: Optional[int] = None) -> List[Dict[str, Any]]:
    query = db.query(TestRun)
    if project_id is not None:
        query = query.filter(TestRun.project_id == project_id)
        
    runs = query.all()
    browsers = {}
    for r in runs:
        b = r.browser.capitalize() if r.browser else "Unknown"
        browsers[b] = browsers.get(b, 0) + 1

    dist = [{"browser": k, "count": v} for k, v in browsers.items()]
    # Sort descending
    dist.sort(key=lambda x: x["count"], reverse=True)
    return dist


def get_recent_executions(db: Session, project_id: Optional[int] = None, limit: int = 15) -> List[Dict[str, Any]]:
    query = db.query(TestRun)
    if project_id is not None:
        query = query.filter(TestRun.project_id == project_id)
        
    runs = query.order_by(TestRun.created_at.desc()).limit(limit).all()
    
    recent_runs = []
    for r in runs:
        project_name = r.project.name if r.project else "Unknown Project"
        test_name = "Unknown Test"
        if r.execution_result and r.execution_result.get("test_name"):
            test_name = r.execution_result.get("test_name")
        elif r.test_case:
            test_name = r.test_case.name

        recent_runs.append({
            "id": r.id,
            "run_id": r.run_id,
            "testName": test_name,
            "projectName": project_name,
            "browser": r.browser,
            "status": r.status,
            "duration": round(r.duration_ms / 1000.0, 2) if r.duration_ms else 0,
            "startedAt": r.created_at.isoformat() if r.created_at else None,
            "finishedAt": r.created_at.isoformat() if r.created_at else None # Simplified assuming completion time is close
        })
        
    return recent_runs

def get_run_by_id(db: Session, run_id: str) -> Optional[Dict[str, Any]]:
    # Try looking up by the string run_id first
    r = db.query(TestRun).filter(TestRun.run_id == run_id).first()
    # Fallback to integer primary key if run_id is numeric
    if not r and run_id.isdigit():
        r = db.query(TestRun).filter(TestRun.id == int(run_id)).first()
        
    if not r:
        return None
        
    project_name = r.project.name if r.project else "Unknown Project"
    test_name = "Unknown Test"
    if r.execution_result and r.execution_result.get("test_name"):
        test_name = r.execution_result.get("test_name")
    elif r.test_case:
        test_name = r.test_case.name

    return {
        "id": r.id,
        "run_id": r.run_id,
        "testName": test_name,
        "projectName": project_name,
        "browser": r.browser,
        "device": r.device,
        "environment": r.environment,
        "status": r.status,
        "duration_ms": r.duration_ms,
        "duration": round(r.duration_ms / 1000.0, 2) if r.duration_ms else 0,
        "startedAt": r.created_at.isoformat() if r.created_at else None,
        "finishedAt": r.created_at.isoformat() if r.created_at else None,
        "error": r.error,
        "error_type": r.error_type,
        "screenshot_url": r.screenshot_url,
        "video_url": r.video_url,
        "trace_url": r.trace_url,
        "execution_result": r.execution_result
    }

