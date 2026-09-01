export declare class ExecutionAgent {
    executeScript(executionId: string, scriptCode: string, browserName: string | undefined, emitLog: (type: string, message: string) => void, options?: {
        accessibility?: boolean;
        security?: boolean;
        sharedPage?: any;
        testCases?: any[];
        [key: string]: any;
    }, emitFrame?: (frame: string) => void): Promise<{
        success: boolean;
        error: string | null;
        screenshotUrl: string | null;
        videoUrl: string | null;
        stepLogs: {
            action: string;
            status: string;
            time: string;
            durationMs?: number;
            details?: string;
            value?: string;
            rawSelector?: string;
        }[];
        transcriptEvents: any[];
        accessibilityResults: any;
        securityResults: any;
        scenario_status: Record<string, string>;
    }>;
}
//# sourceMappingURL=ExecutionAgent.d.ts.map