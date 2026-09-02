import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { supabase } from '../utils/storage';

const router = Router();
router.use(authenticate);

/**
 * Counts ExecutionLog rows matching `filters`, optionally scoped to a project.
 * When `projectId` is set, TestSuite is joined with `!inner` so PostgREST will
 * let us filter on the joined column (`suite.projectId`) — the Supabase
 * equivalent of Prisma's `where: { suite: { projectId } }`.
 */
export async function countExecutions(projectId: string | undefined, filters: (q: any) => any) {
  let query = projectId
    ? supabase.from('ExecutionLog').select('id, suite:TestSuite!inner(projectId)', { count: 'exact', head: true }).eq('suite.projectId', projectId)
    : supabase.from('ExecutionLog').select('*', { count: 'exact', head: true });
  query = filters(query);
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

/**
 * Same idea as countExecutions, but for the mobile engine's tables. Those
 * live in the SAME physical Supabase Postgres database as ExecutionLog (see
 * backend/mobile/migrations/001_supabase_mobile_schema.sql header comment) —
 * just a different, SQLAlchemy-owned table namespace with no FK to
 * ExecutionLog. mobile_applications.project_uuid is the ONLY scoping anchor
 * in that schema (mobile_tests/mobile_executions reach a project only by way
 * of application_id — see backend/mobile/models.py's comment on
 * MobileApplication.project_uuid), so scoping here mirrors exactly how
 * backend/mobile/api.py's own `_scoped_application_ids` does it, just via a
 * 2-hop embedded PostgREST filter instead of a SQLAlchemy subquery.
 */
export async function countMobileExecutions(projectId: string | undefined, filters: (q: any) => any) {
  let query = projectId
    ? supabase
        .from('mobile_executions')
        .select('id, test:mobile_tests!inner(application:mobile_applications!inner(project_uuid))', { count: 'exact', head: true })
        .eq('test.application.project_uuid', projectId)
    : supabase.from('mobile_executions').select('*', { count: 'exact', head: true });
  query = filters(query);
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

router.get('/summary', async (req, res) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    // Optional (integration plan Phase 4): filter web counts down to one
    // test classification (SMOKE/SANITY/REGRESSION/E2E/FUNCTIONAL). Mobile
    // executions have no equivalent column, so the mobile side of this
    // summary is intentionally left unfiltered when testType is set,
    // exactly like recentDefectCount's disclosed mobile gap below.
    const testType = req.query.testType as string | undefined;
    // Optional: scope this whole summary down to one named Release instead
    // of a project's whole history — same idea as testType, applied to both
    // web (releaseId) and mobile (release_uuid), since both now carry it.
    const releaseId = req.query.releaseId as string | undefined;
    const withTestType = (q: any) => (testType ? q.eq('testType', testType) : q);
    const withRelease = (q: any) => (releaseId ? q.eq('releaseId', releaseId) : q);
    const withMobileRelease = (q: any) => (releaseId ? q.eq('release_uuid', releaseId) : q);

    const totalExecutions = await countExecutions(projectId, (q) => withRelease(withTestType(q)));
    const passedCount = await countExecutions(projectId, (q) => withRelease(withTestType(q)).in('status', ['PASSED', 'COMPLETED']));
    const failedCount = await countExecutions(projectId, (q) => withRelease(withTestType(q)).eq('status', 'FAILED'));

    let selfHealingQuery = projectId
      ? supabase
          .from('HealingEvent')
          .select('id, executionLog:ExecutionLog!inner(suite:TestSuite!inner(projectId))', { count: 'exact', head: true })
          .eq('executionLog.suite.projectId', projectId)
      : supabase.from('HealingEvent').select('*', { count: 'exact', head: true });
    const { count: selfHealingCount, error: healError } = await selfHealingQuery;
    if (healError) throw healError;

    // Calculate average duration
    let durationQuery = projectId
      ? supabase.from('ExecutionLog').select('durationMs, suite:TestSuite!inner(projectId)').eq('suite.projectId', projectId)
      : supabase.from('ExecutionLog').select('durationMs');
    const { data: completedExecutions, error: durError } = await durationQuery.not('durationMs', 'is', null);
    if (durError) throw durError;

    let avgDuration = 0;
    if (completedExecutions && completedExecutions.length > 0) {
      const sum = completedExecutions.reduce((acc, curr: any) => acc + (curr.durationMs || 0), 0);
      avgDuration = Math.round((sum / completedExecutions.length) / 1000);
    }

    const successRate = totalExecutions === 0 ? 0 : Math.round((passedCount / totalExecutions) * 100);

    // Mobile side of the same summary. Kept as best-effort: the mobile engine
    // is a separate service (see backend/mobile), and its tables should never
    // be able to break the web dashboard if something's off with them.
    let mobile = { totalExecutions: 0, passedCount: 0, failedCount: 0, selfHealingCount: 0, successRate: 0, avgDuration: 0 };
    try {
      const mobileTotal = await countMobileExecutions(projectId, (q) => withMobileRelease(q));
      const mobilePassed = await countMobileExecutions(projectId, (q) => withMobileRelease(q).eq('status', 'PASSED'));
      const mobileFailed = await countMobileExecutions(projectId, (q) => withMobileRelease(q).in('status', ['FAILED', 'INFRA_FAILURE']));

      let mobileHealingQuery = projectId
        ? supabase
            .from('mobile_healing_records')
            .select('id, execution:mobile_executions!inner(test:mobile_tests!inner(application:mobile_applications!inner(project_uuid)))', { count: 'exact', head: true })
            .eq('execution.test.application.project_uuid', projectId)
        : supabase.from('mobile_healing_records').select('*', { count: 'exact', head: true });
      const { count: mobileHealingCount, error: mobileHealError } = await mobileHealingQuery;
      if (mobileHealError) throw mobileHealError;

      let mobileDurationQuery = projectId
        ? supabase
            .from('mobile_executions')
            .select('duration_ms, test:mobile_tests!inner(application:mobile_applications!inner(project_uuid))')
            .eq('test.application.project_uuid', projectId)
        : supabase.from('mobile_executions').select('duration_ms');
      const { data: mobileCompleted, error: mobileDurError } = await mobileDurationQuery.not('duration_ms', 'is', null);
      if (mobileDurError) throw mobileDurError;

      let mobileAvgDuration = 0;
      if (mobileCompleted && mobileCompleted.length > 0) {
        const sum = mobileCompleted.reduce((acc, curr: any) => acc + (curr.duration_ms || 0), 0);
        mobileAvgDuration = Math.round((sum / mobileCompleted.length) / 1000);
      }

      mobile = {
        totalExecutions: mobileTotal,
        passedCount: mobilePassed,
        failedCount: mobileFailed,
        selfHealingCount: mobileHealingCount || 0,
        successRate: mobileTotal === 0 ? 0 : Math.round((mobilePassed / mobileTotal) * 100),
        avgDuration: mobileAvgDuration,
      };
    } catch (mobileErr) {
      console.error('Error fetching mobile summary (non-fatal, web summary unaffected):', mobileErr);
    }

    const combinedTotal = totalExecutions + mobile.totalExecutions;
    const combinedPassed = passedCount + mobile.passedCount;

    res.json({
      totalExecutions,
      passedCount,
      failedCount,
      selfHealingCount: selfHealingCount || 0,
      successRate,
      avgDuration,
      mobile,
      combined: {
        totalExecutions: combinedTotal,
        passedCount: combinedPassed,
        failedCount: failedCount + mobile.failedCount,
        selfHealingCount: (selfHealingCount || 0) + mobile.selfHealingCount,
        successRate: combinedTotal === 0 ? 0 : Math.round((combinedPassed / combinedTotal) * 100),
      },
    });
  } catch (err: any) {
    console.error('Error fetching summary:', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

router.get('/execution-trend', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const projectId = req.query.projectId as string | undefined;
    const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    let query = projectId
      ? supabase.from('ExecutionLog').select('status, createdAt, suite:TestSuite!inner(projectId)').eq('suite.projectId', projectId)
      : supabase.from('ExecutionLog').select('status, createdAt');
    const { data: executions, error } = await query.gte('createdAt', threshold.toISOString());
    if (error) throw error;

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    // Use an array to maintain strict chronological order
    const trendData: { date: string, passed: number, failed: number }[] = [];

    // Initialize the last N days with zero to ensure empty days appear on graph in order
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayStr = dayNames[d.getDay()] as string;
      // If days > 7, append date to distinguish
      const displayStr = days > 7 ? `${d.getMonth() + 1}/${d.getDate()}` : dayStr;

      trendData.push({ date: displayStr, passed: 0, failed: 0 });
    }

    const bucket = (createdAt: string, status: string, isPassed: boolean, isFailed: boolean) => {
      const d = new Date(createdAt);
      d.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const diffTime = today.getTime() - d.getTime();
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

      // Map it to the correct bucket backwards
      const index = (days - 1) - diffDays;
      if (index >= 0 && index < days) {
        const item = trendData[index];
        if (item) {
          if (isPassed) item.passed++;
          else if (isFailed) item.failed++;
        }
      }
    };

    (executions || []).forEach((ex: any) => {
      bucket(ex.createdAt, ex.status, ex.status === 'PASSED' || ex.status === 'COMPLETED', ex.status === 'FAILED');
    });

    // Mobile side of the same trend, bucketed into the same day series.
    // Best-effort — a mobile-side failure must not blank the web trend.
    try {
      let mobileQuery = projectId
        ? supabase
            .from('mobile_executions')
            .select('status, created_at, test:mobile_tests!inner(application:mobile_applications!inner(project_uuid))')
            .eq('test.application.project_uuid', projectId)
        : supabase.from('mobile_executions').select('status, created_at');
      const { data: mobileExecutions, error: mobileError } = await mobileQuery.gte('created_at', threshold.toISOString());
      if (mobileError) throw mobileError;

      (mobileExecutions || []).forEach((ex: any) => {
        bucket(ex.created_at, ex.status, ex.status === 'PASSED', ex.status === 'FAILED' || ex.status === 'INFRA_FAILURE');
      });
    } catch (mobileErr) {
      console.error('Error fetching mobile execution trend (non-fatal, web trend unaffected):', mobileErr);
    }

    res.json(trendData);
  } catch (err: any) {
    console.error('Error fetching execution trend:', err);
    res.status(500).json({ error: 'Failed to fetch execution trend' });
  }
});

router.get('/browser-distribution', async (req, res) => {
  try {
    const projectId = req.query.projectId as string | undefined;

    let query = projectId
      ? supabase.from('ExecutionLog').select('browser, suite:TestSuite!inner(projectId)').eq('suite.projectId', projectId)
      : supabase.from('ExecutionLog').select('browser');
    const { data: rows, error } = await query;
    if (error) throw error;

    // Aggregate client-side (replaces Prisma's groupBy — same result, and
    // still merges the null/chromium default the way the original did).
    const merged: Record<string, number> = {};
    (rows || []).forEach((row: any) => {
      const browser = row.browser || 'chromium';
      merged[browser] = (merged[browser] || 0) + 1;
    });

    const finalDist = Object.entries(merged)
      .map(([browser, count]) => ({ browser, count }))
      .sort((a, b) => b.count - a.count);

    res.json(finalDist);
  } catch (err: any) {
    console.error('Error fetching browser distribution:', err);
    res.status(500).json({ error: 'Failed to fetch browser distribution' });
  }
});

router.get('/recent-executions', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 25;
  const projectId = req.query.projectId as string | undefined;
  try {
    // Fetch a wider raw window than `limit` — an Excel batch can contain
    // many ExecutionLog rows that all collapse into a single folder card,
    // so we need enough raw rows on hand to still fill `limit` cards after
    // grouping.
    const rawTake = Math.min(limit * 20, 500);

    let query = projectId
      ? supabase
          .from('ExecutionLog')
          .select('*, suite:TestSuite!inner(name, projectId, project:Project!inner(name))')
          .eq('suite.projectId', projectId)
      : supabase.from('ExecutionLog').select('*, suite:TestSuite(name, projectId, project:Project(name))');

    const { data: runs, error } = await query
      .order('createdAt', { ascending: false })
      .limit(rawTake);
    if (error) throw error;

    // Executions that came from the same Excel upload share an
    // `excelBatchId` — group those into one folder card instead of
    // listing every scenario individually. Non-Excel runs (manual JSON /
    // natural-language) are untouched and stay as individual cards.
    const items: any[] = [];
    const folderIndex = new Map<string, any>();

    for (const run of (runs || []) as any[]) {
      const passed = run.status === 'PASSED' || run.status === 'COMPLETED';
      const failed = run.status === 'FAILED' || run.status === 'BLOCKED';
      const durationSec = run.durationMs ? Math.round(run.durationMs / 1000) : 0;

      if (run.excelBatchId) {
        let folder = folderIndex.get(run.excelBatchId);
        if (!folder) {
          folder = {
            type: 'folder',
            source: 'web',
            id: run.excelBatchId,
            batchId: run.excelBatchId,
            name: run.excelBatchName || 'Excel Import',
            projectName: run.suite.project.name,
            count: 0,
            passed: 0,
            failed: 0,
            totalDuration: 0,
            startedAt: run.startedAt,
            executions: [],
          };
          folderIndex.set(run.excelBatchId, folder);
          items.push(folder);
        }
        folder.count += 1;
        if (passed) folder.passed += 1;
        else if (failed) folder.failed += 1;
        folder.totalDuration += durationSec;
        folder.executions.push({
          id: run.id,
          run_id: run.id,
          testName: run.testName || run.suite.name,
          browser: run.browser || 'chromium',
          status: run.status.toLowerCase(),
          duration: durationSec,
          startedAt: run.startedAt,
        });
      } else {
        items.push({
          type: 'execution',
          source: 'web',
          id: run.id,
          run_id: run.id,
          testName: run.testName || run.suite.name,
          browser: run.browser || 'chromium',
          projectName: run.suite.project.name,
          status: run.status.toLowerCase(),
          duration: durationSec,
          startedAt: run.startedAt,
        });
      }
    }

    // Mobile side of the same feed. Each row maps onto the same 'execution'
    // shape web items use (device model standing in for 'browser'), tagged
    // source: 'mobile' so the frontend can badge/filter it — best-effort,
    // same as the summary/trend endpoints above.
    try {
      let mobileQuery = projectId
        ? supabase
            .from('mobile_executions')
            .select('id, status, duration_ms, created_at, device:mobile_devices(model, serial), test:mobile_tests!inner(name, application:mobile_applications!inner(name, project_uuid))')
            .eq('test.application.project_uuid', projectId)
        : supabase
            .from('mobile_executions')
            .select('id, status, duration_ms, created_at, device:mobile_devices(model, serial), test:mobile_tests(name, application:mobile_applications(name))');

      const { data: mobileRuns, error: mobileError } = await mobileQuery
        .order('created_at', { ascending: false })
        .limit(rawTake);
      if (mobileError) throw mobileError;

      (mobileRuns || []).forEach((run: any) => {
        items.push({
          type: 'execution',
          source: 'mobile',
          id: run.id,
          run_id: run.id,
          testName: run.test?.name || `Mobile test ${run.id}`,
          browser: run.device?.model || run.device?.serial || 'device',
          projectName: run.test?.application?.name || 'Mobile',
          status: String(run.status || '').toLowerCase(),
          duration: run.duration_ms ? Math.round(run.duration_ms / 1000) : 0,
          startedAt: run.created_at,
        });
      });
    } catch (mobileErr) {
      console.error('Error fetching mobile recent executions (non-fatal, web list unaffected):', mobileErr);
    }

    items.sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());

    res.json(items.slice(0, limit));
  } catch (err: any) {
    console.error('Error fetching recent executions:', err);
    res.status(500).json({ error: 'Failed to fetch recent executions' });
  }
});

/**
 * GET /release-readiness — a plain-language GO / GO_WITH_RISK / NO_GO
 * recommendation, built entirely from data this platform already tracks.
 * No new table, no live Jira API call, no black-box scoring model — just
 * three fixed, disclosed rules over the most recent `window` executions
 * (web + mobile combined) for a project:
 *
 *   NO_GO         more than 20% of the window's runs failed.
 *   GO_WITH_RISK  1-20% failed, OR at least one recent failure already has
 *                 a defect filed against it (jiraTicketId set — a proxy for
 *                 "known, reported regression"; this platform doesn't poll
 *                 Jira's own status for tickets it filed, only whether one
 *                 was filed, so this is honestly a filed-defect count, not
 *                 a live open/closed check).
 *   GO            no failures and no recently-filed defects in the window.
 *   INCONCLUSIVE  no executions recorded yet for this project.
 *
 * Mobile executions never carry a jiraTicketId locally (see routes/jira.ts's
 * create-from-mobile-execution — it writes the link back onto the mobile
 * engine's own execution row, a different database namespace this query
 * doesn't reach), so recentDefectCount only ever reflects web failures.
 * That's a real, disclosed gap (see the `mobileDefectTrackingNote` field
 * below), not padded with a guess.
 */
router.get('/release-readiness', async (req, res) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const windowSize = Math.min(Math.max(parseInt(req.query.window as string) || 20, 1), 200);
    // Optional (integration plan Phase 4): score readiness against only one
    // test classification, e.g. "is the smoke suite healthy" as a faster
    // signal than the whole project's history. Mobile has no equivalent
    // column — see mobileDefectTrackingNote below for that same disclosed gap.
    const testType = req.query.testType as string | undefined;

    let webQuery = projectId
      ? supabase.from('ExecutionLog').select('status, jiraTicketId, createdAt, suite:TestSuite!inner(projectId)').eq('suite.projectId', projectId)
      : supabase.from('ExecutionLog').select('status, jiraTicketId, createdAt');
    if (testType) webQuery = webQuery.eq('testType', testType);
    const { data: webRuns, error: webErr } = await webQuery.order('createdAt', { ascending: false }).limit(windowSize);
    if (webErr) throw webErr;

    // Best-effort, same pattern as /summary and /execution-trend above — a
    // mobile-side failure must not break the web-side readiness verdict.
    // When testType is set, mobile executions are excluded from the window
    // entirely rather than mixed in unfiltered — they have no classification
    // to match against, so silently including them would quietly change
    // what "the smoke suite's readiness" means.
    let mobileRuns: any[] = [];
    if (!testType) {
      try {
        let mobileQuery = projectId
          ? supabase
              .from('mobile_executions')
              .select('status, created_at, test:mobile_tests!inner(application:mobile_applications!inner(project_uuid))')
              .eq('test.application.project_uuid', projectId)
          : supabase.from('mobile_executions').select('status, created_at');
        const { data, error } = await mobileQuery.order('created_at', { ascending: false }).limit(windowSize);
        if (error) throw error;
        mobileRuns = data || [];
      } catch (mobileErr) {
        console.error('Error fetching mobile executions for release readiness (non-fatal):', mobileErr);
      }
    }

    const combined = [
      ...(webRuns || []).map((r: any) => ({
        createdAt: r.createdAt,
        failed: r.status === 'FAILED' || r.status === 'CANCELLED',
        hasDefect: !!r.jiraTicketId,
      })),
      ...mobileRuns.map((r: any) => ({
        createdAt: r.created_at,
        failed: r.status === 'FAILED' || r.status === 'INFRA_FAILURE' || r.status === 'BLOCKED',
        hasDefect: false,
      })),
    ]
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      .slice(0, windowSize);

    const total = combined.length;
    const failedRuns = combined.filter((r) => r.failed);
    const failedCount = failedRuns.length;
    const failureRate = total === 0 ? 0 : failedCount / total;
    const recentDefectCount = failedRuns.filter((r) => r.hasDefect).length;

    const NO_GO_FAILURE_RATE = 0.2; // >20% of the window failing is a hard stop

    let verdict: 'GO' | 'GO_WITH_RISK' | 'NO_GO' | 'INCONCLUSIVE';
    const reasons: string[] = [];

    if (total === 0) {
      verdict = 'INCONCLUSIVE';
      reasons.push('No executions recorded yet for this project.');
    } else if (failureRate > NO_GO_FAILURE_RATE) {
      verdict = 'NO_GO';
      reasons.push(`${failedCount} of the last ${total} runs failed (${Math.round(failureRate * 100)}%) — above the ${Math.round(NO_GO_FAILURE_RATE * 100)}% gate.`);
    } else if (failedCount > 0 || recentDefectCount > 0) {
      verdict = 'GO_WITH_RISK';
      if (failedCount > 0) reasons.push(`${failedCount} of the last ${total} runs failed (${Math.round(failureRate * 100)}%).`);
      if (recentDefectCount > 0) {
        reasons.push(`${recentDefectCount} recent failure${recentDefectCount === 1 ? '' : 's'} already ${recentDefectCount === 1 ? 'has' : 'have'} a defect filed.`);
      }
    } else {
      verdict = 'GO';
      reasons.push(`All of the last ${total} runs passed.`);
    }

    const score = total === 0 ? null : Math.max(0, Math.round(100 - failureRate * 100 - recentDefectCount * 5));

    res.json({
      verdict,
      score,
      reasons,
      window: total,
      failedCount,
      failureRate: Math.round(failureRate * 10000) / 100,
      recentDefectCount,
      mobileDefectTrackingNote: 'Mobile executions do not currently carry a linked Jira ticket ID in this query, so recentDefectCount reflects web failures only.',
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('Error computing release readiness:', err);
    res.status(500).json({ error: 'Failed to compute release readiness' });
  }
});

export default router;
