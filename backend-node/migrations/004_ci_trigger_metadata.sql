-- ============================================================================
-- CI/CD trigger metadata on ExecutionLog.
--
-- WHY
--   routes/ci.ts already lets an external CI pipeline (GitHub Actions, etc.)
--   trigger a web test run over HTTP via the same run-multi-test endpoint a
--   person clicking "Run" in the UI uses. Today that run is indistinguishable
--   from a manual one once it lands in ExecutionLog — this migration adds the
--   columns needed to tag it, so the UI can show a "CI" badge + commit/branch
--   instead of a silo. See routes/executions.ts's ciCols() and the Command
--   Center's Recent Executions section for what reads/writes these.
--
-- SAFETY
--   Purely additive — four nullable columns with a safe default on the one
--   that matters for existing rows. Nothing existing is altered or dropped.
--   Every current row gets triggeredBy = 'manual' and renders exactly as
--   before; only rows the ci.ts routes write set 'ci' + the other three.
--
-- HOW THIS REPO MANAGES WEB SCHEMA CHANGES
--   Same convention as prior migrations in this folder — no migration
--   runner, applied by hand (or via a one-off script against DATABASE_URL).
-- ============================================================================

ALTER TABLE "ExecutionLog" ADD COLUMN IF NOT EXISTS "triggeredBy" text NOT NULL DEFAULT 'manual';
ALTER TABLE "ExecutionLog" ADD COLUMN IF NOT EXISTS "commitSha" text;
ALTER TABLE "ExecutionLog" ADD COLUMN IF NOT EXISTS "branch" text;
ALTER TABLE "ExecutionLog" ADD COLUMN IF NOT EXISTS "prNumber" text;
