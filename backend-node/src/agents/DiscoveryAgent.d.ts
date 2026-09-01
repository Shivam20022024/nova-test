export declare function extractCompactDom(page: any): Promise<any>;
export declare class DiscoveryAgent {
    private executionId;
    constructor(executionId?: string);
    discoverFlows(targetUrl: string, maxPages?: number, options?: {
        sharedPage?: any;
        discoveryPath?: string;
    }): Promise<{
        flows: any;
        domSummary: string;
    }>;
    detectCapabilities(domSummary: string): Promise<Record<string, boolean>>;
}
//# sourceMappingURL=DiscoveryAgent.d.ts.map