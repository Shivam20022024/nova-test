import 'dotenv/config';
import axios from 'axios';
const b = process.env.JIRA_BASE_URL!.replace(/\/$/, '');
const h = { Authorization: 'Basic ' + Buffer.from(process.env.JIRA_EMAIL + ':' + process.env.JIRA_API_TOKEN).toString('base64'), 'Content-Type': 'application/json', Accept: 'application/json' };
async function main() {
  const key = process.argv[2];
  if (!key) { console.log('usage: reset-issue.ts <KEY>  — removes novatest-tested/skipped so it can be re-processed'); return; }
  await axios.put(`${b}/rest/api/3/issue/${key}`, { update: { labels: [{ remove: 'novatest-tested' }, { remove: 'novatest-skipped' }] } }, { headers: h });
  const r = await axios.get(`${b}/rest/api/3/issue/${key}?fields=labels`, { headers: h });
  console.log(`${key} labels now:`, JSON.stringify(r.data.fields.labels));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e?.response?.data || e); process.exit(1); });
