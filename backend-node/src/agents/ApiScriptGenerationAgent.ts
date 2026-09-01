import { PromptTemplate } from '@langchain/core/prompts';
import { getModel } from './llm';

/**
 * Sibling to ScriptGenerationAgent.ts — turns a natural-language description
 * of an API test into the ApiStep[] JSON schema consumed by ApiExecutionAgent,
 * instead of Playwright action JSON.
 */
export class ApiScriptGenerationAgent {
  async generateApiSuite(testName: string, promptText: string): Promise<string> {
    const jsonSchema = {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
              url: { type: 'string' },
              headers: { type: ['string', 'null'], description: 'A JSON-stringified object of header key/value pairs, or null if none.' },
              body: { type: ['string', 'null'], description: 'A JSON-stringified request body, or null if none.' },
              scenarioName: { type: 'string' },
              assertions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['status', 'jsonPath', 'header', 'responseTime'] },
                    path: { type: ['string', 'null'] },
                    operator: { type: 'string', enum: ['equals', 'notEquals', 'contains', 'exists', 'greaterThan', 'lessThan'] },
                    expected: { type: ['string', 'number'], description: 'The expected value. Use a plain number for numeric comparisons (e.g. status codes), otherwise a string.' }
                  },
                  required: ['type', 'path', 'operator', 'expected'],
                  additionalProperties: false
                }
              },
              extract: {
                type: 'array',
                description: 'Values to capture from this response for reuse in later steps via {{name}} placeholders.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Variable name, referenced later as {{name}}.' },
                    from: { type: 'string', enum: ['body', 'header', 'status'] },
                    path: { type: ['string', 'null'], description: 'Dot-notation path into the response body (for from=body) or header name (for from=header). Null for from=status.' }
                  },
                  required: ['name', 'from', 'path'],
                  additionalProperties: false
                }
              }
            },
            required: ['method', 'url', 'headers', 'body', 'scenarioName', 'assertions', 'extract'],
            additionalProperties: false
          }
        }
      },
      required: ['steps'],
      additionalProperties: false
    };

    const llm = getModel('planner').withStructuredOutput(jsonSchema, { name: 'ApiScriptGeneration', strict: true });

    const generatePrompt = PromptTemplate.fromTemplate(`
You are an expert API test engineer. Convert the user's plain-English description of API test scenario(s)
into a JSON array of HTTP request steps for automated execution.

RULES:
1. Each distinct scenario described gets its own scenarioName and its own set of steps.
2. Infer sensible HTTP methods/URLs/bodies from the description. Use full absolute URLs when given, otherwise construct a reasonable one.
3. ALWAYS include at least one assertion per step — at minimum a 'status' assertion with operator 'equals' matching the expected status code (default 200 for success cases).
4. Use 'jsonPath' assertions (dot-notation, e.g. "0.title" or "data.id") to validate response body fields when the description mentions specific fields/values.
5. Use 'responseTime' assertions with operator 'lessThan' only if the user explicitly mentions performance/latency expectations.
6. Do NOT invent authentication headers unless explicitly described.
7. CHAINING: If the description implies one request's output feeds a later request (e.g. "create a resource, then fetch/update/delete it using the returned id"), use 'extract' on the earlier step to capture the value (e.g. {{"name":"userId","from":"body","path":"id"}}), then reference it in the later step's url/headers/body using {{userId}} placeholder syntax. Only extract values that are actually reused later.

Test Name: {testName}
Description:
{promptText}
`);

    const chain = generatePrompt.pipe(llm);
    const response: any = await chain.invoke({ testName, promptText });

    const tryParseJson = (val: any) => {
      if (val === null || val === undefined || val === '') return undefined;
      if (typeof val !== 'string') return val;
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    };

    const steps = (response?.steps || []).map((s: any) => ({
      method: s.method,
      url: s.url,
      headers: tryParseJson(s.headers),
      body: tryParseJson(s.body),
      scenarioName: s.scenarioName,
      assertions: (s.assertions || []).map((a: any) => ({
        type: a.type,
        path: a.path || undefined,
        operator: a.operator,
        expected: a.expected,
      })),
      extract: (s.extract || []).map((e: any) => ({
        name: e.name,
        from: e.from,
        path: e.path || undefined,
      })),
    }));

    if (steps.length === 0) {
      throw new Error('EMPTY_API_SCENARIO_STEPS: LLM returned zero steps for the given description.');
    }

    return JSON.stringify(steps);
  }
}
