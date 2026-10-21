-- ============================================================================
-- NovaTest AI - setup for the NEW Supabase project (laxanxnxmjboccyjbbly)
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
--
-- Part 0 creates what the new project is missing that migration 001 assumes
--   already exists: the "Release" table, ExecutionLog."releaseId" and the
--   set_updated_at() trigger function. Everything is idempotent.
-- Parts 1-5 are migrations 001-005 unchanged, in order.
-- ============================================================================

-- ---------------------------------------------------------------- PART 0 ---
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW."updatedAt" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public."Release" (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  "projectId"   text        NOT NULL REFERENCES public."Project"(id) ON DELETE CASCADE,
  name          text        NOT NULL,
  description   text,
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  "updatedAt"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "Release_pkey" PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS "Release_projectId_idx" ON public."Release" ("projectId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'Release_updatedAt') THEN
    CREATE TRIGGER "Release_updatedAt" BEFORE UPDATE ON public."Release"
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

ALTER TABLE public."ExecutionLog" ADD COLUMN IF NOT EXISTS "releaseId" uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExecutionLog_releaseId_fkey') THEN
    ALTER TABLE public."ExecutionLog" ADD CONSTRAINT "ExecutionLog_releaseId_fkey"
      FOREIGN KEY ("releaseId") REFERENCES public."Release"(id) ON DELETE SET NULL;
  END IF;
END $$;


-- ============ PART: 001_traceability_sprints.sql ============
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

-- ============ PART: 002_api_db_testing.sql ============
-- ============================================================================
-- API Testing & Database Testing — new, isolated results tables.
--
-- WHY SEPARATE FROM ExecutionLog
--   Web testing's execution pipeline (ExecutionLog + the shared BullMQ queue
--   in queue/executionWorker.ts) is deliberately NOT reused here. These two
--   new test types get their own results tables and their own queue/worker
--   (queue/apiDbTestWorker.ts) so a bug in this feature can never reach Web
--   or Mobile testing's execution path. DbConnection, ApiSchemaBaseline and
--   DbSchemaBaseline already exist in this database (verified directly) —
--   this migration does not touch them.
--
-- HOW THIS REPO MANAGES WEB SCHEMA CHANGES
--   Same convention as 001_traceability_sprints.sql: no migration runner,
--   run this whole file by hand in the Supabase SQL editor.
--
-- SAFETY
--   Every statement is additive and idempotent (CREATE TABLE IF NOT EXISTS).
--   Nothing existing is altered, dropped, or renamed.
--
-- ID TYPES (matching existing convention — see 001_traceability_sprints.sql)
--   Project.id = text, Release.id = uuid, Sprint.id = uuid
-- ============================================================================

CREATE TABLE IF NOT EXISTS "ApiExecution" (
  id            text PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "projectId"   text NOT NULL REFERENCES "Project"(id) ON DELETE CASCADE,
  "releaseId"   uuid REFERENCES "Release"(id) ON DELETE SET NULL,
  "sprintId"    uuid REFERENCES "Sprint"(id) ON DELETE SET NULL,
  name          text NOT NULL,
  steps         jsonb NOT NULL,
  variables     jsonb,
  status        text NOT NULL DEFAULT 'QUEUED',
  "stepLogs"    jsonb,
  error         text,
  "startedAt"   timestamptz,
  "completedAt" timestamptz,
  "durationMs"  integer,
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  "createdBy"   text
);

CREATE INDEX IF NOT EXISTS "ApiExecution_projectId_idx" ON "ApiExecution" ("projectId");
CREATE INDEX IF NOT EXISTS "ApiExecution_createdAt_idx" ON "ApiExecution" ("createdAt" DESC);

CREATE TABLE IF NOT EXISTS "DbTestExecution" (
  id             text PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "projectId"    text NOT NULL REFERENCES "Project"(id) ON DELETE CASCADE,
  "releaseId"    uuid REFERENCES "Release"(id) ON DELETE SET NULL,
  "sprintId"     uuid REFERENCES "Sprint"(id) ON DELETE SET NULL,
  "connectionId" text REFERENCES "DbConnection"(id) ON DELETE SET NULL,
  name           text NOT NULL,
  steps          jsonb NOT NULL,
  variables      jsonb,
  status         text NOT NULL DEFAULT 'QUEUED',
  "stepLogs"     jsonb,
  error          text,
  "startedAt"    timestamptz,
  "completedAt"  timestamptz,
  "durationMs"   integer,
  "createdAt"    timestamptz NOT NULL DEFAULT now(),
  "createdBy"    text
);

CREATE INDEX IF NOT EXISTS "DbTestExecution_projectId_idx" ON "DbTestExecution" ("projectId");
CREATE INDEX IF NOT EXISTS "DbTestExecution_createdAt_idx" ON "DbTestExecution" ("createdAt" DESC);

-- ============ PART: 003_api_db_testing_jira.sql ============
-- ============================================================================
-- API Testing & Database Testing — Jira ticket-filing columns.
-- Additive only: new nullable columns on the two tables this feature already
-- owns (ApiExecution, DbTestExecution). No existing table touched.
-- ============================================================================

ALTER TABLE "ApiExecution" ADD COLUMN IF NOT EXISTS "jiraTicketId" text;
ALTER TABLE "ApiExecution" ADD COLUMN IF NOT EXISTS "jiraTicketUrl" text;
ALTER TABLE "ApiExecution" ADD COLUMN IF NOT EXISTS "jiraSyncTimestamp" timestamptz;

ALTER TABLE "DbTestExecution" ADD COLUMN IF NOT EXISTS "jiraTicketId" text;
ALTER TABLE "DbTestExecution" ADD COLUMN IF NOT EXISTS "jiraTicketUrl" text;
ALTER TABLE "DbTestExecution" ADD COLUMN IF NOT EXISTS "jiraSyncTimestamp" timestamptz;

-- ============ PART: 004_ci_trigger_metadata.sql ============
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

-- ============ PART: 005_jira_intake.sql ============
-- ============================================================================
-- Jira Intake — "a bug raised in Jira triggers a NovaTest run".
--
-- WHY
--   Today the Jira integration is one-way: a failed run files a bug
--   (services/JiraService.ts + the auto-file block in queue/executionWorker.ts).
--   This adds the reverse: a poller (src/services/jiraIntakePoller.ts) watches a
--   Jira project for issues carrying a trigger label, an LLM agent
--   (agents/JiraIssueAnalysisAgent.ts) turns the bug + its linked user stories
--   into test scenarios, and the run goes through the SAME autonomous pipeline
--   (/api/v1/autonomous/run). When it finishes, NovaTest comments the result
--   back on the issue.
--
-- SAFETY
--   Purely additive and idempotent. Four nullable columns on ExecutionLog and
--   two new tables. Nothing existing is altered, dropped, or made NOT NULL.
--   The feature is inert until a project row in JiraIntakeConfig sets
--   enabled = true, so applying this migration changes no behaviour on its own.
--
-- HOW THIS REPO MANAGES WEB SCHEMA CHANGES
--   Same convention as 001–004 in this folder: there is no web-side migration
--   runner. Run this whole file by hand in the Supabase SQL editor, then tell
--   Claude so the backend can be verified against the live schema.
--
-- ID TYPES (matching existing convention — see 002_api_db_testing.sql)
--   Project.id = text
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- A. EXECUTIONLOG — where a Jira-triggered run came from (nullable columns).
--    `triggeredBy` already exists (004_ci_trigger_metadata.sql); Jira runs
--    write the value 'jira' into it, alongside 'manual' / 'ci'.
-- ----------------------------------------------------------------------------
ALTER TABLE public."ExecutionLog"
  ADD COLUMN IF NOT EXISTS "jiraSourceIssueKey"   text,
  ADD COLUMN IF NOT EXISTS "jiraSourceReporter"   text,
  ADD COLUMN IF NOT EXISTS "jiraSourceSummary"    text,
  ADD COLUMN IF NOT EXISTS "jiraResultCommentUrl" text;

COMMENT ON COLUMN public."ExecutionLog"."jiraSourceIssueKey" IS
  'e.g. OCQ-142 — the Jira bug whose creation triggered this run. NULL on every non-Jira run.';
COMMENT ON COLUMN public."ExecutionLog"."jiraResultCommentUrl" IS
  'Permalink to the result comment NovaTest posted back on the source issue. NULL until posted.';

CREATE INDEX IF NOT EXISTS "ExecutionLog_jiraSourceIssueKey_idx"
  ON public."ExecutionLog" ("jiraSourceIssueKey");

-- ----------------------------------------------------------------------------
-- B. JIRAINTAKECONFIG — one row per Project. The feature is OFF until a row
--    here sets enabled = true.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public."JiraIntakeConfig" (
  id                    text        NOT NULL DEFAULT (gen_random_uuid())::text,
  "projectId"           text        NOT NULL,
  enabled               boolean     NOT NULL DEFAULT false,
  "triggerLabel"        text        NOT NULL DEFAULT 'novatest-run',
  "defaultTargetUrl"    text,
  "testUsername"        text,
  "testPassword"        text,          -- AES-256-GCM via src/lib/crypto.ts (never plaintext)
  "defaultBrowsers"     jsonb       NOT NULL DEFAULT '["chromium"]'::jsonb,
  "pollIntervalMinutes" integer     NOT NULL DEFAULT 5,
  "postResultComment"   text        NOT NULL DEFAULT 'always',   -- always | on_failure | off
  "addTestedLabel"      boolean     NOT NULL DEFAULT true,
  "minConfidence"       text        NOT NULL DEFAULT 'medium',   -- medium | high
  "lastPolledAt"        timestamptz,
  "createdAt"           timestamptz NOT NULL DEFAULT now(),
  "updatedAt"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "JiraIntakeConfig_pkey" PRIMARY KEY (id),
  CONSTRAINT "JiraIntakeConfig_projectId_key" UNIQUE ("projectId"),
  CONSTRAINT "JiraIntakeConfig_projectId_fkey" FOREIGN KEY ("projectId")
    REFERENCES public."Project"(id) ON DELETE CASCADE
);

-- Reuse the existing updatedAt trigger fn (already on TestRun/TestSuite/Sprint/…).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'JiraIntakeConfig_updatedAt') THEN
    CREATE TRIGGER "JiraIntakeConfig_updatedAt" BEFORE UPDATE ON public."JiraIntakeConfig"
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- C. JIRAINTAKEISSUE — one row per Jira issue the poller has seen. Dedupe
--    (an issue is processed once) plus an audit trail of what the AI decided.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public."JiraIntakeIssue" (
  id               text        NOT NULL DEFAULT (gen_random_uuid())::text,
  "projectId"      text        NOT NULL,
  "issueKey"       text        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued',   -- queued | analyzing | running | done | skipped | error
  reason           text,
  "analysisJson"   jsonb,                                   -- the TestIntent the agent produced
  "executionIds"   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  "issueUpdatedAt" timestamptz,                             -- Jira's `updated` when we processed it
  "processedAt"    timestamptz,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "JiraIntakeIssue_pkey" PRIMARY KEY (id),
  CONSTRAINT "JiraIntakeIssue_projectId_issueKey_key" UNIQUE ("projectId", "issueKey"),
  CONSTRAINT "JiraIntakeIssue_projectId_fkey" FOREIGN KEY ("projectId")
    REFERENCES public."Project"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "JiraIntakeIssue_projectId_idx"  ON public."JiraIntakeIssue" ("projectId");
CREATE INDEX IF NOT EXISTS "JiraIntakeIssue_createdAt_idx"  ON public."JiraIntakeIssue" ("createdAt" DESC);

COMMIT;

-- ============================================================================
-- ROLLBACK (every step is reversible)
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public."JiraIntakeIssue";
--   DROP TABLE IF EXISTS public."JiraIntakeConfig";
--   ALTER TABLE public."ExecutionLog"
--     DROP COLUMN IF EXISTS "jiraSourceIssueKey",
--     DROP COLUMN IF EXISTS "jiraSourceReporter",
--     DROP COLUMN IF EXISTS "jiraSourceSummary",
--     DROP COLUMN IF EXISTS "jiraResultCommentUrl";
-- COMMIT;
