import { ChatOpenAI } from '@langchain/openai';
export declare const truncateContext: (text: string, maxTokens: number) => string;
export declare const getModel: (modelType?: "planner" | "cheap") => ChatOpenAI<import("@langchain/openai").ChatOpenAICallOptions>;
export interface LlmContext {
    executionId: string;
    agentName: string;
    promptType: string;
}
export declare const invokeWithRetry: (modelOrChain: any, input: any, maxTokens: number, contextKeysToTruncate?: string[], context?: LlmContext) => Promise<any>;
//# sourceMappingURL=llm.d.ts.map