export declare class ScriptGenerationAgent {
    private executionId;
    constructor(executionId?: string);
    generateScript(testName: string, steps: any[], isContinuation?: boolean): Promise<string>;
}
//# sourceMappingURL=ScriptGenerationAgent.d.ts.map