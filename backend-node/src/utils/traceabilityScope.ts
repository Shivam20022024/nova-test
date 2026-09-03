import { supabase } from './storage';

/**
 * Ownership resolution for the Release → Sprint → SprintTestCase traceability
 * layer. Mirrors the existing project-scoping rule used by routes/mobile.ts's
 * enforceProjectScope: a resource is only visible if it chains up to a Project
 * owned by the requesting user (Project.userId), with the CI_API_KEY runner
 * ('ci-cd-runner') treated as an operator that may reach any project — the same
 * carve-out enforceProjectScope makes.
 *
 * Every helper returns null (never throws) when the resource is missing OR not
 * owned — routes turn that into a single 404 so a caller cannot probe which of
 * the two it was.
 */

const CI_USER_ID = 'ci-cd-runner';
const isCi = (userId?: string | null) => userId === CI_USER_ID;

/** True if `projectId` exists and (for a normal user) belongs to `userId`. */
export async function isProjectOwned(userId: string | undefined | null, projectId: string): Promise<boolean> {
  if (!projectId) return false;
  // No identity and not the CI operator -> cannot own anything. (The
  // /autonomous/run route is currently unauthenticated, so req.user is
  // undefined there; supplying sprint/release context to it therefore
  // fails closed rather than resolving against a null user.)
  if (!isCi(userId) && !userId) return false;
  let q = supabase.from('Project').select('id').eq('id', projectId);
  if (!isCi(userId)) q = q.eq('userId', userId as string);
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return !!data;
}

export interface ReleaseScope {
  release: any;
  projectId: string;
}

/** Load a Release only if the caller owns its project. */
export async function resolveReleaseScope(
  userId: string | undefined | null,
  releaseId: string,
): Promise<ReleaseScope | null> {
  if (!releaseId) return null;
  const { data: release, error } = await supabase.from('Release').select('*').eq('id', releaseId).maybeSingle();
  if (error) throw error;
  if (!release) return null;
  if (!(await isProjectOwned(userId, release.projectId))) return null;
  return { release, projectId: release.projectId };
}

export interface SprintScope {
  sprint: any;
  release: any;
  projectId: string;
}

/** Load a Sprint (+ its release + owning project) only if the caller owns it. */
export async function resolveSprintScope(
  userId: string | undefined | null,
  sprintId: string,
): Promise<SprintScope | null> {
  if (!sprintId) return null;
  const { data: sprint, error } = await supabase.from('Sprint').select('*').eq('id', sprintId).maybeSingle();
  if (error) throw error;
  if (!sprint) return null;
  const rel = await resolveReleaseScope(userId, sprint.releaseId);
  if (!rel) return null;
  return { sprint, release: rel.release, projectId: rel.projectId };
}

/**
 * True if a TestRun exists and its suite chains up to `projectId`
 * (TestRun → TestSuite → Project). Used to reject cross-project sprint
 * assignments and cross-project execution traceability.
 */
export async function isTestRunInProject(testRunId: string, projectId: string): Promise<boolean> {
  if (!testRunId || !projectId) return false;
  const { data, error } = await supabase
    .from('TestRun')
    .select('id, suite:TestSuite!inner(projectId)')
    .eq('id', testRunId)
    .eq('suite.projectId', projectId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/** Carries an HTTP status alongside a validation failure. */
export class TraceabilityError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'TraceabilityError';
    this.status = status;
  }
}

export interface TraceabilityInput {
  sprintId?: string | null;
  testRunId?: string | null;
  releaseId?: string | null;
}
export interface ResolvedTraceability {
  sprintId: string | null;
  testRunId: string | null;
  releaseId: string | null;
  projectId: string | null;
}

/**
 * Validates the OPTIONAL sprint / test-case / release context a run endpoint
 * may receive, and returns the exact IDs to persist onto the ExecutionLog row.
 *
 *   - all three absent  → all null (this is today's behaviour, untouched).
 *   - sprintId present   → must exist and be owned; its release is authoritative.
 *                          A conflicting releaseId in the same request is rejected.
 *   - releaseId only     → must exist and be owned.
 *   - testRunId present  → its TestRun's project must match the resolved
 *                          sprint/release project, or (if supplied alone) be owned.
 *
 * Throws TraceabilityError(status, message) on any failure; the route turns
 * that into the matching HTTP response. Never partially persists.
 */
export async function resolveRunTraceability(
  userId: string | undefined | null,
  input: TraceabilityInput,
): Promise<ResolvedTraceability> {
  const sprintId = input.sprintId || null;
  let releaseId = input.releaseId || null;
  const testRunId = input.testRunId || null;

  if (!sprintId && !releaseId && !testRunId) {
    return { sprintId: null, testRunId: null, releaseId: null, projectId: null };
  }

  let projectId: string | null = null;

  if (sprintId) {
    const scope = await resolveSprintScope(userId, sprintId);
    if (!scope) throw new TraceabilityError(404, 'Sprint not found.');
    projectId = scope.projectId;
    if (releaseId && releaseId !== scope.sprint.releaseId) {
      throw new TraceabilityError(
        400,
        'releaseId does not match the sprint’s release. Omit releaseId when sprintId is supplied.',
      );
    }
    releaseId = scope.sprint.releaseId; // authoritative — derived from the sprint
  } else if (releaseId) {
    const scope = await resolveReleaseScope(userId, releaseId);
    if (!scope) throw new TraceabilityError(404, 'Release not found.');
    projectId = scope.projectId;
  }

  if (testRunId) {
    if (projectId) {
      if (!(await isTestRunInProject(testRunId, projectId))) {
        throw new TraceabilityError(400, 'testRunId belongs to a different project than the sprint/release.');
      }
    } else {
      const { data, error } = await supabase
        .from('TestRun')
        .select('id, suite:TestSuite!inner(projectId)')
        .eq('id', testRunId)
        .maybeSingle();
      if (error) throw error;
      if (!data || !(await isProjectOwned(userId, (data as any).suite.projectId))) {
        throw new TraceabilityError(404, 'Test case not found.');
      }
      projectId = (data as any).suite.projectId;
    }
  }

  return { sprintId, testRunId, releaseId, projectId };
}
