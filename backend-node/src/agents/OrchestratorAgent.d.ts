export declare class OrchestratorAgent {
    private executionId;
    private discoveryAgent;
    private reqAgent;
    private tcAgent;
    private dataAgent;
    private scriptAgent;
    private scenarioParserAgent;
    constructor(executionId?: string);
    planStrictScenarioQA(targetUrl: string, emitLog: (type: string, message: string) => void, emitProgress: (agent: string, status: string) => void, options: {
        sharedPage?: any;
        preDiscovered?: any;
        customScenarioText: string;
        preParsedScenarios?: any[];
        auth?: any;
    }): Promise<{
        success: boolean;
        error: string;
        requested_count: number;
        executionPlan?: never;
        testCases?: never;
    } | {
        success: boolean;
        executionPlan: string;
        testCases: any[];
        requested_count: number;
        error?: never;
    }>;
    planAutonomousQA(targetUrl: string, emitLog: (type: string, message: string) => void, emitProgress: (agent: string, status: string) => void, options?: {
        sharedPage?: any;
        mode?: string;
        preDiscovered?: {
            domSummary: string;
            capabilityMap: any;
            discoveredFlows: any[];
            fingerprint: string;
        };
        customScenario?: any[];
    }): Promise<{
        success: boolean;
        executionPlan: string;
        testCases: any[];
        fingerprint: string;
        error?: never;
    } | {
        success: boolean;
        error: any;
        executionPlan?: never;
        testCases?: never;
        fingerprint?: never;
    }>;
}
//# sourceMappingURL=OrchestratorAgent.d.ts.map