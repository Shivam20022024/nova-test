import os from 'os';
import { Worker, Queue, Job } from 'bullmq';
import redisConnection from '../lib/redis';
import { supabase } from '../utils/storage';
import { ApiExecutionAgent } from '../agents/ApiExecutionAgent';
import { DbExecutionAgent } from '../agents/DbExecutionAgent';
import { JiraService } from '../services/JiraService';

/**
 * A queue + worker for API Testing and Database Testing, deliberately
 * separate from queue/executionWorker.ts (Web Testing's queue/worker) and
 * from the ExecutionLog table it writes to. ApiExecutionAgent and
 * DbExecutionAgent are the same standalone, self-contained classes the web
 * worker already imports — reused here unmodified — but nothing about this
 * file touches executionWorker.ts, executions.ts, or ExecutionLog. A bug
 * here cannot affect a Web or Mobile test run.
 *
 * Same dev/prod queue-namespacing pattern as executionWorker.ts (see its
 * comment on localQueueSuffix), under a different base name so the two
 * queues never collide even on the same Redis instance.
 */
const localQueueSuffix = (process.env.QUEUE_NAMESPACE || os.hostname() || 'local')
  .replace(/[^A-Za-z0-9_-]/g, '-');
export const apiDbTestQueueName = process.env.NODE_ENV === 'production'
  ? 'api-db-test-executions'
  : `api-db-test-executions-local-${localQueueSuffix}`;

export const apiDbTestQueue = new Queue(apiDbTestQueueName, {
  connection: redisConnection,
});

type ApiDbJobData = {
  kind: 'API' | 'DB';
  executionId: string;
  steps: unknown[];
  variables?: Record<string, unknown>;
  suiteId?: string;
};

async function cleanupInterruptedJobs() {
  try {
    await supabase
      .from('ApiExecution')
      .update({ status: 'FAILED', error: 'Backend restarted mid-execution.' })
      .in('status', ['QUEUED', 'RUNNING']);
    await supabase
      .from('DbTestExecution')
      .update({ status: 'FAILED', error: 'Backend restarted mid-execution.' })
      .in('status', ['QUEUED', 'RUNNING']);
  } catch (error) {
    console.error('[ApiDbTestWorker Crash Safety] Failed to clean up interrupted jobs:', error);
  }
}

/**
 * Auto-files a Jira bug when a job ends FAILED, mirroring the fire-and-forget
 * pattern executionWorker.ts uses for web (see routes/jira.ts's
 * create-from-api-execution/create-from-db-execution for the manual-button
 * equivalent of this same lookup). Kept entirely inside this file — no other
 * test type's worker or Jira config lookup is touched. Never throws: a Jira
 * outage or missing config must never fail the test job itself.
 */
async function autoFileJiraOnFailure(table: 'ApiExecution' | 'DbTestExecution', kind: 'API' | 'DB', executionId: string, origin: string | undefined) {
  try {
    const { data: execution } = await supabase.from(table).select('*').eq('id', executionId).maybeSingle();
    if (!execution || execution.jiraTicketId) return; // already filed, or row vanished

    const { data: jiraIntegration } = await supabase.from('JiraIntegration').select('*').eq('projectId', execution.projectId).maybeSingle();
    const envUrl = process.env.JIRA_BASE_URL;
    const envEmail = process.env.JIRA_EMAIL;
    const envToken = process.env.JIRA_API_TOKEN;
    const envProject = process.env.JIRA_PROJECT_KEY;
    const useDb = jiraIntegration && jiraIntegration.isActive;
    const useEnv = !useDb && envUrl && envEmail && envToken && envProject;
    if (!useDb && !useEnv) return; // Jira not configured for this project — silently skip, same as the manual route's 400 becomes a no-op here

    const jiraService = new JiraService(
      useDb ? jiraIntegration.baseUrl : envUrl!,
      useDb ? jiraIntegration.email : envEmail!,
      useDb ? jiraIntegration.apiToken : envToken!,
      useDb ? jiraIntegration.projectKey : envProject!,
      useDb ? jiraIntegration.issueType : 'Bug',
    );

    const kindLabel = kind === 'API' ? 'API test' : 'Database test';
    const routeSegment = kind === 'API' ? 'api-testing' : 'db-testing';
    const summary = `[NovaTest AI] ${kindLabel} bug: ${execution.name} failed`;
    const reportUrl = `${origin || 'http://localhost:5173'}/app/${routeSegment}/executions/${executionId}/report`;
    const adfContent = kind === 'API'
      ? JiraService.generateApiBugReportAdf(execution, reportUrl)
      : JiraService.generateDbBugReportAdf(execution, reportUrl);

    const result = await jiraService.createIssue(summary, adfContent);
    if (!result) return;

    await supabase
      .from(table)
      .update({ jiraTicketId: result.key, jiraTicketUrl: result.url, jiraSyncTimestamp: new Date().toISOString() })
      .eq('id', executionId);
    console.log(`[ApiDbTestWorker] Auto-filed Jira bug ${result.key} for ${kind} execution ${executionId}`);
  } catch (err: any) {
    console.error(`[ApiDbTestWorker] Auto Jira filing failed for ${kind} execution ${executionId} (non-fatal):`, err?.message || err);
  }
}

export const initApiDbTestWorker = (io: any) => {
  cleanupInterruptedJobs();

  const apiExecAgent = new ApiExecutionAgent();
  const dbExecAgent = new DbExecutionAgent();

  const worker = new Worker(
    apiDbTestQueueName,
    async (job: Job<ApiDbJobData>) => {
      const { kind, executionId, steps, variables, suiteId } = job.data;
      const table = kind === 'API' ? 'ApiExecution' : 'DbTestExecution';
      const emit = (type: string, payload?: any) => io.to(executionId).emit(type, payload);

      const startedAt = new Date();
      await supabase.from(table).update({ status: 'RUNNING', startedAt: startedAt.toISOString() }).eq('id', executionId);
      emit('queued', { message: 'Job accepted by worker' });

      const logMsg = (_type: string, message: string) => emit('browser_log', { message });

      try {
        const agent = kind === 'API' ? apiExecAgent : dbExecAgent;
        const result = await agent.executeScript(
          executionId,
          JSON.stringify(steps),
          '',
          logMsg,
          { variables, suiteId },
        );

        const completedAt = new Date();
        const status = result.success ? 'PASSED' : 'FAILED';
        await supabase
          .from(table)
          .update({
            status,
            stepLogs: result.stepLogs,
            error: result.error ?? null,
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
          })
          .eq('id', executionId);

        emit('execution_completed', { status });
        if (status === 'FAILED') void autoFileJiraOnFailure(table, kind, executionId, process.env.FRONTEND_ORIGIN);
      } catch (err: any) {
        const completedAt = new Date();
        console.error(`[ApiDbTestWorker] Job ${executionId} failed:`, err);
        await supabase
          .from(table)
          .update({
            status: 'FAILED',
            error: err?.message || 'Unknown error',
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
          })
          .eq('id', executionId);
        emit('execution_completed', { status: 'FAILED' });
        void autoFileJiraOnFailure(table, kind, executionId, process.env.FRONTEND_ORIGIN);
      }
    },
    { connection: redisConnection },
  );

  worker.on('failed', (job, err) => {
    console.error(`[ApiDbTestWorker] Job ${job?.id} raised: ${err.message}`);
  });

  return worker;
};
