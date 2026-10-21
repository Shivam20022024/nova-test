import 'dotenv/config';
import axios from 'axios';
const b = process.env.JIRA_BASE_URL!.replace(/\/$/, '');
const h = { Authorization: 'Basic ' + Buffer.from(process.env.JIRA_EMAIL + ':' + process.env.JIRA_API_TOKEN).toString('base64'), Accept: 'application/json' };
async function main() {
  const key = process.argv[2];
  if (!key) { console.log('usage: cleanup-comments.ts <ISSUE-KEY>  (keeps newest NovaTest comment, deletes older ones)'); return; }
  const r = await axios.get(`${b}/rest/api/3/issue/${key}/comment`, { headers: h });
  const nova = (r.data.comments || []).filter((c: any) => JSON.stringify(c.body).includes('NovaTest AI'));
  for (const c of nova.slice(0, -1)) {
    await axios.delete(`${b}/rest/api/3/issue/${key}/comment/${c.id}`, { headers: h });
    console.log('deleted comment', c.id);
  }
  console.log(`kept ${Math.min(1, nova.length)} NovaTest comment on ${key}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e?.response?.data || e); process.exit(1); });
