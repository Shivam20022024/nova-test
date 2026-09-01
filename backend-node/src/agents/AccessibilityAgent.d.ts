import { Page } from 'playwright';
export declare class AccessibilityAgent {
    runAccessibilityScan(page: Page): Promise<{
        success: boolean;
        violations: {
            id: string;
            impact: import("axe-core").ImpactValue | undefined;
            description: string;
            nodes: number;
        }[];
        error?: never;
    } | {
        success: boolean;
        error: any;
        violations: never[];
    }>;
}
//# sourceMappingURL=AccessibilityAgent.d.ts.map