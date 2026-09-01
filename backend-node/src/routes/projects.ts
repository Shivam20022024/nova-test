import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/storage';

const router = Router();

router.use(authenticate);

// GET /api/v1/projects
router.get('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const { data, error } = await supabase
      .from('Project')
      .select('*')
      .eq('userId', userId)
      .order('createdAt', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('Error fetching projects:', err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// POST /api/v1/projects
router.post('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const { name, description } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Project name is required' });
      return;
    }

    // Mirrors Prisma's connectOrCreate: ensure the user row exists before the
    // project's foreign key can point at it.
    const { error: userError } = await supabase.from('User').upsert(
      {
        id: userId,
        email: req.user?.email || 'unknown@example.com',
        name: req.user?.user_metadata?.full_name || 'Unknown',
      },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (userError) throw userError;

    const { data: project, error } = await supabase
      .from('Project')
      .insert({ name, description, userId })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json(project);
  } catch (err: any) {
    console.error('Error creating project:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// PATCH /api/v1/projects/:id
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const projectId = req.params.id as string;
    const { name, description } = req.body;

    const { data: existing, error: findError } = await supabase
      .from('Project')
      .select('id')
      .eq('id', projectId)
      .eq('userId', userId)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    if (name !== undefined && !name.trim()) {
      res.status(400).json({ error: 'Project name cannot be empty' });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    const { data: project, error } = await supabase
      .from('Project')
      .update(updates)
      .eq('id', projectId)
      .select()
      .single();
    if (error) throw error;

    res.json(project);
  } catch (err: any) {
    console.error('Error updating project:', err);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// DELETE /api/v1/projects/:id
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const projectId = req.params.id as string;

    const { data: existing, error: findError } = await supabase
      .from('Project')
      .select('id')
      .eq('id', projectId)
      .eq('userId', userId)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Every child table (TestSuite, DiscoveredFlow, JiraIntegration,
    // DbConnection) has ON DELETE CASCADE, so this alone removes the
    // project's full tree — same behaviour Prisma's relation cascade gave us.
    const { error } = await supabase.from('Project').delete().eq('id', projectId);
    if (error) throw error;

    res.status(204).send();
  } catch (err: any) {
    console.error('Error deleting project:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// GET /api/v1/projects/:id/suites
router.get('/:id/suites', async (req: AuthRequest, res) => {
  try {
    const projectId = req.params.id as string;
    const { data, error } = await supabase
      .from('TestSuite')
      .select('*')
      .eq('projectId', projectId)
      .order('createdAt', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('Error fetching project suites:', err);
    res.status(500).json({ error: 'Failed to fetch project suites' });
  }
});

// POST /api/v1/projects/:id/suites
router.post('/:id/suites', async (req: AuthRequest, res) => {
  try {
    const projectId = req.params.id as string;
    const { name, description, type } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Suite name is required' });
      return;
    }

    const { data: suite, error } = await supabase
      .from('TestSuite')
      .insert({
        name,
        description: description || null,
        type: type === 'API' ? 'API' : 'WEB',
        projectId,
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json(suite);
  } catch (err: any) {
    console.error('Error creating suite:', err);
    res.status(500).json({
      error: 'Failed to create suite: ' + err.message,
      stack: err.stack,
    });
  }
});

export default router;
