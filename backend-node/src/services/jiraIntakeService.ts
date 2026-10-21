import { supabase } from '../utils/storage';
import { encrypt, decrypt } from '../lib/crypto';
import { JiraService } from './JiraService';
import { JiraIssueAnalysisAgent, TestIntent } from '../agents/JiraIssueAnalysisAgent';

/**
 * Jira Intake orchestration — the inbound direction of the Jira integration.
 *
 * A poller (jiraIntakePoller.ts) and a manual "Check now" route
 * (routes/jiraIntake.ts) both call pollProject(). executionWorker.ts calls
 * postRunResultToJira() when a Jira-triggered run finishes.
 *
 * NOTHING here touches the existing outbound bug-filing path. The run itself
 * goes through the unchanged /api/v1/autonomous/run endpoint; the only new
 * thing on that call is a `source: { provider: 'jira', ... }` tag, handled
 * additively by routes/executions.ts::ciCols.
 */

const SELF_BASE_URL = `http://127.0.0.1:${process.env.PORT || 8080}`;
const CI_API_KEY = process.env.CI_API_KEY || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

/** Labels NovaTest owns — used to keep its own issues out of the intake JQL. */
export const INTAKE_LABELS = {
  tested: 'novatest-tested',
  skipped: 'novatest-skipped',
  generated: 'novatest-generated',
} as const;

const MASKED = '********';

/* ------------------------------------------------------------------ config -- */

export interface JiraIntakeConfigRow {
  id: string;
  projectId: string;
  enabled: boolean;
  triggerLabel: string;
  defaultTargetUrl: string | null;
  testUsername: string | null;
  testPassword: string | null; // encrypted at rest
  defaultBrowsers: string[];
  pollIntervalMinutes: number;
  postResultComment: 'always' | 'on_failure' | 'off';
  addTestedLabel: boolean;
  minConfidence: 'medium' | 'high';
  lastPolledAt: string | null;
}

/** The config as the frontend sees it — password never leaves the server. */
export function toSafeConfig(row: JiraIntakeConfigRow | null) {
  if (!row) return null;
  const { testPassword, ...rest } = row;
  return { ...rest, hasPassword: !!testPassword };
}

export async function getConfig(projectId: string): Promise<JiraIntakeConfigRow | null> {
  const { data, error } = await supabase.from('JiraIntakeConfig').select('*').eq('projectId', projectId).maybeSingle();
  if (error) throw error;
  return (data as JiraIntakeConfigRow) || null;
}

export async function saveConfig(projectId: string, patch: Record<string, any>): Promise<JiraIntakeConfigRow> {
  const existing = await getConfig(projectId);

  // Password: a client that leaves the masked value (or omits it) keeps the
  // stored one; an empty string clears it; anything else is re-encrypted.
  let testPassword = existing?.testPassword ?? null;
  if (Object.prototype.hasOwnProperty.call(patch, 'testPassword')) {
    const raw = patch.testPassword;
    if (raw === MASKED || raw == null) {
      /* keep */
    } else if (raw === '') {
      testPassword = null;
    } else {
      testPassword = encrypt(String(raw));
    }
  }

  const row = {
    projectId,
    enabled: patch.enabled ?? existing?.enabled ?? false,
    triggerLabel: (patch.triggerLabel ?? existing?.triggerLabel ?? 'novatest-run').trim() || 'novatest-run',
    defaultTargetUrl: patch.defaultTargetUrl !== undefined ? (patch.defaultTargetUrl || null) : (existing?.defaultTargetUrl ?? null),
    testUsername: patch.testUsername !== undefined ? (patch.testUsername || null) : (existing?.testUsername ?? null),
    testPassword,
    defaultBrowsers: Array.isArray(patch.defaultBrowsers) && patch.defaultBrowsers.length > 0
      ? patch.defaultBrowsers
      : (existing?.defaultBrowsers ?? ['chromium']),
    pollIntervalMinutes: Math.min(Math.max(Number(patch.pollIntervalMinutes ?? existing?.pollIntervalMinutes ?? 5), 2), 1440),
    postResultComment: ['always', 'on_failure', 'off'].includes(patch.postResultComment)
      ? patch.postResultComment
      : (existing?.postResultComment ?? 'always'),
    addTestedLabel: patch.addTestedLabel ?? existing?.addTestedLabel ?? true,
    minConfidence: ['medium', 'high'].includes(patch.minConfidence) ? patch.minConfidence : (existing?.minConfidence ?? 'medium'),
  };

  if (existing) {
    const { data, error } = await supabase.from('JiraIntakeConfig').update(row).eq('projectId', projectId).select().single();
    if (error) throw error;
    return data as JiraIntakeConfigRow;
  }
  const { data, error } = await supabase.from('JiraIntakeConfig').insert(row).select().single();
  if (error) throw error;
  return data as JiraIntakeConfigRow;
}

/* --------------------------------------------------------------- jira wiring -- */

interface ResolvedJira {
  service: JiraService;
  projectKey: string;
  accountEmail: string;
}

/**
 * Build a JiraService for a project, reusing the EXACT fallback the existing
 * outbound path uses (routes/jira.ts, executionWorker.ts): a per-project
 * JiraIntegration row when active, otherwise the global JIRA_* env vars.
 */
export async function resolveJira(projectId: string): Promise<ResolvedJira | null> {
  const { data: integration } = await supabase.from('JiraIntegration').select('*').eq('projectId', projectId).maybeSingle();

  const envUrl = process.env.JIRA_BASE_URL;
  const envEmail = process.env.JIRA_EMAIL;
  const envToken = process.env.JIRA_API_TOKEN;
  const envProject = process.env.JIRA_PROJECT_KEY;

  const useDb = integration && integration.isActive;
  const useEnv = !useDb && envUrl && envEmail && envToken && envProject;
  if (!useDb && !useEnv) return null;

  const baseUrl = useDb ? integration.baseUrl : envUrl!;
  const email = useDb ? integration.email : envEmail!;
  const token = useDb ? integration.apiToken : envToken!;
  const projectKey = useDb ? integration.projectKey : envProject!;

  return {
    service: new JiraService(baseUrl, email, token, projectKey, useDb ? integration.issueType : 'Bug'),
    projectKey,
    accountEmail: email,
  };
}

/* ----------------------------------------------------------- context assembly -- */

/**
 * Pull a Jira issue plus every linked issue / parent story into one plain-text
 * block for the analysis agent. Custom fields are resolved to their human names
 * via the `names` map from expand=names.
 */
export async function assembleIssueContext(jira: JiraService, issueKey: string): Promise<string | null> {
  const issue = await jira.getIssue(issueKey, 'names,renderedFields');
  if (!issue) return null;

  const f = issue.fields || {};
  const names: Record<string, string> = issue.names || {};
  const lines: string[] = [];

  lines.push(`ISSUE ${issue.key}: ${f.summary || '(no summary)'}`);
  lines.push(`Type: ${f.issuetype?.name || 'Unknown'} | Priority: ${f.priority?.name || 'n/a'} | Status: ${f.status?.name || 'n/a'}`);
  if (f.reporter?.displayName) lines.push(`Reported by: ${f.reporter.displayName}`);
  if (Array.isArray(f.labels) && f.labels.length) lines.push(`Labels: ${f.labels.join(', ')}`);
  if (Array.isArray(f.components) && f.components.length) lines.push(`Components: ${f.components.map((c: any) => c.name).join(', ')}`);

  const description = JiraService.adfToText(f.description).trim();
  lines.push('', 'DESCRIPTION:', description || '(empty)');

  // Every populated custom field, by its human label. Skip the noisy internal ones.
  const SKIP_FIELD_NAMES = /rank|sprint|story point|epic link|parent link|team|start date|flagged/i;
  const customFieldChunks: string[] = [];
  for (const [key, val] of Object.entries(f)) {
    if (!key.startsWith('customfield_') || val == null) continue;
    const label = names[key] || key;
    if (SKIP_FIELD_NAMES.test(label)) continue;
    const text =
      typeof val === 'string'
        ? val
        : Array.isArray(val)
          ? val.map((v: any) => v?.value || v?.name || JiraService.adfToText(v)).filter(Boolean).join(', ')
          : (val as any)?.value || (val as any)?.name || JiraService.adfToText(val);
    const clean = String(text || '').trim();
    if (clean) customFieldChunks.push(`- ${label}: ${clean}`);
  }
  if (customFieldChunks.length) lines.push('', 'ADDITIONAL FIELDS:', ...customFieldChunks);

  // Attachments — filenames only (they hint at what to look at).
  if (Array.isArray(f.attachment) && f.attachment.length) {
    lines.push('', `ATTACHMENTS: ${f.attachment.map((a: any) => a.filename).join(', ')}`);
  }

  // Comments — often carry the real repro detail.
  const comments: any[] = f.comment?.comments || [];
  if (comments.length) {
    lines.push('', 'COMMENTS:');
    for (const c of comments.slice(-10)) {
      lines.push(`[${c.author?.displayName || 'user'}] ${JiraService.adfToText(c.body).trim()}`);
    }
  }

  // Linked issues + parent — fetch each once for its summary + description +
  // acceptance criteria. This is where the "user story" understanding comes from.
  const linkedKeys = new Set<string>();
  for (const link of f.issuelinks || []) {
    const other = link.inwardIssue || link.outwardIssue;
    if (other?.key) linkedKeys.add(other.key);
  }
  if (f.parent?.key) linkedKeys.add(f.parent.key);

  for (const key of Array.from(linkedKeys).slice(0, 5)) {
    const linked = await jira.getIssue(key, 'names');
    if (!linked) continue;
    const lf = linked.fields || {};
    const lnames: Record<string, string> = linked.names || {};
    const acChunks: string[] = [];
    for (const [k, v] of Object.entries(lf)) {
      if (!k.startsWith('customfield_') || v == null) continue;
      const label = lnames[k] || '';
      if (!/accept|criteria|definition of done|story/i.test(label)) continue;
      const t = typeof v === 'string' ? v : JiraService.adfToText(v);
      if (t && t.trim()) acChunks.push(`  ${label}: ${t.trim()}`);
    }
    lines.push(
      '',
      `RELATED USER STORY ${linked.key} (${lf.issuetype?.name || 'issue'}): ${lf.summary || ''}`,
      `  ${JiraService.adfToText(lf.description).trim() || '(no description)'}`,
      ...acChunks,
    );
  }

  return lines.join('\n');
}

/* --------------------------------------------------------------------- poll -- */

async function callSelf(method: string, path: string, body?: unknown): Promise<{ httpStatus: number; json: any }> {
  const resp = await fetch(`${SELF_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': CI_API_KEY },
    body: body ? JSON.stringify(body) : null,
  });
  const json = await resp.json().catch(() => ({}));
  return { httpStatus: resp.status, json };
}

export interface PollSummary {
  projectId: string;
  found: number;
  queued: number;
  skipped: number;
  errors: number;
  details: Array<{ issueKey: string; outcome: string; reason?: string | undefined; executionIds?: string[] | undefined }>;
}

/**
 * Serialises poll cycles for a project. The background poller (jiraIntakePoller
 * .ts) and the manual "Check now" route can both fire pollProject for the same
 * project at the same time; without this they could each claim the same fresh
 * issue and start two identical runs. Single-instance in-process lock — matches
 * how this backend already runs (one node process; see the QUEUE_NAMESPACE
 * comment in executionWorker.ts).
 */
const inFlight = new Set<string>();

/**
 * One poll cycle for a single project. Safe to call repeatedly — every issue is
 * recorded in JiraIntakeIssue (unique per project+key) and only acted on once.
 */
export async function pollProject(projectId: string): Promise<PollSummary> {
  const summary: PollSummary = { projectId, found: 0, queued: 0, skipped: 0, errors: 0, details: [] };

  if (inFlight.has(projectId)) {
    summary.details.push({ issueKey: '-', outcome: 'busy', reason: 'A poll for this project is already running.' });
    return summary;
  }
  inFlight.add(projectId);
  try {
    return await runPoll(projectId, summary);
  } finally {
    inFlight.delete(projectId);
  }
}

async function runPoll(projectId: string, summary: PollSummary): Promise<PollSummary> {
  const config = await getConfig(projectId);
  if (!config || !config.enabled) return summary;

  const resolved = await resolveJira(projectId);
  if (!resolved) {
    summary.errors++;
    summary.details.push({ issueKey: '-', outcome: 'error', reason: 'No active Jira integration for this project.' });
    return summary;
  }
  const { service: jira, projectKey } = resolved;

  // Time window: generous on the first poll, tight afterwards. Dedupe via
  // JiraIntakeIssue means an overlap only costs a cheap "already seen" check.
  let sinceClause = 'created >= -14d';
  if (config.lastPolledAt) {
    const minutes = Math.max(5, Math.ceil((Date.now() - new Date(config.lastPolledAt).getTime()) / 60000) + config.pollIntervalMinutes + 5);
    sinceClause = `updated >= -${minutes}m`;
  }

  // Loop guard, layered (most important first):
  //   1. executionWorker.ts never auto-files a fresh bug for a triggeredBy
  //      === 'jira' run — the actual thing that would close a loop.
  //   2. JiraIntakeIssue is unique per (project, issueKey): one issue, one run.
  //   3. The 'novatest-tested' label is added after every run, so a processed
  //      issue drops out of this query; 'novatest-skipped' / 'novatest-
  //      generated' are excluded too.
  // A `reporter != <our account>` clause was intentionally NOT added: small
  // teams often raise bugs from the same Jira account NovaTest authenticates
  // with, and that clause would silently disable the feature for them.
  const jql =
    `project = "${projectKey}" ` +
    `AND labels = "${config.triggerLabel}" ` +
    `AND labels NOT IN ("${INTAKE_LABELS.tested}", "${INTAKE_LABELS.skipped}", "${INTAKE_LABELS.generated}") ` +
    `AND ${sinceClause} ORDER BY updated DESC`;

  const issues = await jira.searchIssues(jql, 25);
  summary.found = issues.length;

  for (const issue of issues) {
    const issueKey: string = issue.key;
    try {
      const { data: seen } = await supabase
        .from('JiraIntakeIssue')
        .select('id, status')
        .eq('projectId', projectId)
        .eq('issueKey', issueKey)
        .maybeSingle();
      // Anything already recorded is left alone (v1 = one issue, one run).
      if (seen) continue;

      // Claim the issue. The UNIQUE (projectId, issueKey) constraint makes this
      // the atomic gate: if a concurrent poll already inserted the row, this
      // errors (code 23505) and we skip — so an issue can never start two runs.
      const { error: claimError } = await supabase.from('JiraIntakeIssue').insert({
        projectId,
        issueKey,
        status: 'analyzing',
        issueUpdatedAt: issue.fields?.updated || null,
      });
      if (claimError) {
        // 23505 = unique_violation -> another poll got here first; not an error.
        if ((claimError as any).code !== '23505') {
          console.error(`[JiraIntake] claim ${issueKey} failed:`, claimError);
        }
        continue;
      }

      const contextStr = await assembleIssueContext(jira, issueKey);
      if (!contextStr) {
        await markIssue(projectId, issueKey, 'error', 'Could not load the issue from Jira.');
        summary.errors++;
        summary.details.push({ issueKey, outcome: 'error', reason: 'load failed' });
        continue;
      }

      const agent = new JiraIssueAnalysisAgent();
      const intent = await agent.analyze(contextStr);

      const targetUrl = intent.targetUrl || config.defaultTargetUrl || null;
      const confOrder = { low: 0, medium: 1, high: 2 } as const;
      const minOk = confOrder[intent.confidence] >= confOrder[config.minConfidence];

      if (!minOk || !targetUrl) {
        const missing = [
          ...(intent.missingInfo || []),
          ...(!targetUrl ? ['No page URL in the issue and no default URL configured for this project.'] : []),
        ];
        await markIssue(projectId, issueKey, 'skipped', missing.join(' | '), intent);
        await jira.addComment(issueKey, [
          { type: 'paragraph', content: [{ type: 'text', text: `🤖 NovaTest AI could not run this automatically (${intent.confidence} confidence).` }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'To get an automated test run, add the following and remove then re-add the trigger label:' }] },
          { type: 'bulletList', content: missing.slice(0, 8).map((m) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: m }] }] })) },
        ]);
        await jira.addLabels(issueKey, [INTAKE_LABELS.skipped]);
        summary.skipped++;
        summary.details.push({ issueKey, outcome: 'skipped', reason: missing[0] });
        continue;
      }

      const credentials =
        config.testUsername && config.testPassword
          ? { username: config.testUsername, password: safeDecrypt(config.testPassword) }
          : undefined;

      const { httpStatus, json } = await callSelf('POST', '/api/v1/autonomous/run', {
        targetUrl,
        credentials,
        projectId,
        browsers: config.defaultBrowsers,
        rawScenario: JiraIssueAnalysisAgent.toRawScenario(intent),
        depth: 'standard',
        features: { healing: true, video: false, accessibility: false, security: false, responsive: false, api: false, autoJira: false },
        source: {
          provider: 'jira',
          issueKey,
          reporter: issue.fields?.reporter?.displayName || null,
          summary: issue.fields?.summary || null,
        },
      });

      if (httpStatus >= 400 || !Array.isArray(json.executionIds) || json.executionIds.length === 0) {
        await markIssue(projectId, issueKey, 'error', `autonomous/run returned ${httpStatus}: ${json.error || 'no executionIds'}`, intent);
        summary.errors++;
        summary.details.push({ issueKey, outcome: 'error', reason: json.error || `HTTP ${httpStatus}` });
        continue;
      }

      await supabase
        .from('JiraIntakeIssue')
        .update({ status: 'running', analysisJson: intent, executionIds: json.executionIds, processedAt: new Date().toISOString() })
        .eq('projectId', projectId)
        .eq('issueKey', issueKey);

      summary.queued++;
      summary.details.push({ issueKey, outcome: 'queued', executionIds: json.executionIds });
    } catch (err: any) {
      console.error(`[JiraIntake] ${issueKey} failed:`, err?.message || err);
      await markIssue(projectId, issueKey, 'error', String(err?.message || err)).catch(() => {});
      summary.errors++;
      summary.details.push({ issueKey, outcome: 'error', reason: String(err?.message || err) });
    }
  }

  await supabase.from('JiraIntakeConfig').update({ lastPolledAt: new Date().toISOString() }).eq('projectId', projectId);
  return summary;
}

async function markIssue(projectId: string, issueKey: string, status: string, reason?: string, analysisJson?: TestIntent) {
  await supabase
    .from('JiraIntakeIssue')
    .update({
      status,
      reason: reason ? reason.slice(0, 2000) : null,
      ...(analysisJson ? { analysisJson } : {}),
      processedAt: new Date().toISOString(),
    })
    .eq('projectId', projectId)
    .eq('issueKey', issueKey);
}

function safeDecrypt(cipher: string): string {
  try {
    return decrypt(cipher);
  } catch {
    return '';
  }
}

/* ----------------------------------------------------------- result comment -- */

/**
 * Called by executionWorker.ts once a Jira-triggered run reaches a terminal
 * state. Best-effort throughout — a Jira failure here never affects the run.
 */
export async function postRunResultToJira(executionId: string): Promise<void> {
  try {
    const { data: exec } = await supabase
      .from('ExecutionLog')
      .select('*, suite:TestSuite(projectId)')
      .eq('id', executionId)
      .maybeSingle();

    if (!exec || exec.triggeredBy !== 'jira' || !exec.jiraSourceIssueKey) return;
    const projectId: string | undefined = exec.suite?.projectId;
    if (!projectId) return;

    const issueKey: string = exec.jiraSourceIssueKey;
    const config = await getConfig(projectId);
    const resolved = await resolveJira(projectId);
    if (!resolved) return;
    const jira = resolved.service;

    const { data: intakeIssue } = await supabase
      .from('JiraIntakeIssue')
      .select('*')
      .eq('projectId', projectId)
      .eq('issueKey', issueKey)
      .maybeSingle();

    const status = String(exec.status || '').toUpperCase();
    const passed = status === 'PASSED' || status === 'COMPLETED';
    const policy = config?.postResultComment ?? 'always';
    const shouldComment = policy === 'always' || (policy === 'on_failure' && !passed);

    if (shouldComment) {
      const reportUrl = `${FRONTEND_URL}/app/execution/${executionId}/report`;
      const adf = JiraService.generateIntakeResultAdf(exec, intakeIssue?.analysisJson, reportUrl);
      const comment = await jira.addComment(issueKey, adf);
      if (comment) {
        await supabase.from('ExecutionLog').update({ jiraResultCommentUrl: comment.url }).eq('id', executionId);
      }
    }

    if (config?.addTestedLabel ?? true) {
      await jira.addLabels(issueKey, [INTAKE_LABELS.tested]);
    }

    await supabase
      .from('JiraIntakeIssue')
      .update({ status: 'done', processedAt: new Date().toISOString() })
      .eq('projectId', projectId)
      .eq('issueKey', issueKey);
  } catch (err: any) {
    console.error(`[JiraIntake] postRunResultToJira(${executionId}) failed:`, err?.message || err);
  }
}

/* ------------------------------------------------------------------- listing -- */

export async function listIssues(projectId: string, limit = 50) {
  const { data, error } = await supabase
    .from('JiraIntakeIssue')
    .select('*')
    .eq('projectId', projectId)
    .order('createdAt', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}
