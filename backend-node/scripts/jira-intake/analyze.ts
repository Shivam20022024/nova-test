/**
 * Exercises assembleIssueContext + JiraIssueAnalysisAgent against a real OCQ
 * issue — no DB needed. Shows exactly what the AI understands from a bug.
 *
 *   npx ts-node scripts/jira-intake/analyze.ts OCQ-381
 */
import 'dotenv/config';
import { JiraService } from '../../src/services/JiraService';
import { assembleIssueContext } from '../../src/services/jiraIntakeService';
import { JiraIssueAnalysisAgent } from '../../src/agents/JiraIssueAnalysisAgent';

async function main() {
  const key = process.argv[2] || 'OCQ-381';
  const svc = new JiraService(
    process.env.JIRA_BASE_URL!, process.env.JIRA_EMAIL!, process.env.JIRA_API_TOKEN!, process.env.JIRA_PROJECT_KEY!,
  );

  const ctx = await assembleIssueContext(svc, key);
  console.log('========== ASSEMBLED CONTEXT ==========\n' + ctx + '\n');

  if (!ctx) return;
  const intent = await new JiraIssueAnalysisAgent().analyze(ctx);
  console.log('========== TEST INTENT ==========');
  console.log(JSON.stringify(intent, null, 2));
  console.log('\n========== rawScenario (fed to autonomous/run) ==========');
  console.log(JiraIssueAnalysisAgent.toRawScenario(intent));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e?.response?.data || e); process.exit(1); });
