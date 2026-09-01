import { Page } from 'playwright';
export declare class SecuritySanityAgent {
    runSecurityChecks(page: Page): Promise<{
        success: boolean;
        issues: {
            mixedContent: boolean;
            missingHeaders: string[];
            insecureForms: boolean;
        };
        error?: never;
    } | {
        success: boolean;
        issues: {
            mixedContent: boolean;
            missingHeaders: string[];
            insecureForms: boolean;
        };
        error: any;
    }>;
}
//# sourceMappingURL=SecuritySanityAgent.d.ts.map