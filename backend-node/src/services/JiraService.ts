import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';

export class JiraService {
  private baseUrl: string;
  private email: string;
  private apiToken: string;
  private projectKey: string;
  private issueType: string;

  constructor(baseUrl: string, email: string, apiToken: string, projectKey: string, issueType: string = 'Bug') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.email = email;
    this.apiToken = apiToken;
    this.projectKey = projectKey;
    this.issueType = issueType;
  }

  private getAuthHeader() {
    const token = Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
    return {
      'Authorization': `Basic ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  async testConnection() {
    try {
      const response = await axios.get(`${this.baseUrl}/rest/api/3/project/${this.projectKey}`, {
        headers: this.getAuthHeader()
      });
      return response.status === 200;
    } catch (error: any) {
      console.error('[JiraService] testConnection failed:', error.message);
      return false;
    }
  }

  async healthCheck() {
    let jiraConnected = false;
    let projectVerified = false;
    let authenticationStatus = 'Failed';
    let availableProjects: any[] = [];
    
    try {
       const searchRes = await axios.get(`${this.baseUrl}/rest/api/3/project/search`, {
         headers: this.getAuthHeader()
       });
       if (searchRes.status === 200) {
         jiraConnected = true;
         authenticationStatus = 'Valid';
         availableProjects = searchRes.data?.values || searchRes.data || [];
       }
    } catch (e: any) {
      if (e.response?.status === 401 || e.response?.status === 403) {
         authenticationStatus = 'Invalid Credentials';
      }
    }

    if (jiraConnected) {
       try {
         const projRes = await axios.get(`${this.baseUrl}/rest/api/3/project/${this.projectKey}`, {
           headers: this.getAuthHeader()
         });
         if (projRes.status === 200) {
           projectVerified = true;
         }
       } catch (e: any) {
         projectVerified = false;
       }
    }
    
    return {
      jiraConnected,
      projectVerified,
      authenticationStatus,
      availableProjects: availableProjects.map((p: any) => ({ key: p.key, name: p.name }))
    };
  }

  async createIssue(summary: string, descriptionText: string | any[]): Promise<{ key: string; url: string } | null> {
    try {
      // Step 1 & 2: Verify Authentication (Basic Auth is used)
      let user;
      try {
        const myselfRes = await axios.get(`${this.baseUrl}/rest/api/3/myself`, {
          headers: this.getAuthHeader()
        });
        user = myselfRes.data;
        console.log("Authentication Successful");
        console.log("Authenticated User:\n" + (user.emailAddress || user.name || this.email));
      } catch (authErr: any) {
        throw new Error(`Authentication failed. Check API token and email. Status: ${authErr.response?.status}`);
      }

      // Step 4: Validate Project Access
      let project;
      try {
        const projRes = await axios.get(`${this.baseUrl}/rest/api/3/project/${this.projectKey}`, {
          headers: this.getAuthHeader()
        });
        project = projRes.data;
        console.log(`Project Verified:\n${this.projectKey}`);
      } catch (projErr: any) {
        console.error("Project access failed");
        
        // Step 5: Validate Project Discovery
        try {
          const searchRes = await axios.get(`${this.baseUrl}/rest/api/3/project/search`, {
            headers: this.getAuthHeader()
          });
          console.log("Available Jira Projects:", searchRes.data?.values || searchRes.data);
        } catch (searchErr) {
          console.error("Failed to fetch available projects");
        }
        
        throw new Error(`Project validation failed. Project key '${this.projectKey}' may be invalid or missing permissions.`);
      }

      // Step 6: Validate Issue Types
      let finalIssueType = this.issueType || 'Task';
      let issueTypesData: any[] = [];
      try {
        const typeRes = await axios.get(`${this.baseUrl}/rest/api/3/issuetype`, {
          headers: this.getAuthHeader()
        });
        issueTypesData = typeRes.data;
        const typeNames = issueTypesData.map((t: any) => t.name);
        console.log("Issue Types:\n" + typeNames.join('\n'));
        if (finalIssueType === 'Bug' && !typeNames.includes('Bug')) {
          finalIssueType = 'Task';
        }
      } catch (typeErr: any) {
        console.error("Failed to fetch issue types");
      }

      // Step 7: Improve Logging
      console.log("Auth Test Result");
      console.log("User:", user);
      console.log("Project Test Result");
      console.log("Project:", project);
      console.log("Issue Types:");
      console.log(issueTypesData);

      const payload = {
        fields: {
          project: {
            key: this.projectKey
          },
          summary: summary,
          description: Array.isArray(descriptionText) ? {
            type: "doc",
            version: 1,
            content: descriptionText
          } : {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: descriptionText
                  }
                ]
              }
            ]
          },
          issuetype: {
            name: finalIssueType
          }
        }
      };

      console.log("JIRA BASE URL:", this.baseUrl);
      console.log("PROJECT KEY:", this.projectKey);
      console.log("ISSUE TYPE:", finalIssueType);
      console.log("AUTH USER:", this.email);
      console.log("PAYLOAD:", JSON.stringify(payload, null, 2));

      console.log("Creating Issue...");
      const response = await axios.post(`${this.baseUrl}/rest/api/3/issue`, payload, {
        headers: this.getAuthHeader()
      });

      const key = response.data.key;
      const url = `${this.baseUrl}/browse/${key}`;
      console.log(`Issue Created:\n${key}`);
      return { key, url };
    } catch (error: any) {
      console.error('[JiraService] createIssue failed:', error.response?.data || error.message);
      return null;
    }
  }

  async attachFile(issueKey: string, filePath: string, filename: string): Promise<boolean> {
    try {
      if (!fs.existsSync(filePath)) {
        console.error(`[JiraService] File not found: ${filePath}`);
        return false;
      }

      const formData = new FormData();
      formData.append('file', fs.createReadStream(filePath), { filename });

      const headers = {
        'Authorization': this.getAuthHeader().Authorization,
        'X-Atlassian-Token': 'no-check',
        ...formData.getHeaders()
      };

      const response = await axios.post(`${this.baseUrl}/rest/api/3/issue/${issueKey}/attachments`, formData, {
        headers
      });

      return response.status === 200;
    } catch (error: any) {
      console.error('[JiraService] attachFile failed:', error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Same purpose as attachFile, for evidence that already lives as a URL
   * (mobile evidence is uploaded straight to Supabase Storage — see
   * backend/mobile/artifact_store.py — so there is no local file to stream).
   * Takes the bytes directly rather than a path so the caller controls how
   * they were fetched.
   */
  async attachBuffer(issueKey: string, data: Buffer, filename: string): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append('file', data, { filename });

      const headers = {
        'Authorization': this.getAuthHeader().Authorization,
        'X-Atlassian-Token': 'no-check',
        ...formData.getHeaders()
      };

      const response = await axios.post(`${this.baseUrl}/rest/api/3/issue/${issueKey}/attachments`, formData, {
        headers
      });

      return response.status === 200;
    } catch (error: any) {
      console.error('[JiraService] attachBuffer failed:', error.response?.data || error.message);
      return false;
    }
  }

  // ==========================================================================
  // Jira Intake — inbound direction (a bug raised in Jira triggers a run).
  // See src/services/jiraIntakeService.ts. Every method here is best-effort:
  // it returns null / [] / false on any failure and never throws, matching the
  // posture of testConnection / createIssue / attachFile above, so a flaky Jira
  // can never crash the poller or a run.
  // ==========================================================================

  /**
   * JQL search. Returns the `issues` array (each with a small `fields` subset:
   * summary / updated / reporter / labels / status), or [] on failure.
   *
   * Uses `/rest/api/3/search/jql` — Atlassian REMOVED the old
   * `/rest/api/3/search` (changelog CHANGE-2046). The new endpoint is leaner:
   * request only the fields you need and fetch the rest per-issue via
   * getIssue() (which jiraIntakeService.assembleIssueContext already does).
   */
  async searchIssues(jql: string, maxResults: number = 25): Promise<any[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/rest/api/3/search/jql`, {
        headers: this.getAuthHeader(),
        params: {
          jql,
          maxResults,
          fields: 'summary,updated,reporter,labels,status,issuetype',
        },
      });
      return Array.isArray(response.data?.issues) ? response.data.issues : [];
    } catch (error: any) {
      console.error('[JiraService] searchIssues failed:', error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Full issue payload. `expand=names` gives the human label for every
   * `customfield_*`; `renderedFields` gives HTML-rendered values; `issuelinks`
   * is already in `fields` but expanding keeps parity with searchIssues.
   */
  async getIssue(issueKey: string, expand: string = 'names,renderedFields'): Promise<any | null> {
    try {
      const response = await axios.get(`${this.baseUrl}/rest/api/3/issue/${issueKey}`, {
        headers: this.getAuthHeader(),
        params: { expand },
      });
      return response.data || null;
    } catch (error: any) {
      console.error(`[JiraService] getIssue(${issueKey}) failed:`, error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Add a comment to an issue — this is "reply to the thread". `body` is the
   * same ADF `content[]` array shape createIssue() already builds. Returns a
   * permalink to the new comment (or null on failure).
   */
  async addComment(issueKey: string, body: string | any[]): Promise<{ id: string; url: string } | null> {
    try {
      const adfBody = Array.isArray(body)
        ? { type: 'doc', version: 1, content: body }
        : { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] };
      const response = await axios.post(
        `${this.baseUrl}/rest/api/3/issue/${issueKey}/comment`,
        { body: adfBody },
        { headers: this.getAuthHeader() },
      );
      const id = String(response.data?.id ?? '');
      return { id, url: `${this.baseUrl}/browse/${issueKey}?focusedCommentId=${id}` };
    } catch (error: any) {
      console.error(`[JiraService] addComment(${issueKey}) failed:`, error.response?.data || error.message);
      return null;
    }
  }

  /** Add labels to an issue without touching its other fields. */
  async addLabels(issueKey: string, labels: string[]): Promise<boolean> {
    try {
      const add = labels.filter(Boolean).map((name) => ({ add: name }));
      if (add.length === 0) return true;
      const response = await axios.put(
        `${this.baseUrl}/rest/api/3/issue/${issueKey}`,
        { update: { labels: add } },
        { headers: this.getAuthHeader() },
      );
      return response.status >= 200 && response.status < 300;
    } catch (error: any) {
      console.error(`[JiraService] addLabels(${issueKey}) failed:`, error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Flatten an Atlassian Document Format node to clean plain text. Jira returns
   * descriptions, comments and rich custom fields as ADF (nested JSON), so the
   * analysis agent needs this to read them. Handles the node types that
   * actually appear in bug reports: paragraphs, headings, bullet/ordered lists,
   * blockquotes, code blocks, tables, links, hard breaks, mentions, emoji.
   */
  static adfToText(node: any): string {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map((n) => JiraService.adfToText(n)).join('');

    const kids = () => (Array.isArray(node.content) ? node.content.map((n: any) => JiraService.adfToText(n)).join('') : '');

    switch (node.type) {
      case 'doc':
        return kids().trim();
      case 'text':
        return node.text || '';
      case 'hardBreak':
        return '\n';
      case 'paragraph':
      case 'heading':
        return kids() + '\n';
      case 'blockquote':
        return kids().split('\n').map((l: string) => (l ? `> ${l}` : l)).join('\n') + '\n';
      case 'bulletList':
      case 'orderedList':
        return kids();
      case 'listItem':
        return `- ${kids().trim()}\n`;
      case 'codeBlock':
        return '```\n' + kids() + '\n```\n';
      case 'rule':
        return '\n---\n';
      case 'table':
      case 'tableRow':
        return kids() + '\n';
      case 'tableHeader':
      case 'tableCell':
        return kids().trim() + ' | ';
      case 'mention':
        return `@${node.attrs?.text || node.attrs?.displayName || 'user'}`;
      case 'emoji':
        return node.attrs?.shortName || node.attrs?.text || '';
      case 'inlineCard':
      case 'blockCard':
        return node.attrs?.url || '';
      default:
        return kids();
    }
  }

  /**
   * The result comment NovaTest posts back on a Jira-triggered issue. Same ADF
   * builder style as generateBugReportAdf below. `intent` is the TestIntent the
   * JiraIssueAnalysisAgent produced; `execution` is the finished ExecutionLog
   * row (its stepLogs parsed or string).
   */
  static generateIntakeResultAdf(execution: any, intent: any, reportUrl: string): any[] {
    let steps: any[] = [];
    try {
      steps = typeof execution.stepLogs === 'string' ? JSON.parse(execution.stepLogs) : (execution.stepLogs || []);
    } catch { steps = []; }
    if (!Array.isArray(steps)) steps = [];

    const passedCount = steps.filter((s: any) => s.status === 'PASS' || s.status === 'PASSED').length;
    const total = steps.length;
    const failedStep = steps.find((s: any) => s.status === 'FAIL' || s.status === 'FAILED' || s.status === 'ERROR' || s.error);

    const status = String(execution.status || '').toUpperCase();
    const passed = status === 'PASSED' || status === 'COMPLETED';
    const verdict = passed ? 'PASSED' : (status === 'BLOCKED' ? 'BLOCKED' : 'FAILED');

    const firstFailure = failedStep
      ? `Step ${(steps.indexOf(failedStep) + 1)} "${failedStep.action || failedStep.scenarioName || 'step'}"${failedStep.target ? ` on ${failedStep.target}` : ''}: ${failedStep.error || failedStep.details || 'failed'}`
      : null;

    const assumptions: string[] = Array.isArray(intent?.missingInfo) ? intent.missingInfo : [];
    const confidence = intent?.confidence || 'unknown';

    const adf: any[] = [];
    const addHeading = (text: string, level: number = 3) =>
      adf.push({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
    const addPara = (text: string) =>
      adf.push({ type: 'paragraph', content: [{ type: 'text', text }] });
    const addBullet = (label: string, value: string, linkUrl?: string) => {
      const content: any[] = [{ type: 'text', text: `${label}: `, marks: [{ type: 'strong' }] }];
      if (linkUrl) content.push({ type: 'text', text: value, marks: [{ type: 'link', attrs: { href: linkUrl } }] });
      else content.push({ type: 'text', text: value });
      return { type: 'listItem', content: [{ type: 'paragraph', content }] };
    };

    addPara('🤖 NovaTest AI ran automated checks for this bug (triggered from this issue).');

    addHeading(`Result: ${verdict}`);
    adf.push({
      type: 'bulletList',
      content: [
        addBullet('Checks passed', `${passedCount} of ${total}`),
        addBullet('Browser', execution.browser || 'chromium'),
        addBullet('Duration', execution.durationMs != null ? `${(execution.durationMs / 1000).toFixed(1)}s` : 'n/a'),
        addBullet('AI confidence in the generated test', String(confidence)),
      ],
    });

    if (intent?.understood) {
      addHeading('What was tested');
      addPara(String(intent.understood));
    }

    if (firstFailure) {
      addHeading('First failure');
      addPara(firstFailure);
    }

    if (assumptions.length > 0) {
      addHeading('Assumptions NovaTest made');
      adf.push({
        type: 'bulletList',
        content: assumptions.slice(0, 8).map((a) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: String(a) }] }] })),
      });
    }

    addHeading('Full report');
    adf.push({ type: 'bulletList', content: [addBullet('NovaTest dashboard', 'Open the complete execution report', reportUrl)] });

    return adf;
  }

  /**
   * Mobile equivalent of generateBugReportAdf. Deliberately a separate
   * function rather than a branch inside the web one: the two execution
   * shapes share almost no field names (device/Appium/locator vs.
   * browser/DOM/selector), so branching field-by-field would be harder to
   * read than two short, independent builders.
   */
  static generateMobileBugReportAdf(execution: any, test: any, device: any, reportUrl: string): any[] {
    const stepResults: any[] = Array.isArray(execution.step_results) ? execution.step_results : [];
    const failedStep = stepResults.find((s: any) => s.status === 'FAILED' || s.status === 'BLOCKED');

    const testName = test?.name || `Mobile test ${execution.test_id}`;
    const deviceLabel = device ? `${device.model || device.serial}${device.android_version ? ` (Android ${device.android_version})` : ''}` : 'Not available in execution data';
    const action = failedStep?.action || 'Not available in execution data';
    const locatorValue = failedStep?.resolved_locator?.value || failedStep?.locator?.value || 'Not available in execution data';
    const errorMsg = failedStep?.actual || execution.result_json?.error || 'Not available in execution data';

    const failureSummary = `Mobile test '${testName}' failed on ${deviceLabel}. The test failed while executing '${action}' on locator '${locatorValue}'. Error: ${errorMsg}`;
    const expectedBehavior = action !== 'Not available in execution data'
      ? `The automated test was expected to successfully complete the action: '${action}' on '${locatorValue}'.`
      : `The automated test was expected to complete all steps without failure.`;
    const actualBehavior = `During execution, step ${failedStep?.step_index ?? '?'} failed and the run could not proceed. Actual error observed: ${errorMsg}`;

    const adf: any[] = [];
    const addHeading = (text: string, level: number = 2) => {
      adf.push({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
    };
    const addBullet = (label: string, value: string, linkUrl?: string) => {
      const content: any[] = [{ type: "text", text: `${label}: `, marks: [{ type: "strong" }] }];
      if (linkUrl && value !== 'Not available in execution data') {
        content.push({ type: "text", text: value, marks: [{ type: "link", attrs: { href: linkUrl } }] });
      } else {
        content.push({ type: "text", text: value || 'Not available in execution data' });
      }
      return { type: "listItem", content: [{ type: "paragraph", content }] };
    };

    addHeading("Mobile Test Execution Failure Report", 2);

    addHeading("Failure Summary", 3);
    adf.push({ type: "paragraph", content: [{ type: "text", text: failureSummary }] });

    addHeading("Execution Details", 3);
    adf.push({
      type: "bulletList",
      content: [
        addBullet("Execution ID", String(execution.id ?? 'Not available in execution data')),
        addBullet("Test", testName),
        addBullet("Device", deviceLabel),
        addBullet("Execution status", execution.status || 'Not available in execution data'),
        addBullet("Timestamp", execution.started_at ? new Date(execution.started_at).toISOString() : 'Not available in execution data'),
      ]
    });

    addHeading("Expected Behavior", 3);
    adf.push({ type: "paragraph", content: [{ type: "text", text: expectedBehavior }] });

    addHeading("Actual Behavior", 3);
    adf.push({ type: "paragraph", content: [{ type: "text", text: actualBehavior }] });

    addHeading("Full Execution Report", 3);
    adf.push({
      type: "bulletList",
      content: [
        addBullet("NovaTest Dashboard", "View Complete Execution Report", reportUrl)
      ]
    });

    return adf;
  }

  /** Shared by generateApiBugReportAdf/generateDbBugReportAdf below — both
   *  ApiExecution and DbTestExecution rows carry the same step-log shape
   *  (see queue/apiDbTestWorker.ts), so the failed-step lookup is identical;
   *  only the summary wording and the extra execution-specific bullet differ. */
  private static findFailedStep(execution: any): any {
    const stepLogs: any[] = Array.isArray(execution.stepLogs) ? execution.stepLogs : [];
    return stepLogs.find((s: any) => s.status === 'FAILED') || null;
  }

  static generateApiBugReportAdf(execution: any, reportUrl: string): any[] {
    const failedStep = JiraService.findFailedStep(execution);
    const testName = execution.name || `API test ${execution.id}`;
    const detail = failedStep?.details || execution.error || 'Not available in execution data';

    const failureSummary = `API test '${testName}' failed. ${failedStep ? `The test failed on step '${failedStep.action}'. ` : ''}Error: ${detail}`;
    const expectedBehavior = 'The automated test was expected to complete all HTTP requests and assertions without failure.';
    const actualBehavior = `During execution, the run could not proceed. Actual error observed: ${detail}`;

    const adf: any[] = [];
    const addHeading = (text: string, level: number = 2) => {
      adf.push({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
    };
    const addBullet = (label: string, value: string, linkUrl?: string) => {
      const content: any[] = [{ type: 'text', text: `${label}: `, marks: [{ type: 'strong' }] }];
      if (linkUrl && value !== 'Not available in execution data') {
        content.push({ type: 'text', text: value, marks: [{ type: 'link', attrs: { href: linkUrl } }] });
      } else {
        content.push({ type: 'text', text: value || 'Not available in execution data' });
      }
      return { type: 'listItem', content: [{ type: 'paragraph', content }] };
    };

    addHeading('API Test Execution Failure Report', 2);
    addHeading('Failure Summary', 3);
    adf.push({ type: 'paragraph', content: [{ type: 'text', text: failureSummary }] });
    addHeading('Execution Details', 3);
    adf.push({
      type: 'bulletList',
      content: [
        addBullet('Execution ID', String(execution.id ?? 'Not available in execution data')),
        addBullet('Test', testName),
        addBullet('Execution status', execution.status || 'Not available in execution data'),
        addBullet('Timestamp', execution.startedAt ? new Date(execution.startedAt).toISOString() : 'Not available in execution data'),
      ],
    });
    addHeading('Expected Behavior', 3);
    adf.push({ type: 'paragraph', content: [{ type: 'text', text: expectedBehavior }] });
    addHeading('Actual Behavior', 3);
    adf.push({ type: 'paragraph', content: [{ type: 'text', text: actualBehavior }] });
    addHeading('Full Execution Report', 3);
    adf.push({ type: 'bulletList', content: [addBullet('NovaTest Dashboard', 'View Complete Execution Report', reportUrl)] });

    return adf;
  }

  static generateDbBugReportAdf(execution: any, reportUrl: string): any[] {
    const failedStep = JiraService.findFailedStep(execution);
    const testName = execution.name || `Database test ${execution.id}`;
    const detail = failedStep?.details || execution.error || 'Not available in execution data';

    const failureSummary = `Database test '${testName}' failed. ${failedStep ? `The test failed on step '${failedStep.action}'. ` : ''}Error: ${detail}`;
    const expectedBehavior = 'The automated test was expected to complete all queries and assertions without failure, with every write rolled back unless explicitly committed.';
    const actualBehavior = `During execution, the run could not proceed. Actual error observed: ${detail}`;

    const adf: any[] = [];
    const addHeading = (text: string, level: number = 2) => {
      adf.push({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
    };
    const addBullet = (label: string, value: string, linkUrl?: string) => {
      const content: any[] = [{ type: 'text', text: `${label}: `, marks: [{ type: 'strong' }] }];
      if (linkUrl && value !== 'Not available in execution data') {
        content.push({ type: 'text', text: value, marks: [{ type: 'link', attrs: { href: linkUrl } }] });
      } else {
        content.push({ type: 'text', text: value || 'Not available in execution data' });
      }
      return { type: 'listItem', content: [{ type: 'paragraph', content }] };
    };

    addHeading('Database Test Execution Failure Report', 2);
    addHeading('Failure Summary', 3);
    adf.push({ type: 'paragraph', content: [{ type: 'text', text: failureSummary }] });
    addHeading('Execution Details', 3);
    adf.push({
      type: 'bulletList',
      content: [
        addBullet('Execution ID', String(execution.id ?? 'Not available in execution data')),
        addBullet('Test', testName),
        addBullet('Connection', String(execution.connectionId ?? 'Not available in execution data')),
        addBullet('Execution status', execution.status || 'Not available in execution data'),
        addBullet('Timestamp', execution.startedAt ? new Date(execution.startedAt).toISOString() : 'Not available in execution data'),
      ],
    });
    addHeading('Expected Behavior', 3);
    adf.push({ type: 'paragraph', content: [{ type: 'text', text: expectedBehavior }] });
    addHeading('Actual Behavior', 3);
    adf.push({ type: 'paragraph', content: [{ type: 'text', text: actualBehavior }] });
    addHeading('Full Execution Report', 3);
    adf.push({ type: 'bulletList', content: [addBullet('NovaTest Dashboard', 'View Complete Execution Report', reportUrl)] });

    return adf;
  }

  static generateBugReportAdf(execution: any, reportUrl: string): any[] {
    let failedStep: any = null;
    try {
      if (execution.stepLogs) {
        const steps = typeof execution.stepLogs === 'string' ? JSON.parse(execution.stepLogs) : execution.stepLogs;
        if (Array.isArray(steps)) {
          failedStep = steps.find((s: any) => s.status === 'FAIL' || s.status === 'FAILED' || s.status === 'ERROR' || s.error);
        }
      }
    } catch (e) {}

    let logErrorMsg = null;
    let rootCause = 'Root cause could not be determined from the available execution data.';
    if (execution.logs) {
      // executionWorker logs errors like "[Error] message" or similar. We need to catch "[Error]" as well.
      const match = execution.logs.match(/(?:\[Error\]|Error|TimeoutError|AssertionError|Exception)[:\s]+(.*)/i);
      if (match) {
        logErrorMsg = match[1].trim();
        const lowerErr = logErrorMsg.toLowerCase();
        if (lowerErr.includes('timeout') && lowerErr.includes('waiting for selector')) rootCause = 'Timeout waiting for element';
        else if (lowerErr.includes('not found') || lowerErr.includes('no element found')) rootCause = 'Element not found';
        else if (lowerErr.includes('invalid selector')) rootCause = 'Invalid selector';
        else if (lowerErr.includes('net::err')) rootCause = 'Network error';
        else if (lowerErr.includes('assertion')) rootCause = 'Assertion failure';
      }
    }

    const action = failedStep?.action || 'Not available in execution data';
    const target = failedStep?.target || failedStep?.rawSelector || 'Not available in execution data';
    let errorMsg = failedStep?.error || failedStep?.details || logErrorMsg || 'Not available in execution data';

    const testName = execution.testName || execution.suite?.name || 'Not available in execution data';
    const browser = execution.browser || 'Not available in execution data';

    const failureSummary = `Test execution for '${testName}' failed on browser ${browser}. The test failed while executing '${action}' on '${target}'. Error: ${errorMsg}`;

    const expectedBehavior = action !== 'Not available in execution data' 
      ? `The automated test was expected to successfully complete the action: '${action}' on '${target}'.`
      : `The automated test was expected to complete all scenarios without assertions or timeouts.`;
      
    const actualBehavior = `During execution, the test encountered an error and could not proceed. Actual error observed: ${errorMsg}`;

    const adf: any[] = [];

    const addHeading = (text: string, level: number = 2) => {
      adf.push({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
    };

    const addBullet = (label: string, value: string, linkUrl?: string) => {
      const content: any[] = [{ type: "text", text: `${label}: `, marks: [{ type: "strong" }] }];
      if (linkUrl && value !== 'Not available in execution data') {
        content.push({ type: "text", text: value, marks: [{ type: "link", attrs: { href: linkUrl } }] });
      } else {
        content.push({ type: "text", text: value || 'Not available in execution data' });
      }
      return { type: "listItem", content: [{ type: "paragraph", content }] };
    };

    addHeading("Test Execution Failure Report", 2);

    addHeading("Failure Summary", 3);
    adf.push({ type: "paragraph", content: [{ type: "text", text: failureSummary }] });

    addHeading("Execution Details", 3);
    adf.push({
      type: "bulletList",
      content: [
        addBullet("Execution ID", execution.id || 'Not available in execution data'),
        addBullet("Target URL", execution.targetUrl || 'Not available in execution data', execution.targetUrl),
        addBullet("Browser", browser),
        addBullet("Test/Suite name", testName),
        addBullet("Execution status", execution.status || 'Not available in execution data'),
        addBullet("Timestamp", execution.createdAt ? new Date(execution.createdAt).toISOString() : 'Not available in execution data')
      ]
    });

    addHeading("Expected Behavior", 3);
    adf.push({ type: "paragraph", content: [{ type: "text", text: expectedBehavior }] });

    addHeading("Actual Behavior", 3);
    adf.push({ type: "paragraph", content: [{ type: "text", text: actualBehavior }] });

    addHeading("Full Execution Report", 3);
    adf.push({
      type: "bulletList",
      content: [
        addBullet("NovaTest Dashboard", "View Complete Execution Report", reportUrl)
      ]
    });

    return adf;
  }
}
