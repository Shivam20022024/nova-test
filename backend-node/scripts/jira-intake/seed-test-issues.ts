/**
 * Creates the OCQ Jira issues used to verify Jira Intake end-to-end.
 * Clearly marked "[NovaTest test]" so they're easy to find and close afterwards.
 *
 *   npx ts-node scripts/jira-intake/seed-test-issues.ts
 */
import 'dotenv/config';
import axios from 'axios';
import { JiraService } from '../../src/services/JiraService';

const baseUrl = process.env.JIRA_BASE_URL!.replace(/\/$/, '');
const email = process.env.JIRA_EMAIL!;
const token = process.env.JIRA_API_TOKEN!;
const projectKey = process.env.JIRA_PROJECT_KEY!;
const auth = { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' };

const svc = new JiraService(baseUrl, email, token, projectKey);

const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const heading = (t: string) => ({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: t }] });
const bullets = (items: string[]) => ({ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: [para(t)] })) });

async function createRaw(summary: string, adf: any[], labels: string[]) {
  // OCQ has no "Bug" type — createIssue() falls back to "Task" automatically.
  const issue = await svc.createIssue(summary, adf);
  if (!issue) throw new Error(`createIssue failed for: ${summary}`);
  if (labels.length) await svc.addLabels(issue.key, labels);
  return issue.key;
}

async function link(inward: string, outward: string, type = 'Relates') {
  await axios.post(`${baseUrl}/rest/api/3/issueLink`, {
    type: { name: type },
    inwardIssue: { key: inward },
    outwardIssue: { key: outward },
  }, { headers: auth }).catch((e) => console.warn('link failed:', e.response?.data || e.message));
}

async function main() {
  // 1. A "user story" reference issue (Bug type — OCQ has no Story type wired for the API user).
  const story = await createRaw(
    '[NovaTest test] STORY: Shopper can add a product to the cart from the catalog',
    [
      heading('User story'),
      para('As a shopper, I want to add a product to my cart from the product catalog so that I can buy it later.'),
      heading('Acceptance criteria'),
      bullets([
        'The catalog page lists products, each with a visible name and price.',
        'Opening a product shows its details and an "Add to cart" control.',
        'After adding a product, the cart page lists that product by name.',
      ]),
    ],
    ['novatest-test-fixture'],
  );
  console.log('story:', story);

  // 2. The BUG that should trigger a real run (has URL + repro steps + expected result).
  const bug = await createRaw(
    '[NovaTest test] Add to cart appears to do nothing on the demo store',
    [
      heading('Summary'),
      para('On the demo store, clicking "Add to cart" on a product detail page does not seem to register — the product is not shown on the cart page afterwards.'),
      heading('Environment'),
      bullets(['URL: https://www.demoblaze.com', 'Browser: Chrome (latest)']),
      heading('Steps to reproduce'),
      bullets([
        'Open https://www.demoblaze.com',
        'Click the first product in the catalog (e.g. "Samsung galaxy s6")',
        'On the product page, click "Add to cart" and accept the browser dialog',
        'Click "Cart" in the top navigation',
      ]),
      heading('Expected result'),
      para('The cart page lists the product that was just added, with its name and price.'),
      heading('Actual result'),
      para('The cart page is empty.'),
    ],
    ['novatest-run'],
  );
  console.log('bug (should RUN):', bug);
  await link(bug, story, 'Relates');

  // 3. A vague BUG that should be SKIPPED (no URL, no steps, no expected result).
  const vague = await createRaw(
    '[NovaTest test] something is broken on the site',
    [para('the checkout is weird sometimes, please look into it')],
    ['novatest-run'],
  );
  console.log('bug (should SKIP):', vague);

  console.log('\nDone. Verify with: npx ts-node scripts/jira-intake/probe.ts', bug);
  console.log('Connection check:', await svc.testConnection());
}

main().catch((e) => { console.error(e.response?.data || e); process.exit(1); });
