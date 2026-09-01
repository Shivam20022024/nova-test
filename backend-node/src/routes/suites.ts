import { Router, Response } from 'express';
import { supabase } from '../utils/storage';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// GET /api/v1/suites
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabase.from('TestSuite').select('*');
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch suites' });
  }
});

// GET /api/v1/suites/:id/executions
router.get('/:id/executions', async (req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('ExecutionLog')
      .select('*')
      .eq('suiteId', req.params.id as string)
      .order('createdAt', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch suite executions' });
  }
});

// POST /api/v1/suites/:id/run
router.post('/:id/run', async (req: AuthRequest, res: Response) => {
  try {
    const { data: newExecution, error } = await supabase
      .from('ExecutionLog')
      .insert({ suiteId: req.params.id as string, status: 'PENDING' })
      .select()
      .single();
    if (error) throw error;
    // Placeholder to hook into BullMQ later if needed directly from suites
    res.json(newExecution);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to start suite run' });
  }
});

// DELETE /api/v1/suites/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { error } = await supabase.from('TestSuite').delete().eq('id', req.params.id as string);
    if (error) throw error;
    res.json({ message: 'Suite deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete suite' });
  }
});

// GET /api/v1/suites/:id/cases
router.get('/:id/cases', async (req: AuthRequest, res: Response) => {
  try {
    const { data: cases, error } = await supabase
      .from('TestRun')
      .select('*')
      .eq('suiteId', req.params.id as string)
      .order('createdAt', { ascending: false });
    if (error) throw error;

    // Parse steps from JSON string to array
    const formattedCases = (cases || []).map((c: any) => ({
      ...c,
      steps: c.steps ? (typeof c.steps === 'string' ? JSON.parse(c.steps) : c.steps) : []
    }));

    res.json(formattedCases);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch test cases' });
  }
});

// POST /api/v1/suites/:id/cases
router.post('/:id/cases', async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, steps } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Test case name is required' });
      return;
    }

    const stepsString = typeof steps === 'string' ? steps : JSON.stringify(steps || []);

    const { data: testCase, error } = await supabase
      .from('TestRun')
      .insert({
        name,
        intent: description || '',
        steps: stepsString,
        suiteId: req.params.id as string
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({
      ...testCase,
      steps: testCase.steps ? (typeof testCase.steps === 'string' ? JSON.parse(testCase.steps) : testCase.steps) : []
    });
  } catch (err: any) {
    console.error('Error creating test case:', err);
    res.status(500).json({ error: 'Failed to create test case' });
  }
});

// PUT /api/v1/suites/:id/cases/:caseId
router.put('/:id/cases/:caseId', async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, steps } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Test case name is required' });
      return;
    }

    const { data: existing, error: findError } = await supabase
      .from('TestRun')
      .select('id')
      .eq('id', req.params.caseId as string)
      .eq('suiteId', req.params.id as string)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) {
      res.status(404).json({ error: 'Test case not found' });
      return;
    }

    const stepsString = typeof steps === 'string' ? steps : JSON.stringify(steps || []);

    const { data: testCase, error } = await supabase
      .from('TestRun')
      .update({ name, intent: description || '', steps: stepsString })
      .eq('id', req.params.caseId as string)
      .select()
      .single();
    if (error) throw error;

    res.json({
      ...testCase,
      steps: testCase.steps ? (typeof testCase.steps === 'string' ? JSON.parse(testCase.steps) : testCase.steps) : []
    });
  } catch (err: any) {
    console.error('Error updating test case:', err);
    res.status(500).json({ error: 'Failed to update test case' });
  }
});

// DELETE /api/v1/suites/:id/cases/:caseId
router.delete('/:id/cases/:caseId', async (req: AuthRequest, res: Response) => {
  try {
    const { data: existing, error: findError } = await supabase
      .from('TestRun')
      .select('id')
      .eq('id', req.params.caseId as string)
      .eq('suiteId', req.params.id as string)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) {
      res.status(404).json({ error: 'Test case not found' });
      return;
    }

    const { error } = await supabase.from('TestRun').delete().eq('id', req.params.caseId as string);
    if (error) throw error;
    res.status(204).send();
  } catch (err: any) {
    console.error('Error deleting test case:', err);
    res.status(500).json({ error: 'Failed to delete test case' });
  }
});

export default router;
