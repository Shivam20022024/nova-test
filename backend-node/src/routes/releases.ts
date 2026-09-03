import { Router } from 'express';
import { supabase } from '../utils/storage';
import { authenticate, AuthRequest } from '../middleware/auth';
import { countExecutions, countMobileExecutions } from './dashboard';
import { resolveReleaseScope } from '../utils/traceabilityScope';

const router = Router();
router.use(authenticate);

// GET /api/v1/releases?projectId=
router.get('/', async (req: AuthRequest, res) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    let query = supabase.from('Release').select('*').order('createdAt', { ascending: false });
    if (projectId) query = query.eq('projectId', projectId);
    const { data, error } = await query.limit(200);
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('Error fetching releases:', err);
    res.status(500).json({ error: 'Failed to fetch releases' });
  }
});

// POST /api/v1/releases
// { projectId, name, description? } — `name` is a free-text field, not
// validated against any version format. Anyone can type anything.
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { projectId, name, description } = req.body || {};
    if (!projectId || !name || !String(name).trim()) {
      return res.status(400).json({ error: 'projectId and name are required.' });
    }
    const { data, error } = await supabase
      .from('Release')
      .insert({ projectId, name: String(name).trim(), description: description || null })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err: any) {
    console.error('Error creating release:', err);
    res.status(500).json({ error: 'Failed to create release' });
  }
});

// DELETE /api/v1/releases/:id
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { error } = await supabase.from('Release').delete().eq('id', req.params.id as string);
    if (error) throw error;
    res.status(204).send();
  } catch (err: any) {
    console.error('Error deleting release:', err);
    res.status(500).json({ error: 'Failed to delete release' });
  }
});

// GET /api/v1/releases/compare?releaseIds=a,b,c
// For each release id, the same web+mobile summary shape /dashboard/summary
// already computes (via the SAME counting helpers), just scoped to that one
// release instead of a whole project — so the numbers are directly
// comparable to what the rest of the app already shows.
router.get('/compare', async (req: AuthRequest, res) => {
  try {
    const idsParam = req.query.releaseIds as string | undefined;
    const releaseIds = (idsParam || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (releaseIds.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 releaseIds (comma-separated) to compare.' });
    }

    const { data: releases, error: releasesErr } = await supabase
      .from('Release')
      .select('*')
      .in('id', releaseIds);
    if (releasesErr) throw releasesErr;

    const results = await Promise.all(
      releaseIds.map(async (releaseId) => {
        const release = (releases || []).find((r: any) => r.id === releaseId) || null;

        const totalExecutions = await countExecutions(undefined, (q) => q.eq('releaseId', releaseId));
        const passedCount = await countExecutions(undefined, (q) => q.eq('releaseId', releaseId).in('status', ['PASSED', 'COMPLETED']));
        const failedCount = await countExecutions(undefined, (q) => q.eq('releaseId', releaseId).eq('status', 'FAILED'));

        let mobile = { totalExecutions: 0, passedCount: 0, failedCount: 0, successRate: 0 };
        try {
          const mobileTotal = await countMobileExecutions(undefined, (q) => q.eq('release_uuid', releaseId));
          const mobilePassed = await countMobileExecutions(undefined, (q) => q.eq('release_uuid', releaseId).eq('status', 'PASSED'));
          const mobileFailed = await countMobileExecutions(undefined, (q) => q.eq('release_uuid', releaseId).in('status', ['FAILED', 'INFRA_FAILURE']));
          mobile = {
            totalExecutions: mobileTotal,
            passedCount: mobilePassed,
            failedCount: mobileFailed,
            successRate: mobileTotal === 0 ? 0 : Math.round((mobilePassed / mobileTotal) * 100),
          };
        } catch (mobileErr) {
          console.error(`Error fetching mobile counts for release ${releaseId} (non-fatal):`, mobileErr);
        }

        return {
          releaseId,
          release,
          web: {
            totalExecutions,
            passedCount,
            failedCount,
            successRate: totalExecutions === 0 ? 0 : Math.round((passedCount / totalExecutions) * 100),
          },
          mobile,
        };
      }),
    );

    res.json(results);
  } catch (err: any) {
    console.error('Error comparing releases:', err);
    res.status(500).json({ error: 'Failed to compare releases' });
  }
});

// ── Traceability additions (Phase 2) ──────────────────────────────────────
// New, ownership-checked read/update endpoints. The existing GET / · POST / ·
// DELETE /:id · GET /compare above are untouched. Registered AFTER /compare so
// the literal route still wins over :id.

const RELEASE_STATUSES = ['PLANNED', 'ACTIVE', 'RELEASED', 'ARCHIVED'];

// GET /api/v1/releases/:id/sprints — sprints in a release, ordered
router.get('/:id/sprints', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveReleaseScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Release not found.' });
    const { data, error } = await supabase
      .from('Sprint')
      .select('*')
      .eq('releaseId', scope.release.id)
      .order('sequence', { ascending: true })
      .order('createdAt', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err: any) {
    console.error('Error fetching release sprints:', err);
    res.status(500).json({ error: 'Failed to fetch sprints' });
  }
});

// GET /api/v1/releases/:id — single release (status defaults to PLANNED when NULL)
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveReleaseScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Release not found.' });
    res.json({ ...scope.release, status: scope.release.status ?? 'PLANNED' });
  } catch (err: any) {
    console.error('Error fetching release:', err);
    res.status(500).json({ error: 'Failed to fetch release' });
  }
});

// PATCH /api/v1/releases/:id
// { name?, description?, status?, sequence?, startDate?, endDate? }
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const scope = await resolveReleaseScope(req.user?.id, req.params.id as string);
    if (!scope) return res.status(404).json({ error: 'Release not found.' });

    const { name, description, status, sequence, startDate, endDate } = req.body || {};
    const updates: Record<string, unknown> = {};
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
      updates.name = String(name).trim();
    }
    if (description !== undefined) updates.description = description || null;
    if (status !== undefined) {
      if (!RELEASE_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${RELEASE_STATUSES.join(', ')}` });
      }
      updates.status = status;
    }
    if (sequence !== undefined) updates.sequence = Number(sequence);
    if (startDate !== undefined) updates.startDate = startDate || null;
    if (endDate !== undefined) updates.endDate = endDate || null;

    if (Object.keys(updates).length === 0) return res.json(scope.release);

    const { data, error } = await supabase
      .from('Release')
      .update(updates)
      .eq('id', scope.release.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('Error updating release:', err);
    res.status(500).json({ error: 'Failed to update release' });
  }
});

export default router;
