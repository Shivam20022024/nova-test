import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { isProjectOwned } from '../utils/traceabilityScope';
import { getConfig, saveConfig, toSafeConfig, pollProject, listIssues } from '../services/jiraIntakeService';

/**
 * Jira Intake — configuration + manual trigger + audit list.
 *
 * The inbound half of the Jira integration (a bug raised in Jira triggers a
 * run). Deliberately its own router, mounted at /api/v1/jira-intake — it shares
 * nothing with routes/jira.ts (outbound bug filing) so a change here cannot
 * affect that. All routes are project-ownership checked, same as every other
 * project-scoped route in this app (utils/traceabilityScope.ts).
 */
const router = Router();
router.use(authenticate);

async function assertOwned(req: AuthRequest, res: any, projectId: string): Promise<boolean> {
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required.' });
    return false;
  }
  if (!(await isProjectOwned(req.user?.id, projectId))) {
    res.status(404).json({ error: 'Project not found.' });
    return false;
  }
  return true;
}

// GET /api/v1/jira-intake/config?projectId=
router.get('/config', async (req: AuthRequest, res) => {
  try {
    const projectId = req.query.projectId as string;
    if (!(await assertOwned(req, res, projectId))) return;
    const config = await getConfig(projectId);
    res.json(toSafeConfig(config));
  } catch (err: any) {
    console.error('[JiraIntakeRoute] get config failed:', err);
    res.status(500).json({ error: 'Failed to load Jira Intake config.' });
  }
});

// PUT /api/v1/jira-intake/config   { projectId, ...fields }
router.put('/config', async (req: AuthRequest, res) => {
  try {
    const { projectId, ...patch } = req.body || {};
    if (!(await assertOwned(req, res, projectId))) return;
    const saved = await saveConfig(projectId, patch);
    res.json(toSafeConfig(saved));
  } catch (err: any) {
    console.error('[JiraIntakeRoute] save config failed:', err);
    res.status(500).json({ error: err.message || 'Failed to save Jira Intake config.' });
  }
});

// POST /api/v1/jira-intake/poll   { projectId }   — the "Check Jira now" button
router.post('/poll', async (req: AuthRequest, res) => {
  try {
    const projectId = (req.body?.projectId as string) || (req.query.projectId as string);
    if (!(await assertOwned(req, res, projectId))) return;

    const config = await getConfig(projectId);
    if (!config || !config.enabled) {
      return res.status(400).json({ error: 'Jira Intake is not enabled for this project.' });
    }
    const summary = await pollProject(projectId);
    res.json(summary);
  } catch (err: any) {
    console.error('[JiraIntakeRoute] poll failed:', err);
    res.status(500).json({ error: err.message || 'Poll failed.' });
  }
});

// GET /api/v1/jira-intake/issues?projectId=
router.get('/issues', async (req: AuthRequest, res) => {
  try {
    const projectId = req.query.projectId as string;
    if (!(await assertOwned(req, res, projectId))) return;
    const issues = await listIssues(projectId);
    res.json(issues);
  } catch (err: any) {
    console.error('[JiraIntakeRoute] list issues failed:', err);
    res.status(500).json({ error: 'Failed to list Jira Intake issues.' });
  }
});

export default router;
