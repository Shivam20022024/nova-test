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
async function countExecutions(projectId: string | undefined, filters: (q: any) => any) {
  let query = projectId
    ? supabase.from('ExecutionLog').select('id, suite:TestSuite!inner(projectId)', { count: 'exact', head: true }).eq('suite.projectId', projectId)
    : supabase.from('ExecutionLog').select('*', { count: 'exact', head: true });
  query = filters(query);
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

router.get('/summary', async (req, res) => {
  try {
    const projectId = req.query.projectId as string | undefined;

    const totalExecutions = await countExecutions(projectId, (q) => q);
    const passedCount = await countExecutions(projectId, (q) => q.in('status', ['PASSED', 'COMPLETED']));
    const failedCount = await countExecutions(projectId, (q) => q.eq('status', 'FAILED'));

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

    res.json({
      totalExecutions,
      passedCount,
      failedCount,
      selfHealingCount: selfHealingCount || 0,
      successRate,
      avgDuration
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

    (executions || []).forEach((ex: any) => {
      const d = new Date(ex.createdAt);
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
          if (ex.status === 'PASSED' || ex.status === 'COMPLETED') item.passed++;
          else if (ex.status === 'FAILED') item.failed++;
        }
      }
    });

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

    res.json(items.slice(0, limit));
  } catch (err: any) {
    console.error('Error fetching recent executions:', err);
    res.status(500).json({ error: 'Failed to fetch recent executions' });
  }
});

export default router;
