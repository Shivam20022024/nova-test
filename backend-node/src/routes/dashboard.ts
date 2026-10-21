import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { supabase } from '../utils/storage';

const router = Router();
router.use(authenticate);

const TREND_DAYS_DEFAULT = 7;

/**
 * Command Center's date-range filter (7/15/30/90 days or a custom
 * start/end pair). Both params are plain `yyyy-mm-dd` dates from the
 * frontend's <input type="date">; start is anchored to 00:00:00 UTC and
 * end to 23:59:59.999 UTC of that day so a single-day range still matches
 * everything recorded that day. Either or both may be absent — absent
 * means unbounded on that side, and when neither is present the whole
 * history is returned (the default, unfiltered "all time" view).
 */
function parseDateRange(req: any): { startISO: string | undefined; endISO: string | undefined } {
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const startISO = startDate ? new Date(`${startDate}T00:00:00.000Z`).toISOString() : undefined;
  const endISO = endDate ? new Date(`${endDate}T23:59:59.999Z`).toISOString() : undefined;
  return { startISO, endISO };
}

function withDateRange(q: any, col: string, startISO?: string, endISO?: string) {
  let qq = q;
  if (startISO) qq = qq.gte(col, startISO);
  if (endISO) qq = qq.lte(col, endISO);
  return qq;
}

/**
 * Earliest `createdAt`/`created_at` across all four execution sources for a
 * project (or the whole platform when projectId is unset) — used by the
 * execution-trend endpoint's "All time" mode to size the trend window to
 * this project's actual history instead of an arbitrary fixed window.
 * Best-effort per source: one source erroring never blocks the others.
 */
async function findEarliestExecutionDate(projectId: string | undefined): Promise<Date | null> {
  const candidates: Date[] = [];

  async function tryQuery(fn: () => Promise<{ data: any; error: any }>, col: string) {
    try {
      const { data, error } = await fn();
      if (error) throw error;
      if (data && data[col]) candidates.push(new Date(data[col]));
    } catch {
      // best-effort — a broken source must not block the others
    }
  }

  await Promise.all([
    tryQuery(async () => {
      let q = projectId
        ? supabase.from('ExecutionLog').select('createdAt, suite:TestSuite!inner(projectId)').eq('suite.projectId', projectId)
        : supabase.from('ExecutionLog').select('createdAt');
      return q.order('createdAt', { ascending: true }).limit(1).maybeSingle();
    }, 'createdAt'),
    tryQuery(async () => {
      let q = projectId
        ? supabase
            .from('mobile_executions')
            .select('created_at, test:mobile_tests!inner(application:mobile_applications!inner(project_uuid))')
            .eq('test.application.project_uuid', projectId)
        : supabase.from('mobile_executions').select('created_at');
      return q.order('created_at', { ascending: true }).limit(1).maybeSingle();
    }, 'created_at'),
    tryQuery(async () => {
      let q = projectId
        ? supabase.from('ApiExecution').select('createdAt').eq('projectId', projectId)
        : supabase.from('ApiExecution').select('createdAt');
      return q.order('createdAt', { ascending: true }).limit(1).maybeSingle();
    }, 'createdAt'),
    tryQuery(async () => {
      let q = projectId
        ? supabase.from('DbTestExecution').select('createdAt').eq('projectId', projectId)
        : supabase.from('DbTestExecution').select('createdAt');
      return q.order('createdAt', { ascending: true }).limit(1).maybeSingle();
    }, 'createdAt'),
  ]);

  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates.map((d) => d.getTime())));
}

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

/**
 * Same idea as countExecutions, for API Testing / Database Testing's own
 * tables (ApiExecution, DbTestExecution). Simpler than the mobile helper
 * above — both tables carry `projectId` directly, no join needed.
 */
async function countRows(table: 'ApiExecution' | 'DbTestExecution', projectId: string | undefined, filters: (q: any) => any) {
  let query = projectId
    ? supabase.from(table).select('id', { count: 'exact', head: true }).eq('projectId', projectId)
    : supabase.from(table).select('*', { count: 'exact', head: true });
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
    const { startISO, endISO } = parseDateRange(req);
    const withTestType = (q: any) => (testType ? q.eq('testType', testType) : q);
    const withRelease = (q: any) => (releaseId ? q.eq('releaseId', releaseId) : q);
    const withMobileRelease = (q: any) => (releaseId ? q.eq('release_uuid', releaseId) : q);
    const withDate = (q: any) => withDateRange(q, 'createdAt', startISO, endISO);
    const withMobileDate = (q: any) => withDateRange(q, 'created_at', startISO, endISO);

    const totalExecutions = await countExecutions(projectId, (q) => withDate(withRelease(withTestType(q))));
    const passedCount = await countExecutions(projectId, (q) => withDate(withRelease(withTestType(q))).in('status', ['PASSED', 'COMPLETED']));
    const failedCount = await countExecutions(projectId, (q) => withDate(withRelease(withTestType(q))).eq('status', 'FAILED'));

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
    const { data: completedExecutions, error: durError } = await withDate(durationQuery).not('durationMs', 'is', null);
    if (durError) throw durError;

    let avgDuration = 0;
    if (completedExecutions && completedExecutions.length > 0) {
      const sum = completedExecutions.reduce((acc: number, curr: any) => acc + (curr.durationMs || 0), 0);
      avgDuration = Math.round((sum / completedExecutions.length) / 1000);
    }

    const successRate = totalExecutions === 0 ? 0 : Math.round((passedCount / totalExecutions) * 100);

    // Mobile side of the same summary. Kept as best-effort: the mobile engine
    // is a separate service (see backend/mobile), and its tables should never
    // be able to break the web dashboard if something's off with them.
    let mobile = { totalExecutions: 0, passedCount: 0, failedCount: 0, selfHealingCount: 0, successRate: 0, avgDuration: 0 };
    try {
      const mobileTotal = await countMobileExecutions(projectId, (q) => withMobileDate(withMobileRelease(q)));
      const mobilePassed = await countMobileExecutions(projectId, (q) => withMobileDate(withMobileRelease(q)).eq('status', 'PASSED'));
      const mobileFailed = await countMobileExecutions(projectId, (q) => withMobileDate(withMobileRelease(q)).in('status', ['FAILED', 'INFRA_FAILURE']));

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
      const { data: mobileCompleted, error: mobileDurError } = await withMobileDate(mobileDurationQuery).not('duration_ms', 'is', null);
      if (mobileDurError) throw mobileDurError;

      let mobileAvgDuration = 0;
      if (mobileCompleted && mobileCompleted.length > 0) {
        const sum = mobileCompleted.reduce((acc: number, curr: any) => acc + (curr.duration_ms || 0), 0);
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

    // API Testing / Database Testing side of the same summary. Same
    // best-effort contract as mobile above — neither can break the web
    // summary. No self-healing concept for either (no healing agent), so
    // that field stays 0, same as browser-distribution has no mobile
    // equivalent.
    let api = { totalExecutions: 0, passedCount: 0, failedCount: 0, selfHealingCount: 0, successRate: 0, avgDuration: 0 };
    try {
      const apiWithFilters = (q: any) => withDate((releaseId ? q.eq('releaseId', releaseId) : q));
      const apiTotal = await countRows('ApiExecution', projectId, (q) => apiWithFilters(q));
      const apiPassed = await countRows('ApiExecution', projectId, (q) => apiWithFilters(q).eq('status', 'PASSED'));
      const apiFailed = await countRows('ApiExecution', projectId, (q) => apiWithFilters(q).eq('status', 'FAILED'));
      let apiDurationQuery = projectId
        ? supabase.from('ApiExecution').select('durationMs').eq('projectId', projectId)
        : supabase.from('ApiExecution').select('durationMs');
      const { data: apiCompleted } = await withDate(apiDurationQuery).not('durationMs', 'is', null);
      let apiAvgDuration = 0;
      if (apiCompleted && apiCompleted.length > 0) {
        const sum = apiCompleted.reduce((acc: number, curr: any) => acc + (curr.durationMs || 0), 0);
        apiAvgDuration = Math.round((sum / apiCompleted.length) / 1000);
      }
      api = {
        totalExecutions: apiTotal, passedCount: apiPassed, failedCount: apiFailed, selfHealingCount: 0,
        successRate: apiTotal === 0 ? 0 : Math.round((apiPassed / apiTotal) * 100), avgDuration: apiAvgDuration,
      };
    } catch (apiErr) {
      console.error('Error fetching API testing summary (non-fatal, web summary unaffected):', apiErr);
    }

    let db = { totalExecutions: 0, passedCount: 0, failedCount: 0, selfHealingCount: 0, successRate: 0, avgDuration: 0 };
    try {
      const dbWithFilters = (q: any) => withDate((releaseId ? q.eq('releaseId', releaseId) : q));
      const dbTotal = await countRows('DbTestExecution', projectId, (q) => dbWithFilters(q));
      const dbPassed = await countRows('DbTestExecution', projectId, (q) => dbWithFilters(q).eq('status', 'PASSED'));
      const dbFailed = await countRows('DbTestExecution', projectId, (q) => dbWithFilters(q).eq('status', 'FAILED'));
      let dbDurationQuery = projectId
        ? supabase.from('DbTestExecution').select('durationMs').eq('projectId', projectId)
        : supabase.from('DbTestExecution').select('durationMs');
      const { data: dbCompleted } = await withDate(dbDurationQuery).not('durationMs', 'is', null);
      let dbAvgDuration = 0;
      if (dbCompleted && dbCompleted.length > 0) {
        const sum = dbCompleted.reduce((acc: number, curr: any) => acc + (curr.durationMs || 0), 0);
        dbAvgDuration = Math.round((sum / dbCompleted.length) / 1000);
      }
      db = {
        totalExecutions: dbTotal, passedCount: dbPassed, failedCount: dbFailed, selfHealingCount: 0,
        successRate: dbTotal === 0 ? 0 : Math.round((dbPassed / dbTotal) * 100), avgDuration: dbAvgDuration,
      };
    } catch (dbErr) {
      console.error('Error fetching database testing summary (non-fatal, web summary unaffected):', dbErr);
    }

    const combinedTotal = totalExecutions + mobile.totalExecutions + api.totalExecutions + db.totalExecutions;
    const combinedPassed = passedCount + mobile.passedCount + api.passedCount + db.passedCount;

    res.json({
      totalExecutions,
      passedCount,
      failedCount,
      selfHealingCount: selfHealingCount || 0,
      successRate,
      avgDuration,
      mobile,
      api,
      db,
      combined: {
        totalExecutions: combinedTotal,
        passedCount: combinedPassed,
        failedCount: failedCount + mobile.failedCount + api.failedCount + db.failedCount,
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
    const projectId = req.query.projectId as string | undefined;
    const { startISO, endISO } = parseDateRange(req);
    const allTime = req.query.allTime === 'true';

    // Command Center's date-range filter (7/15/30/90/custom/all time)
    // overrides the legacy `days`-back-from-now window whenever a start or
    // end date is given, or "All time" is selected; with none of those,
    // behavior is unchanged (last `days` days, anchored to now).
    let rangeEnd: Date;
    let rangeStart: Date;
    let days: number;
    if (allTime) {
      rangeEnd = new Date();
      const earliest = await findEarliestExecutionDate(projectId);
      rangeStart = earliest ?? new Date(Date.now() - (TREND_DAYS_DEFAULT - 1) * 24 * 60 * 60 * 1000);
      rangeStart.setHours(0, 0, 0, 0);
      // Safety cap only — real installs won't hit this, but an unbounded
      // "all time" window must never turn into an unbounded response body.
      days = Math.min(730, Math.max(1, Math.round((rangeEnd.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000)) + 1));
    } else if (startISO || endISO) {
      rangeEnd = endISO ? new Date(endISO) : new Date();
      rangeStart = startISO ? new Date(startISO) : (() => {
        const d = new Date(rangeEnd);
        d.setDate(d.getDate() - 29);
        d.setHours(0, 0, 0, 0);
        return d;
      })();
      days = Math.min(180, Math.max(1, Math.round((rangeEnd.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000)) + 1));
    } else {
      days = parseInt(req.query.days as string) || TREND_DAYS_DEFAULT;
      rangeEnd = new Date();
      rangeStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    }
    const threshold = rangeStart;

    let query = projectId
      ? supabase.from('ExecutionLog').select('status, createdAt, suite:TestSuite!inner(projectId)').eq('suite.projectId', projectId)
      : supabase.from('ExecutionLog').select('status, createdAt');
    const { data: executions, error } = await query.gte('createdAt', threshold.toISOString()).lte('createdAt', rangeEnd.toISOString());
    if (error) throw error;

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    // Use an array to maintain strict chronological order
    const trendData: { date: string, passed: number, failed: number }[] = [];

    // Initialize the last N days with zero to ensure empty days appear on graph in order
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(rangeEnd);
      d.setDate(d.getDate() - i);
      const dayStr = dayNames[d.getDay()] as string;
      // If days > 7, append date to distinguish
      const displayStr = days > 7 ? `${d.getMonth() + 1}/${d.getDate()}` : dayStr;

      trendData.push({ date: displayStr, passed: 0, failed: 0 });
    }

    const bucket = (createdAt: string, status: string, isPassed: boolean, isFailed: boolean) => {
      const d = new Date(createdAt);
      d.setHours(0, 0, 0, 0);
      const today = new Date(rangeEnd);
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
      const { data: mobileExecutions, error: mobileError } = await mobileQuery.gte('created_at', threshold.toISOString()).lte('created_at', rangeEnd.toISOString());
      if (mobileError) throw mobileError;

      (mobileExecutions || []).forEach((ex: any) => {
        bucket(ex.created_at, ex.status, ex.status === 'PASSED', ex.status === 'FAILED' || ex.status === 'INFRA_FAILURE');
      });
    } catch (mobileErr) {
      console.error('Error fetching mobile execution trend (non-fatal, web trend unaffected):', mobileErr);
    }

    // API/DB testing side of the same trend, bucketed into the same series.
    try {
      let apiQuery = projectId
        ? supabase.from('ApiExecution').select('status, createdAt').eq('projectId', projectId)
        : supabase.from('ApiExecution').select('status, createdAt');
      const { data: apiRuns, error: apiError } = await apiQuery.gte('createdAt', threshold.toISOString()).lte('createdAt', rangeEnd.toISOString());
      if (apiError) throw apiError;
      (apiRuns || []).forEach((ex: any) => bucket(ex.createdAt, ex.status, ex.status === 'PASSED', ex.status === 'FAILED'));
    } catch (apiErr) {
      console.error('Error fetching API testing trend (non-fatal, web trend unaffected):', apiErr);
    }

    try {
      let dbQuery = projectId
        ? supabase.from('DbTestExecution').select('status, createdAt').eq('projectId', projectId)
        : supabase.from('DbTestExecution').select('status, createdAt');
      const { data: dbRuns, error: dbError } = await dbQuery.gte('createdAt', threshold.toISOString()).lte('createdAt', rangeEnd.toISOString());
      if (dbError) throw dbError;
      (dbRuns || []).forEach((ex: any) => bucket(ex.createdAt, ex.status, ex.status === 'PASSED', ex.status === 'FAILED'));
    } catch (dbErr) {
      console.error('Error fetching database testing trend (non-fatal, web trend unaffected):', dbErr);
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
    const { startISO, endISO } = parseDateRange(req);

    let query = projectId
      ? supabase.from('ExecutionLog').select('browser, suite:TestSuite!inner(projectId)').eq('suite.projectId', projectId)
      : supabase.from('ExecutionLog').select('browser');
    const { data: rows, error } = await withDateRange(query, 'createdAt', startISO, endISO);
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

/**
 * GET /coverage-distribution — Command Center's "coverage" donut, source-
 * aware. `browser-distribution` above only ever means "web browsers"; this
 * is the generalized version that the Command Center's Show: All/Web/
 * Mobile/API/Database filter drives, returning whichever breakdown is
 * actually meaningful for the selected source instead of always showing
 * web browser data regardless of what's selected:
 *   web     → browser engine (same data as /browser-distribution)
 *   mobile  → device platform (Android / iOS)
 *   api     → HTTP methods exercised across each run's request steps
 *   db      → database engine (from the linked DbConnection)
 *   all     → run counts per testing type (Web / Mobile / API / Database)
 */
router.get('/coverage-distribution', async (req, res) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const source = (req.query.source as string) || 'all';
    const { startISO, endISO } = parseDateRange(req);

    if (source === 'web') {
      let query = projectId
        ? supabase.from('ExecutionLog').select('browser, suite:TestSuite!inner(projectId)').eq('suite.projectId', projectId)
        : supabase.from('ExecutionLog').select('browser');
      const { data: rows, error } = await withDateRange(query, 'createdAt', startISO, endISO);
      if (error) throw error;
      const merged: Record<string, number> = {};
      (rows || []).forEach((row: any) => {
        const browser = row.browser || 'chromium';
        merged[browser] = (merged[browser] || 0) + 1;
      });
      return res.json(
        Object.entries(merged).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
      );
    }

    if (source === 'mobile') {
      let query = projectId
        ? supabase
            .from('mobile_executions')
            .select('created_at, test:mobile_tests!inner(application:mobile_applications!inner(platform, project_uuid))')
            .eq('test.application.project_uuid', projectId)
        : supabase.from('mobile_executions').select('created_at, test:mobile_tests(application:mobile_applications(platform))');
      const { data: rows, error } = await withDateRange(query, 'created_at', startISO, endISO);
      if (error) throw error;
      const merged: Record<string, number> = {};
      (rows || []).forEach((row: any) => {
        const platform = row.test?.application?.platform || 'android';
        const label = platform.toLowerCase() === 'ios' ? 'iOS' : 'Android';
        merged[label] = (merged[label] || 0) + 1;
      });
      return res.json(
        Object.entries(merged).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
      );
    }

    if (source === 'api') {
      let query = projectId
        ? supabase.from('ApiExecution').select('steps, createdAt').eq('projectId', projectId)
        : supabase.from('ApiExecution').select('steps, createdAt');
      const { data: rows, error } = await withDateRange(query, 'createdAt', startISO, endISO);
      if (error) throw error;
      const merged: Record<string, number> = {};
      (rows || []).forEach((row: any) => {
        const steps = Array.isArray(row.steps) ? row.steps : [];
        steps.forEach((step: any) => {
          const method = String(step?.method || 'GET').toUpperCase();
          merged[method] = (merged[method] || 0) + 1;
        });
      });
      return res.json(
        Object.entries(merged).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
      );
    }

    if (source === 'db') {
      let query = projectId
        ? supabase.from('DbTestExecution').select('createdAt, connection:DbConnection(engine)').eq('projectId', projectId)
        : supabase.from('DbTestExecution').select('createdAt, connection:DbConnection(engine)');
      const { data: rows, error } = await withDateRange(query, 'createdAt', startISO, endISO);
      if (error) throw error;
      const merged: Record<string, number> = {};
      (rows || []).forEach((row: any) => {
        const engine = row.connection?.engine || 'unknown';
        merged[engine] = (merged[engine] || 0) + 1;
      });
      return res.json(
        Object.entries(merged).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
      );
    }

    // 'all' — composition by testing type, each fetched best-effort so one
    // source erroring doesn't blank the rest (same contract as /summary).
    const withDate = (q: any) => withDateRange(q, 'createdAt', startISO, endISO);
    const withMobileDate = (q: any) => withDateRange(q, 'created_at', startISO, endISO);
    const counts: Record<string, number> = { Web: 0, Mobile: 0, API: 0, Database: 0 };
    await Promise.all([
      countExecutions(projectId, (q) => withDate(q)).then((c) => { counts.Web = c; }).catch(() => {}),
      countMobileExecutions(projectId, (q) => withMobileDate(q)).then((c) => { counts.Mobile = c; }).catch(() => {}),
      countRows('ApiExecution', projectId, (q) => withDate(q)).then((c) => { counts.API = c; }).catch(() => {}),
      countRows('DbTestExecution', projectId, (q) => withDate(q)).then((c) => { counts.Database = c; }).catch(() => {}),
    ]);
    res.json(
      Object.entries(counts)
        .filter(([, count]) => count > 0)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
    );
  } catch (err: any) {
    console.error('Error fetching coverage distribution:', err);
    res.status(500).json({ error: 'Failed to fetch coverage distribution' });
  }
});

router.get('/recent-executions', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 25;
  const projectId = req.query.projectId as string | undefined;
  const { startISO, endISO } = parseDateRange(req);
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

    const { data: runs, error } = await withDateRange(query, 'createdAt', startISO, endISO)
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
          // CI-trigger metadata (see routes/ci.ts) — undefined on every run
          // launched the normal way, so this never changes how existing
          // rows render.
          ...(run.triggeredBy === 'ci' ? { triggeredBy: 'ci', commitSha: run.commitSha, branch: run.branch, prNumber: run.prNumber } : {}),
          // Jira Intake metadata (see routes/jiraIntake.ts) — only set on a run
          // a Jira bug triggered; absent everywhere else.
          ...(run.triggeredBy === 'jira'
            ? { triggeredBy: 'jira', jiraSourceIssueKey: run.jiraSourceIssueKey, jiraSourceReporter: run.jiraSourceReporter }
            : {}),
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

      const { data: mobileRuns, error: mobileError } = await withDateRange(mobileQuery, 'created_at', startISO, endISO)
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

    // API Testing side of the same feed — same flat 'execution' shape,
    // 'API' standing in for a browser/device column. Best-effort.
    try {
      let apiQuery = projectId
        ? supabase.from('ApiExecution').select('id, name, status, durationMs, createdAt').eq('projectId', projectId)
        : supabase.from('ApiExecution').select('id, name, status, durationMs, createdAt');
      const { data: apiRuns, error: apiError } = await withDateRange(apiQuery, 'createdAt', startISO, endISO).order('createdAt', { ascending: false }).limit(rawTake);
      if (apiError) throw apiError;
      (apiRuns || []).forEach((run: any) => {
        items.push({
          type: 'execution',
          source: 'api',
          id: run.id,
          run_id: run.id,
          testName: run.name,
          browser: 'API',
          projectName: 'API Testing',
          status: String(run.status || '').toLowerCase(),
          duration: run.durationMs ? Math.round(run.durationMs / 1000) : 0,
          startedAt: run.createdAt,
        });
      });
    } catch (apiErr) {
      console.error('Error fetching API testing recent executions (non-fatal, web list unaffected):', apiErr);
    }

    // Database Testing side of the same feed.
    try {
      let dbQuery = projectId
        ? supabase.from('DbTestExecution').select('id, name, status, durationMs, createdAt, connection:DbConnection(engine)').eq('projectId', projectId)
        : supabase.from('DbTestExecution').select('id, name, status, durationMs, createdAt, connection:DbConnection(engine)');
      const { data: dbRuns, error: dbError } = await withDateRange(dbQuery, 'createdAt', startISO, endISO).order('createdAt', { ascending: false }).limit(rawTake);
      if (dbError) throw dbError;
      (dbRuns || []).forEach((run: any) => {
        items.push({
          type: 'execution',
          source: 'db',
          id: run.id,
          run_id: run.id,
          testName: run.name,
          browser: run.connection?.engine || 'DB',
          projectName: 'Database Testing',
          status: String(run.status || '').toLowerCase(),
          duration: run.durationMs ? Math.round(run.durationMs / 1000) : 0,
          startedAt: run.createdAt,
        });
      });
    } catch (dbErr) {
      console.error('Error fetching database testing recent executions (non-fatal, web list unaffected):', dbErr);
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
