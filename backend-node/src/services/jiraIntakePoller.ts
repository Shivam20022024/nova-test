import { supabase } from '../utils/storage';
import { pollProject } from './jiraIntakeService';

/**
 * Jira Intake background poller.
 *
 * A single in-process interval, same spirit as the Python engine's
 * services/scheduler.py "Schedules polling background service". Deliberately
 * NOT a BullMQ worker: it does no heavy work itself (it just calls Jira and
 * hands any run off to the existing autonomous queue), and keeping it out of
 * the queue system means a bug here can never wedge web/api/db execution.
 *
 * It is completely inert until a project opts in:
 *   - JiraIntakeConfig.enabled defaults to false, so an un-configured install
 *     makes zero Jira calls.
 *   - JIRA_INTAKE_DISABLED=1 in the environment stops it starting at all.
 */

const TICK_MS = 60_000;
const KILL_SWITCH = process.env.JIRA_INTAKE_DISABLED === '1' || process.env.JIRA_INTAKE_DISABLED === 'true';

let running = false;
let timer: NodeJS.Timeout | null = null;

async function tick() {
  if (running) return; // never overlap
  running = true;
  try {
    const { data: configs, error } = await supabase
      .from('JiraIntakeConfig')
      .select('projectId, enabled, pollIntervalMinutes, lastPolledAt')
      .eq('enabled', true);
    if (error) throw error;

    const now = Date.now();
    for (const cfg of configs || []) {
      const due =
        !cfg.lastPolledAt ||
        now - new Date(cfg.lastPolledAt).getTime() >= (cfg.pollIntervalMinutes || 5) * 60_000;
      if (!due) continue;
      try {
        const summary = await pollProject(cfg.projectId);
        if (summary.found > 0) {
          console.log(
            `[JiraIntakePoller] ${cfg.projectId}: found=${summary.found} queued=${summary.queued} skipped=${summary.skipped} errors=${summary.errors}`,
          );
        }
      } catch (err: any) {
        console.error(`[JiraIntakePoller] pollProject(${cfg.projectId}) failed:`, err?.message || err);
      }
    }
  } catch (err: any) {
    console.error('[JiraIntakePoller] tick failed:', err?.message || err);
  } finally {
    running = false;
  }
}

export function initJiraIntakePoller() {
  if (KILL_SWITCH) {
    console.log('[JiraIntakePoller] disabled via JIRA_INTAKE_DISABLED — not starting.');
    return;
  }
  if (timer) return;
  console.log(`[JiraIntakePoller] started (tick every ${TICK_MS / 1000}s; only polls projects with intake enabled).`);
  // Small delay so it never races server startup / the first request.
  setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), TICK_MS);
  }, 15_000);
}
