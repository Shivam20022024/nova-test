/**
 * Throwaway probe for the new JiraService intake methods, run against the real
 * Jira configured in backend-node/.env (JIRA_*). Not part of the app.
 *
 *   npx ts-node scripts/jira-intake/probe.ts <ISSUE-KEY?>
 */
import 'dotenv/config';
import { JiraService } from '../../src/services/JiraService';

async function main() {
  const baseUrl = process.env.JIRA_BASE_URL!;
  const email = process.env.JIRA_EMAIL!;
  const token = process.env.JIRA_API_TOKEN!;
  const projectKey = process.env.JIRA_PROJECT_KEY!;
  const svc = new JiraService(baseUrl, email, token, projectKey);

  console.log('== testConnection ==', await svc.testConnection());

  const jql = `project = "${projectKey}" ORDER BY created DESC`;
  const issues = await svc.searchIssues(jql, 5);
  console.log(`== searchIssues (${issues.length}) ==`);
  for (const i of issues) console.log(`  ${i.key}: ${i.fields?.summary}  [${i.fields?.status?.name}] labels=${(i.fields?.labels || []).join(',')}`);

  const key = process.argv[2] || issues[0]?.key;
  if (!key) { console.log('no issue to inspect'); return; }

  const issue = await svc.getIssue(key, 'names,renderedFields');
  console.log(`\n== getIssue ${key} ==`);
  console.log('  summary:', issue?.fields?.summary);
  console.log('  reporter:', issue?.fields?.reporter?.displayName);
  console.log('  description (adfToText):\n' + JiraService.adfToText(issue?.fields?.description).split('\n').map((l: string) => '    ' + l).join('\n'));
  console.log('  issuelinks:', (issue?.fields?.issuelinks || []).map((l: any) => (l.inwardIssue || l.outwardIssue)?.key).join(', ') || 'none');

  if (process.argv[3] === '--comment') {
    console.log('\n== addComment ==', await svc.addComment(key, [
      { type: 'paragraph', content: [{ type: 'text', text: '🤖 NovaTest Jira-Intake probe — please ignore/delete.' }] },
    ]));
    console.log('== addLabels ==', await svc.addLabels(key, ['novatest-probe']));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.response?.data || e); process.exit(1); });
