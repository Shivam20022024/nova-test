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
