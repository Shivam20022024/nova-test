-- ============================================================================
-- Product -> Release -> Sprint -> Test Case -> Execution -> Result traceability
-- PHASE 1 — additive data model migration for the shared Supabase Postgres DB.
--
-- HOW THIS REPO MANAGES WEB SCHEMA CHANGES
--   There is no web-side migration runner (Prisma was removed; the hand-written
--   mirror lives in frontend/src/lib/types.ts). Schema changes are applied by
--   hand in the Supabase SQL editor, exactly like
--   backend/mobile/migrations/001_supabase_mobile_schema.sql.
--   Run this whole file there, then tell Claude so Phase 2 (backend) can be
--   verified against the live schema.
--
-- SAFETY
--   Every statement is additive and idempotent (IF NOT EXISTS / guarded DO
--   blocks). Nothing is dropped, renamed, or made NOT NULL on an existing
--   table. The DDL modifies no existing row. Backfill is a SEPARATE, optional,
--   commented-out block at the bottom.
--
-- ID TYPES (verified against the live schema — they are NOT uniform)
--   Release.id                                   = uuid   (native, gen_random_uuid())
--   Project.id / TestSuite.id / TestRun.id /
--   ExecutionLog.id                              = text   ((gen_random_uuid())::text)
--   ExecutionLog.releaseId                       = uuid   (already matches Release.id)
--   -> New keys match the type of whatever they reference:
--        Sprint.id, Sprint.releaseId, ExecutionLog.sprintId,
--        SprintTestCase.sprintId, SprintTestCase.carriedFromSprintId  = uuid
--        ExecutionLog.testRunId, SprintTestCase.testRunId,
--        SprintTestCase.addedByUserId                                 = text
--
-- ON DELETE BEHAVIOUR (see the report for the rationale + the one open decision)
--   Sprint.releaseId              -> Release   ON DELETE CASCADE   (Release owns Sprint, matches repo convention)
--   SprintTestCase.sprintId       -> Sprint    ON DELETE CASCADE   (assignment list belongs to the sprint)
--   SprintTestCase.carriedFromSprintId -> Sprint ON DELETE SET NULL
--   SprintTestCase.testRunId      -> TestRun   ON DELETE CASCADE   *** see NOTE below — change to RESTRICT before applying if you prefer ***
--   ExecutionLog.sprintId         -> Sprint    ON DELETE SET NULL  (mirrors existing ExecutionLog.releaseId -> Release SET NULL)
--   ExecutionLog.testRunId        -> TestRun   ON DELETE SET NULL  (execution history is never destroyed by a definition delete)
--
--   NOTE on SprintTestCase.testRunId:
--     CASCADE keeps the existing DELETE /api/v1/suites/:id/cases/:caseId route
--     working unchanged. Deleting a test case then also removes its "was
--     assigned to Sprint X" rows, BUT every ExecutionLog it produced survives
--     (its testRunId is SET NULL; status / artifacts / sprintId / releaseId
--     stay), so "what actually ran in a sprint and its result" is fully
--     preserved. If you would rather BLOCK deletion of an assigned test case,
--     change this one constraint to ON DELETE RESTRICT before running the file
--     — but note that makes the existing delete route return an error for
--     assigned cases (a behaviour change on an existing endpoint).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- A. RELEASE — extend existing table (nullable columns only)
-- ----------------------------------------------------------------------------
ALTER TABLE public."Release"
  ADD COLUMN IF NOT EXISTS status      text,
  ADD COLUMN IF NOT EXISTS sequence    integer,
  ADD COLUMN IF NOT EXISTS "startDate" timestamptz,
  ADD COLUMN IF NOT EXISTS "endDate"   timestamptz;

COMMENT ON COLUMN public."Release".status IS
  'App-level enum: PLANNED | ACTIVE | RELEASED | ARCHIVED. NULL = legacy row; the API treats NULL as PLANNED and never writes NULL going forward.';
COMMENT ON COLUMN public."Release".sequence IS
  'Ordering within a product. NULL for legacy rows; the API falls back to createdAt ordering when NULL.';

-- ----------------------------------------------------------------------------
-- B. SPRINT — new table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public."Sprint" (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  "releaseId" uuid        NOT NULL,
  name        text        NOT NULL,
  sequence    integer     NOT NULL DEFAULT 0,
  status      text        NOT NULL DEFAULT 'PLANNED',    -- PLANNED | ACTIVE | CLOSED
  "startDate" timestamptz,
  "endDate"   timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "Sprint_pkey" PRIMARY KEY (id),
  CONSTRAINT "Sprint_releaseId_fkey" FOREIGN KEY ("releaseId")
    REFERENCES public."Release"(id) ON DELETE CASCADE
);

-- Sprint names are unique only within a release (not globally).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Sprint_releaseId_name_key') THEN
    ALTER TABLE public."Sprint"
      ADD CONSTRAINT "Sprint_releaseId_name_key" UNIQUE ("releaseId", name);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Sprint_releaseId_idx"          ON public."Sprint" ("releaseId");
CREATE INDEX IF NOT EXISTS "Sprint_releaseId_sequence_idx" ON public."Sprint" ("releaseId", sequence);

-- Reuse the existing updatedAt trigger fn (already on TestRun/TestSuite/ExecutionLog).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'Sprint_updatedAt') THEN
    CREATE TRIGGER "Sprint_updatedAt" BEFORE UPDATE ON public."Sprint"
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- C. SPRINTTESTCASE — new assignment / history table (M:N Sprint <-> TestRun)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public."SprintTestCase" (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  "sprintId"            uuid        NOT NULL,
  "testRunId"           text        NOT NULL,
  "assignmentSource"    text        NOT NULL DEFAULT 'MANUAL',   -- NEW | CARRIED_FORWARD | MANUAL
  "carriedFromSprintId" uuid,
  "addedAt"             timestamptz NOT NULL DEFAULT now(),
  "addedByUserId"       text,
  CONSTRAINT "SprintTestCase_pkey" PRIMARY KEY (id),
  CONSTRAINT "SprintTestCase_sprintId_testRunId_key" UNIQUE ("sprintId", "testRunId"),
  CONSTRAINT "SprintTestCase_sprintId_fkey" FOREIGN KEY ("sprintId")
    REFERENCES public."Sprint"(id) ON DELETE CASCADE,
  CONSTRAINT "SprintTestCase_testRunId_fkey" FOREIGN KEY ("testRunId")
    REFERENCES public."TestRun"(id) ON DELETE CASCADE,        -- *** see header NOTE ***
  CONSTRAINT "SprintTestCase_carriedFromSprintId_fkey" FOREIGN KEY ("carriedFromSprintId")
    REFERENCES public."Sprint"(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "SprintTestCase_sprintId_idx"  ON public."SprintTestCase" ("sprintId");
CREATE INDEX IF NOT EXISTS "SprintTestCase_testRunId_idx" ON public."SprintTestCase" ("testRunId");

-- ----------------------------------------------------------------------------
-- D. EXECUTIONLOG — traceability links (nullable; history-preserving deletes)
-- ----------------------------------------------------------------------------
ALTER TABLE public."ExecutionLog"
  ADD COLUMN IF NOT EXISTS "sprintId"  uuid,
  ADD COLUMN IF NOT EXISTS "testRunId" text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExecutionLog_sprintId_fkey') THEN
    ALTER TABLE public."ExecutionLog" ADD CONSTRAINT "ExecutionLog_sprintId_fkey"
      FOREIGN KEY ("sprintId") REFERENCES public."Sprint"(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExecutionLog_testRunId_fkey') THEN
    ALTER TABLE public."ExecutionLog" ADD CONSTRAINT "ExecutionLog_testRunId_fkey"
      FOREIGN KEY ("testRunId") REFERENCES public."TestRun"(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ExecutionLog_sprintId_idx"  ON public."ExecutionLog" ("sprintId");
CREATE INDEX IF NOT EXISTS "ExecutionLog_testRunId_idx" ON public."ExecutionLog" ("testRunId");

-- ----------------------------------------------------------------------------
-- E. TESTRUN — optional display code (nullable; NO automatic numbering)
-- ----------------------------------------------------------------------------
ALTER TABLE public."TestRun"
  ADD COLUMN IF NOT EXISTS code text;

COMMENT ON COLUMN public."TestRun".code IS
  'Optional human display code (e.g. TC-001). Display-only, never an identity. No auto-numbering in Phase 1.';

COMMIT;

-- ============================================================================
-- OPTIONAL BACKFILL  —  review first, then run as a SEPARATE statement.
-- Links historical executions to a test case ONLY on an unambiguous 1:1 match
-- of (suiteId, testName) -> (TestRun.suiteId, TestRun.name). Never guesses;
-- leaves autonomous / prompt / renamed / ambiguous rows as NULL. sprintId is
-- deliberately NOT backfilled — historical sprints are not invented.
-- ============================================================================
-- UPDATE public."ExecutionLog" e
--    SET "testRunId" = t.id
--   FROM public."TestRun" t
--  WHERE e."testRunId" IS NULL
--    AND e."testName" IS NOT NULL
--    AND t."suiteId" = e."suiteId"
--    AND t.name = e."testName"
--    AND (SELECT count(*) FROM public."TestRun" t2
--          WHERE t2."suiteId" = e."suiteId" AND t2.name = e."testName") = 1;

-- ============================================================================
-- ROLLBACK (if ever needed — every step is reversible)
-- ============================================================================
-- BEGIN;
--   ALTER TABLE public."ExecutionLog" DROP CONSTRAINT IF EXISTS "ExecutionLog_sprintId_fkey";
--   ALTER TABLE public."ExecutionLog" DROP CONSTRAINT IF EXISTS "ExecutionLog_testRunId_fkey";
--   ALTER TABLE public."ExecutionLog" DROP COLUMN IF EXISTS "sprintId";
--   ALTER TABLE public."ExecutionLog" DROP COLUMN IF EXISTS "testRunId";
--   DROP TABLE IF EXISTS public."SprintTestCase";
--   DROP TABLE IF EXISTS public."Sprint";
--   ALTER TABLE public."Release" DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS sequence,
--     DROP COLUMN IF EXISTS "startDate", DROP COLUMN IF EXISTS "endDate";
--   ALTER TABLE public."TestRun" DROP COLUMN IF EXISTS code;
-- COMMIT;
