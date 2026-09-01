export declare class ReportingAgent {
    generateReport(executionId: string, data: any): Promise<{
        content: {
            status: string;
            ai_summary: string;
            reason: string | null;
            health_score: number;
            ai_confidence_score: number;
            interaction_success_rate: number;
            dom_stability: string;
            validation_results: string[];
            url: string;
            duration: number;
            browser: string;
            environment: string;
            workflow: string;
            recommendations: string[];
            timeline: {
                time: string;
                event: string;
                status: string;
            }[];
            detected_issues: string[] | null;
            screenshot_analysis: string | null;
            markdown_report: string | null;
        };
        url: string;
        isJson: boolean;
    } | {
        content: {
            status: string;
            ai_summary: string;
            reason: string | null;
            health_score: number;
            ai_confidence_score: number;
            interaction_success_rate: number;
            dom_stability: string;
            validation_results: string[];
            url: string;
            duration: number;
            browser: string;
            environment: string;
            workflow: string;
            recommendations: string[];
            timeline: {
                time: string;
                event: string;
                status: string;
            }[];
            detected_issues: string[] | null;
            screenshot_analysis: string | null;
            markdown_report: string | null;
        };
        url: null;
        isJson: boolean;
    } | {
        content: null;
        url: null;
        isJson: boolean;
    }>;
}
//# sourceMappingURL=ReportingAgent.d.ts.map