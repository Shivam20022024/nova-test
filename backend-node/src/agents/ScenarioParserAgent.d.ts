import { z } from 'zod';
export declare const scenarioSchema: z.ZodObject<{
    scenarios: z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        name: z.ZodString;
        steps: z.ZodArray<z.ZodString>;
        assertions: z.ZodArray<z.ZodString>;
        required: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare class ScenarioParserAgent {
    private executionId;
    constructor(executionId?: string);
    extractScenarioText(input: any): string;
    parse(customScenarioInput: any): Promise<{
        scenarios: any[];
        auth: any;
    }>;
}
//# sourceMappingURL=ScenarioParserAgent.d.ts.map