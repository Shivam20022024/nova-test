-- Apptesting mobile engine — additive schema changes for the shared Supabase
-- Postgres database (same project NOVATEST already uses).
--
-- The mobile_* tables already exist there (they were live before Apptesting
-- was split out into its own product) and match the app's current models
-- almost exactly. This script only adds what's genuinely missing, compared
-- field-by-field against Apptesting/backend/mobile/models.py:
--
--   1. mobile_devices.battery_level / battery_status  — added this session,
--      not yet in the Supabase copy.
--   2. mobile_compatibility_runs                       — a new table, added
--      this session for the multi-device parallel-run feature. Doesn't
--      exist in Supabase at all yet.
--   3. mobile_executions.compatibility_run_id           — links an execution
--      back to the compatibility run that spawned it (if any).
--
-- Every statement below is additive and idempotent (IF NOT EXISTS) — safe to
-- run even if part of it was already applied. Nothing here drops, renames,
-- or alters existing data.
--
-- Run this in the Supabase SQL editor for the project, then let Claude know
-- so it can verify the app is actually wired up to it correctly.

-- 1. Device battery info (mobile/device_manager.py -> adb shell dumpsys battery)
ALTER TABLE public.mobile_devices
  ADD COLUMN IF NOT EXISTS battery_level integer,
  ADD COLUMN IF NOT EXISTS battery_status character varying(20);

-- 2. Compatibility runs: one test fanned out across several devices at once,
--    with a single per-device pass/fail report (mobile/models.py ->
--    MobileCompatibilityRun).
CREATE TABLE IF NOT EXISTS public.mobile_compatibility_runs (
  id serial NOT NULL,
  test_id integer NOT NULL,
  status character varying(20) NOT NULL DEFAULT 'RUNNING',
  created_at timestamp without time zone,
  completed_at timestamp without time zone,
  CONSTRAINT mobile_compatibility_runs_pkey PRIMARY KEY (id),
  CONSTRAINT mobile_compatibility_runs_test_id_fkey FOREIGN KEY (test_id)
    REFERENCES public.mobile_tests(id) ON DELETE CASCADE
);

-- 3. Link executions back to the compatibility run that spawned them (nullable
--    — a normal single-device execution has no compatibility run at all).
ALTER TABLE public.mobile_executions
  ADD COLUMN IF NOT EXISTS compatibility_run_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'mobile_executions_compatibility_run_id_fkey'
  ) THEN
    ALTER TABLE public.mobile_executions
      ADD CONSTRAINT mobile_executions_compatibility_run_id_fkey
      FOREIGN KEY (compatibility_run_id)
      REFERENCES public.mobile_compatibility_runs(id) ON DELETE SET NULL;
  END IF;
END $$;
