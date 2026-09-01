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

// POST /api/v1/healing/:id/approve
router.post('/:id/approve', async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;

    const { data: event, error: eventErr } = await supabase
      .from('HealingEvent')
      .select('*, executionLog:ExecutionLog(*)')
      .eq('id', id)
      .maybeSingle();
    if (eventErr) throw eventErr;
    if (!event) return res.status(404).json({ error: 'Not found' });

    // We need to find the TestRun that matches event.testName in the suite
    const suiteId = event.executionLog?.suiteId;
    if (suiteId && event.testName) {
       const { data: testRun, error: testRunErr } = await supabase
         .from('TestRun')
         .select('*')
         .eq('suiteId', suiteId)
         .eq('name', event.testName)
         .maybeSingle();
       if (testRunErr) throw testRunErr;

       if (testRun) {
         let steps = [];
         try {
           steps = JSON.parse(testRun.steps);
         } catch(e) {}

         // If we have stepIndex, we can update it
         if (event.stepIndex && steps.length >= event.stepIndex) {
           const stepToUpdate = steps[event.stepIndex - 1]; // stepIndex is 1-based in Python
           if (stepToUpdate && stepToUpdate.selector === event.originalSelector) {
             stepToUpdate.selector = event.healedSelector;
           } else {
             // Fallback: just search for the selector anywhere in the steps
             for (const step of steps) {
               if (step.selector === event.originalSelector) {
                 step.selector = event.healedSelector;
               }
             }
           }

           const { error: updateErr } = await supabase
             .from('TestRun')
             .update({ steps: JSON.stringify(steps) })
             .eq('id', testRun.id);
           if (updateErr) throw updateErr;
         } else {
            // Fallback: just search for the selector anywhere in the steps
             for (const step of steps) {
               if (step.selector === event.originalSelector) {
                 step.selector = event.healedSelector;
               }
             }
             const { error: updateErr } = await supabase
               .from('TestRun')
               .update({ steps: JSON.stringify(steps) })
               .eq('id', testRun.id);
             if (updateErr) throw updateErr;
         }
       }
    }

    const { data: updated, error: approveErr } = await supabase
      .from('HealingEvent')
      .update({ status: 'APPROVED' })
      .eq('id', id)
      .select()
      .single();
    if (approveErr) throw approveErr;

    res.json(updated);
  } catch (err: any) {
    console.error('Error approving healing event:', err);
    res.status(500).json({ error: 'Failed to approve healing event' });
  }
});

// POST /api/v1/healing/:id/reject
router.post('/:id/reject', async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;

    const { data: updated, error } = await supabase
      .from('HealingEvent')
      .update({ status: 'REJECTED' })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to reject healing event' });
  }
});

export default router;
