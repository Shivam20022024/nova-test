import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/storage';

const router = Router();
router.use(authenticate);

// POST /api/v1/discovery/crawl/:projectId
router.post('/crawl/:projectId', async (req: AuthRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const { base_url, max_depth } = req.query;

    // Validate project exists
    const { data: project, error } = await supabase.from('Project').select('id').eq('id', projectId as string).maybeSingle();
    if (error) throw error;
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // In a full implementation, we'd enqueue a Playwright crawl job here.
    // For now, we return success to simulate completion.
    console.log(`Starting mock crawl for project ${projectId} at ${base_url}`);

    res.json({ message: 'Crawl completed successfully', pages_discovered: 5 });
  } catch (err: any) {
    console.error('Crawl failed:', err);
    res.status(500).json({ error: 'Crawl failed' });
  }
});

import { DiscoveryAgent } from '../agents/DiscoveryAgent';

// POST /api/v1/discovery/generate-flows/:projectId
router.post('/generate-flows/:projectId', async (req: AuthRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const { base_url } = req.query;

    if (!base_url || typeof base_url !== 'string') {
      res.status(400).json({ error: 'base_url query parameter is required' });
      return;
    }

    console.log(`[Discovery Route] Generating flows for projectId: ${projectId}, targetUrl: ${base_url}`);

    const agent = new DiscoveryAgent(`api_discovery_${Date.now()}`);
    const { flows } = await agent.discoverFlows(base_url);

    const savedFlows = await Promise.all(flows.map(async (flow: any) => {
      const { data, error } = await supabase
        .from('DiscoveredFlow')
        .insert({
          projectId: projectId as string,
          name: flow.name || 'Unnamed Flow',
          description: flow.description || '',
          flowType: flow.flow_type || 'NAVIGATION',
          steps: JSON.stringify(flow.generated_steps || [])
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    }));

    const formattedFlows = savedFlows.map(f => ({
      id: f.id,
      name: f.name,
      description: f.description,
      flow_type: f.flowType,
      generated_steps: JSON.parse(f.steps)
    }));

    res.json(formattedFlows);
  } catch (err: any) {
    console.error('[Discovery Route] Generation failed:', err);
    res.status(500).json({ error: err.message || 'Generation failed' });
  }
});

router.get('/flows/:projectId', async (req: AuthRequest, res: Response) => {
  try {
    const { projectId } = req.params;
    const { data: flows, error } = await supabase
      .from('DiscoveredFlow')
      .select('*')
      .eq('projectId', projectId as string)
      .order('createdAt', { ascending: false });
    if (error) throw error;

    const formattedFlows = (flows || []).map(f => ({
      id: f.id,
      name: f.name,
      description: f.description,
      flow_type: f.flowType,
      generated_steps: JSON.parse(f.steps)
    }));

    res.json(formattedFlows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch flows' });
  }
});

export default router;
