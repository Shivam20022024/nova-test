export declare class JiraService {
    private baseUrl;
    private email;
    private apiToken;
    private projectKey;
    private issueType;
    constructor(baseUrl: string, email: string, apiToken: string, projectKey: string, issueType?: string);
    private getAuthHeader;
    testConnection(): Promise<boolean>;
    createIssue(summary: string, descriptionText: string): Promise<{
        key: string;
        url: string;
    } | null>;
    attachFile(issueKey: string, filePath: string, filename: string): Promise<boolean>;
}
//# sourceMappingURL=JiraService.d.ts.map