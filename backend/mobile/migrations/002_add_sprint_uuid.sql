-- Apptesting mobile engine — additive schema change for the shared Supabase
-- Postgres database.
--
-- Adds mobile_executions.sprint_uuid, mirroring the existing release_uuid
-- column exactly (a loose soft-reference to the web-side "Sprint" table's id
-- — written and read by this app, never enforced as a real FK, since Sprint
-- lives in a different schema/codebase (backend-node/Supabase) than this
-- table). Lets a mobile test run be tagged with a sprint the same way it can
-- already be tagged with a release.
--
-- Additive and idempotent (IF NOT EXISTS) — safe to run even if part of it
-- was already applied. Nothing here drops, renames, or alters existing data.
--
-- Run this in the Supabase SQL editor for the project, then let Claude know
-- so it can verify the app is actually wired up to it correctly.

ALTER TABLE public.mobile_executions
  ADD COLUMN IF NOT EXISTS sprint_uuid character varying(36);
