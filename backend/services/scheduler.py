"""
Asyncio-based scheduler background service for cron-triggered runs.
"""
from __future__ import annotations

import asyncio
import datetime
import traceback
from sqlalchemy.orm import Session
from models.database import SessionLocal
from models.db_models import Schedule, Suite, TestCase
from utils.logger import get_logger

logger = get_logger("scheduler")

# Set global background loop controller
_scheduler_task: Optional[asyncio.Task] = None
_running = False


async def execute_scheduled_run(schedule_id: int) -> None:
    """Execute a scheduled test suite."""
    db: Session = SessionLocal()
    try:
        schedule = db.query(Schedule).filter(Schedule.id == schedule_id).first()
        if not schedule or not schedule.active:
            return

        suite = db.query(Suite).filter(Suite.id == schedule.suite_id).first()
        if not suite:
            logger.warning("Scheduled suite not found: id=%s", schedule.suite_id)
            return

        logger.info(
            "[SCHEDULER] Triggering execution for Suite=%s Env=%s Browsers=%s",
            suite.name,
            schedule.environment,
            schedule.browsers,
        )

        # Build mock execution mapping since we run headless asynchronously
        # E.g. call the run_multi_test pipeline
        from api.routes import run_multi_test_internal
        from models.schemas import RunConfig
        
        test_cases = db.query(TestCase).filter(TestCase.suite_id == suite.id).all()
        if not test_cases:
            logger.warning("No test cases found in scheduled suite id=%s", suite.id)
            return

        # Re-pack into suite execution JSON format
        suite_payload = {
            "test_suite": {
                "name": suite.name,
                "base_url": schedule.environment,
                "tests": [
                    {
                        "test_name": tc.name,
                        "test_type": "positive",
                        "steps": tc.steps,
                    }
                    for tc in test_cases
                ]
            }
        }

        # Run multi-browser execution in parallel
        # This will trigger database logs automatically!
        await run_multi_test_internal(
            suite=suite_payload,
            browsers=schedule.browsers or ["chromium"],
            devices=schedule.devices or ["Desktop"],
            environment=schedule.environment,
            db=db,
        )

    except Exception as exc:
        logger.error("Error running scheduled execution: %s", exc)
        logger.error(traceback.format_exc())
    finally:
        db.close()


def _should_trigger(cron_exp: str, now: datetime.datetime) -> bool:
    """Evaluate simple cron expressions or keywords without external requirements."""
    cron = cron_exp.strip().lower()
    if cron == "daily":
        return now.hour == 0 and now.minute == 0
    if cron == "weekly":
        return now.weekday() == 0 and now.hour == 0 and now.minute == 0
    
    # Custom simple cron matching for min/hour, e.g., "*/5 * * * *" (every 5 mins)
    try:
        parts = cron.split()
        if len(parts) == 5:
            min_part, hour_part = parts[0], parts[1]
            min_ok = False
            hour_ok = False

            if min_part == "*":
                min_ok = True
            elif min_part.startswith("*/"):
                step = int(min_part.replace("*/", ""))
                min_ok = (now.minute % step) == 0
            else:
                min_ok = now.minute == int(min_part)

            if hour_part == "*":
                hour_ok = True
            else:
                hour_ok = now.hour == int(hour_part)

            return min_ok and hour_ok
    except Exception:
        pass
    
    return False


async def _scheduler_loop() -> None:
    """Core poller polling the datastore every 60 seconds."""
    logger.info("Schedules polling background service started.")
    global _running
    while _running:
        try:
            # Sleep until the start of the next minute to remain synchronized
            now = datetime.datetime.utcnow()
            sleep_sec = 60 - now.second
            await asyncio.sleep(sleep_sec)

            now = datetime.datetime.utcnow()
            db: Session = SessionLocal()
            active_schedules = db.query(Schedule).filter(Schedule.active == True).all()

            for sched in active_schedules:
                if _should_trigger(sched.cron_expression, now):
                    # Launch task in background without blocking other schedules
                    asyncio.create_task(execute_scheduled_run(sched.id))

            db.close()
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Error in scheduler loop: %s", exc)
            await asyncio.sleep(5)


def start_scheduler() -> None:
    """Initialize and start the background scheduler loop."""
    global _scheduler_task, _running
    if _running:
        return
    _running = True
    _scheduler_task = asyncio.create_task(_scheduler_loop())


async def stop_scheduler() -> None:
    """Gracefully cancel and terminate the background loop."""
    global _scheduler_task, _running
    _running = False
    if _scheduler_task:
        _scheduler_task.cancel()
        try:
            await _scheduler_task
        except asyncio.CancelledError:
            pass
        _scheduler_task = None
