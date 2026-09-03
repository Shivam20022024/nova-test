import { Router } from 'express';
import { supabase } from '../utils/storage';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// GET /api/v1/healing
router.get('/', async (req: AuthRequest, res) => {
  try {
    const status = req.query.status as string;

    // Only the suite/project chain is ever read off `executionLog` by the
    // frontend (HealingItemCard, and the project filter in HealingPage) —
    // embedding `ExecutionLog(*)` was pulling every row's full stepLogs/logs/
    // traceData text blobs across the join and timing out Postgres well past
    // the 12s statement limit at this table's size. Selecting only the fields
    // actually used cuts the payload from megabytes to a few short strings
    // per row, with no change to what the API returns.
    let query = supabase
      .from('HealingEvent')
      .select('*, executionLog:ExecutionLog(suite:TestSuite(name, projectId, project:Project(id, name)))')
      .order('createdAt', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    // Matches the convention every other list route in this API already
    // follows (e.g. GET /executions limits to 50) rather than returning an
    // unbounded history.
    const { data: events, error } = await query.limit(500);
    if (error) throw error;
    res.json(events);
  } catch (err: any) {
    console.error('Error fetching healing events:', err);
    res.status(500).json({ error: 'Failed to fetch healing events' });
  }
});

// POST /:id/approve and /:id/reject were removed: AutoHeal no longer parks
// a successful heal as PENDING waiting for a human decision — the fix is
// applied to the saved test automatically the moment it's found (see
// utils/healingPersistence.ts, called from queue/executionWorker.ts).
// HealingEvent rows are now a read-only log.

export default router;
