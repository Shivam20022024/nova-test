import { PromptTemplate } from '@langchain/core/prompts';
import { getModel } from './llm';

/**
 * Sibling to ApiScriptGenerationAgent.ts — turns a natural-language
 * description of a database check into the DbStep[] JSON schema consumed
 * by DbExecutionAgent. Engine-aware: generates SQL for postgres/mysql or a
 * Mongo operation for mongodb.
 *
 * Safety-critical: write operations (INSERT/UPDATE/DELETE, or Mongo
 * insert/update/delete) are permitted, but every generated write step
 * defaults to commit=false (auto-rolled-back) unless the user's
 * description explicitly asks for the change to be kept/persisted. DDL and
 * admin statements are never generated — if asked for one, the agent must
 * return zero steps rather than attempt a workaround the executor would
 * reject anyway.
 */
export class DbScriptGenerationAgent {
  async generateDbSuite(testName: string, promptText: string, engine: string): Promise<string> {
    const jsonSchema = {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scenarioName: { type: 'string' },
              query: { type: ['string', 'null'], description: 'A SELECT/WITH/INSERT/UPDATE/DELETE SQL statement. Null for MongoDB.' },
              collection: { type: ['string', 'null'], description: 'MongoDB collection name. Null for SQL engines.' },
              operation: { type: ['string', 'null'], enum: ['find', 'aggregate', 'countDocuments', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', null], description: 'MongoDB operation. Null for SQL engines.' },
              filter: { type: ['string', 'null'], description: 'A JSON-stringified MongoDB filter object for find/countDocuments/updateOne/updateMany/deleteOne/deleteMany. Null otherwise.' },
              pipeline: { type: ['string', 'null'], description: 'A JSON-stringified MongoDB aggregation pipeline array for aggregate. Null otherwise.' },
              document: { type: ['string', 'null'], description: 'A JSON-stringified document (insertOne) or array of documents (insertMany) to insert. Null otherwise.' },
              update: { type: ['string', 'null'], description: 'A JSON-stringified MongoDB update document (e.g. {"$set": {...}}) for updateOne/updateMany. Null otherwise.' },
              commit: { type: 'boolean', description: 'Whether a write step\'s change should be permanently kept (true) or automatically rolled back after the test (false). Default false unless the user explicitly asks to keep/persist the change. Always false for read-only steps.' },
              assertions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['rowCount', 'cellValue', 'jsonPath', 'schemaColumns'] },
                    path: { type: ['string', 'null'], description: 'For cellValue/jsonPath: dot-path into the result rows array, e.g. "0.email". Null for rowCount/schemaColumns.' },
                    operator: { type: 'string', enum: ['equals', 'notEquals', 'contains', 'exists', 'greaterThan', 'lessThan'] },
                    expected: { type: ['string', 'number'], description: 'The expected value. Numeric for rowCount comparisons, otherwise a string (comma-separated column names for schemaColumns).' }
                  },
                  required: ['type', 'path', 'operator', 'expected'],
                  additionalProperties: false
                }
              },
              extract: {
                type: 'array',
                description: 'Values to capture from this query result for reuse in later steps via {{name}} placeholders.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Variable name, referenced later as {{name}}.' },
                    path: { type: 'string', description: 'Dot-path into the result rows array, e.g. "0.id".' }
                  },
                  required: ['name', 'path'],
                  additionalProperties: false
                }
              }
            },
            required: ['scenarioName', 'query', 'collection', 'operation', 'filter', 'pipeline', 'document', 'update', 'commit', 'assertions', 'extract'],
            additionalProperties: false
          }
        }
      },
      required: ['steps'],
      additionalProperties: false
    };

    const llm = getModel('planner').withStructuredOutput(jsonSchema, { name: 'DbScriptGeneration', strict: true });

    const generatePrompt = PromptTemplate.fromTemplate(`
You are an expert database test engineer. Convert the user's plain-English description of database check(s)
into a JSON array of query steps for automated execution against a {engine} database.

CRITICAL SAFETY RULES — READ THIS FIRST:
1. Only SELECT/WITH/INSERT/UPDATE/DELETE SQL statements are permitted for SQL engines, and only
   find/aggregate/countDocuments/insertOne/insertMany/updateOne/updateMany/deleteOne/deleteMany for MongoDB.
   DDL/admin statements (DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, or similar) are NEVER permitted — if the
   user's description asks for one, you MUST return an empty steps array rather than attempt a workaround.
2. Every write step (INSERT/UPDATE/DELETE or a Mongo write operation) has a "commit" field. Default this to
   false — meaning the write executes and its effect can be asserted on, but is automatically rolled back
   afterward so no permanent change is made. ONLY set commit to true if the user's description explicitly asks
   to keep, persist, or permanently save the change (e.g. "insert a test user and keep it"). When in doubt, use
   false — that is always the safer choice.
3. For read-only steps (SELECT/find/aggregate/countDocuments), always set commit to false.

RULES:
1. Each distinct scenario described gets its own scenarioName and its own step.
2. {engine} determines the step shape:
   - postgres/mysql: fill "query" with the SQL statement; leave collection/operation/filter/pipeline/document/update null.
   - mongodb: fill "collection" and "operation", and the relevant one of filter/pipeline/document/update (each JSON-stringified); leave "query" null.
3. ALWAYS include at least one assertion per step — at minimum a 'rowCount' assertion (e.g. greaterThan 0, or equals N if the description implies an exact count). For a write step, an assertion after the write (e.g. rowCount from a follow-up-style check within the same step, or checking the write's own affected-row/inserted-id result) is appropriate.
4. Use 'cellValue'/'jsonPath' assertions (dot-notation into the result rows array, e.g. "0.email") to validate specific field values when the description mentions them.
5. Use 'schemaColumns' assertions when the description asks to verify a table/collection's shape (comma-separated expected column/field names as "expected").
6. CHAINING: If the description implies capturing a value from one query to use in a later one (e.g. "insert a user, then verify it was created with the correct email"), use 'extract' on the earlier step (e.g. {{"name":"userId","path":"0.id"}}), then reference it in a later step's query/filter/pipeline/document/update using {{userId}} placeholder syntax.

Test Name: {testName}
Description:
{promptText}
`);

    const chain = generatePrompt.pipe(llm);
    const response: any = await chain.invoke({ testName, promptText, engine });

    const tryParseJson = (val: any) => {
      if (val === null || val === undefined || val === '') return undefined;
      if (typeof val !== 'string') return val;
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    };

    const steps = (response?.steps || []).map((s: any) => {
      const step: any = {
        scenarioName: s.scenarioName,
        commit: !!s.commit,
        assertions: (s.assertions || []).map((a: any) => ({
          type: a.type,
          path: a.path || undefined,
          operator: a.operator,
          expected: a.expected,
        })),
        extract: (s.extract || []).map((e: any) => ({ name: e.name, path: e.path })),
      };
      if (s.query) step.query = s.query;
      if (s.collection) step.collection = s.collection;
      if (s.operation) step.operation = s.operation;
      const filter = tryParseJson(s.filter);
      if (filter !== undefined) step.filter = filter;
      const pipeline = tryParseJson(s.pipeline);
      if (pipeline !== undefined) step.pipeline = pipeline;
      const document = tryParseJson(s.document);
      if (document !== undefined) step.document = document;
      const update = tryParseJson(s.update);
      if (update !== undefined) step.update = update;
      return step;
    });

    if (steps.length === 0) {
      throw new Error('EMPTY_DB_SCENARIO_STEPS: LLM returned zero steps — either the description had nothing to validate, or it asked for a DDL/admin operation, which is not supported.');
    }

    return JSON.stringify(steps);
  }
}
