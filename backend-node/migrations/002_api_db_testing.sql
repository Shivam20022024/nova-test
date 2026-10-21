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
