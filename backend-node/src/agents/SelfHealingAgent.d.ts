export declare class SelfHealingAgent {
    private executionId;
    constructor(executionId?: string);
    healSelector(errorMessage: string, elementDesc: string, domSnapshot: string): Promise<any[]>;
}
//# sourceMappingURL=SelfHealingAgent.d.ts.map