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
