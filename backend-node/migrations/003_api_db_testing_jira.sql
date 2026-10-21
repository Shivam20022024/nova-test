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
