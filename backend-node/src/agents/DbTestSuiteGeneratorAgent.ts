import { PromptTemplate } from '@langchain/core/prompts';
import { getModel } from './llm';
import { DbSchema } from '../lib/dbSchemaIntrospection';

/**
 * Sibling to DbScriptGenerationAgent.ts — instead of guessing table/column
 * names from a free-text description, this generates a full battery of
 * functional/negative/integrity/regression checks grounded in an actually
 * introspected schema (see lib/dbSchemaIntrospection.ts). Steps land in the
 * same editable Manual Query Builder as every other generation path — never
 * auto-executed.
 *
 * Same safety posture as DbScriptGenerationAgent: writes default
 * commit=false, and DDL is never generated. The executor's
 * assertStatementAllowed() re-validates every step regardless of what this
 * agent produces, so this is a second, redundant line of defense, not the
 * only one.
 */
// Builds orphan-detection steps directly from the schema's actual foreignKeys
// list — never delegated to the LLM. Reproducing a FK list faithfully from a
// text description is exactly the kind of thing a model can hallucinate
// (fabricating a plausible-looking but nonexistent related table); building
// it in code makes that class of error structurally impossible.
function buildIntegrityStepsFromSchema(schema: DbSchema, engine: string): any[] {
  const steps: any[] = [];
  for (const table of schema.tables) {
    for (const fk of table.foreignKeys) {
      const scenarioName = `[INTEGRITY] Check for orphan rows: ${table.name}.${fk.column} -> ${fk.referencesTable}.${fk.referencesColumn}`;
      if (engine === 'mongodb') {
        steps.push({
          scenarioName,
          commit: false,
          collection: table.name,
          operation: 'aggregate',
          pipeline: [
            { $lookup: { from: fk.referencesTable, localField: fk.column, foreignField: fk.referencesColumn, as: '_matched' } },
            { $match: { [fk.column]: { $ne: null }, _matched: { $size: 0 } } },
          ],
          assertions: [{ type: 'rowCount', operator: 'equals', expected: 0 }],
          extract: [],
        });
      } else {
        steps.push({
          scenarioName,
          commit: false,
          query: `SELECT child.* FROM ${table.name} child LEFT JOIN ${fk.referencesTable} parent ON child.${fk.column} = parent.${fk.referencesColumn} WHERE child.${fk.column} IS NOT NULL AND parent.${fk.referencesColumn} IS NULL`,
          assertions: [{ type: 'rowCount', operator: 'equals', expected: 0 }],
          extract: [],
        });
      }
    }
  }
  return steps;
}

// Builds one regression "schemaColumns" step per table directly from the
// schema's actual column list — never delegated to the LLM. schemaColumns
// assertions check a QUERY'S OWN result columns against an expected list,
// so the query has to be shaped to literally return those columns (e.g.
// SELECT * FROM table LIMIT 1). An LLM asked to write "a query that checks
// the schema" will sometimes reach for an information_schema meta-query
// instead — which returns column NAMES AS VALUES in a single "column_name"
// column, not as separate result columns — silently mismatching the very
// assertion it's paired with. Building this deterministically removes that
// failure mode entirely.
function buildRegressionStepsFromSchema(schema: DbSchema, engine: string): any[] {
  return schema.tables.map((table) => {
    const columnNames = table.columns.map((c) => c.name);
    if (engine === 'mongodb') {
      return {
        scenarioName: `[REGRESSION] Baseline field shape: ${table.name}`,
        commit: false,
        collection: table.name,
        operation: 'find',
        filter: {},
        assertions: [{ type: 'schemaColumns', operator: 'contains', expected: columnNames }],
        extract: [],
      };
    }
    return {
      scenarioName: `[REGRESSION] Baseline column shape: ${table.name}`,
      commit: false,
      query: `SELECT * FROM ${table.name} LIMIT 1`,
      assertions: [{ type: 'schemaColumns', operator: 'contains', expected: columnNames }],
      extract: [],
    };
  });
}

export class DbTestSuiteGeneratorAgent {
  async generateSuiteFromSchema(testName: string, schema: DbSchema, engine: string, focus?: string): Promise<string> {
    const jsonSchema = {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scenarioName: { type: 'string' },
              category: { type: 'string', enum: ['functional', 'negative'] },
              query: { type: ['string', 'null'] },
              collection: { type: ['string', 'null'] },
              operation: { type: ['string', 'null'], enum: ['find', 'aggregate', 'countDocuments', null] },
              filter: { type: ['string', 'null'] },
              pipeline: { type: ['string', 'null'] },
              assertions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['rowCount', 'cellValue', 'jsonPath', 'schemaColumns', 'columnNotNull', 'columnUnique', 'regexMatch', 'dataType', 'dateValid', 'aggregate'] },
                    path: { type: ['string', 'null'] },
                    operator: { type: 'string', enum: ['equals', 'notEquals', 'contains', 'exists', 'greaterThan', 'lessThan'] },
                    expected: { type: ['string', 'number'] },
                    aggregateFunction: { type: ['string', 'null'], enum: ['sum', 'avg', 'count', 'min', 'max', null] }
                  },
                  required: ['type', 'path', 'operator', 'expected', 'aggregateFunction'],
                  additionalProperties: false
                }
              }
            },
            required: ['scenarioName', 'category', 'query', 'collection', 'operation', 'filter', 'pipeline', 'assertions'],
            additionalProperties: false
          }
        }
      },
      required: ['steps'],
      additionalProperties: false
    };

    const llm = getModel('planner').withStructuredOutput(jsonSchema, { name: 'DbTestSuiteFromSchema', strict: true });

    const schemaDescription = schema.tables.map((t) => {
      const cols = t.columns.map((c) => `${c.name} (${c.dataType}${c.nullable ? ', nullable' : ', NOT NULL'}${c.isPrimaryKey ? ', PK' : ''})`).join(', ');
      const fks = t.foreignKeys.map((fk) => `${fk.column} -> ${fk.referencesTable}.${fk.referencesColumn}`).join(', ');
      return `Table "${t.name}": columns = [${cols}]${fks ? `; foreign keys = [${fks}]` : ''}`;
    }).join('\n');

    const generatePrompt = PromptTemplate.fromTemplate(`
You are an expert database test engineer. You are given the ACTUAL schema of a {engine} database below.
Generate a comprehensive, READ-ONLY test suite covering these categories:

1. FUNCTIONAL: for each meaningful table, a basic row-count sanity check (e.g. rowCount greaterThan 0). Use "SELECT * FROM table" or "SELECT COUNT(*) FROM table" style queries — do NOT query information_schema or any metadata table for functional checks.
2. NEGATIVE: for each column marked NOT NULL, a columnNotNull assertion proving no existing rows violate that constraint, using a query like "SELECT * FROM table" against the real table (never information_schema). Do NOT generate any INSERT/UPDATE/DELETE — these are read-only checks only.

Do NOT generate schemaColumns/regression checks and do NOT generate foreign-key/orphan-detection checks — both of those are generated separately, deterministically, from the schema's exact structure, not by you. Never query information_schema or any other metadata/catalog table yourself — only query the actual application tables listed below. Only reference tables and columns that literally appear in the schema below; never invent a table or column name that isn't listed.

CRITICAL SAFETY RULE: Only SELECT/WITH statements (or find/aggregate/countDocuments for MongoDB) are permitted. Never generate INSERT, UPDATE, DELETE, or any DDL statement — this generator only produces read-only checks.

Schema:
{schemaDescription}

{focusInstruction}

Test Name: {testName}
`);

    const chain = generatePrompt.pipe(llm);
    const response: any = await chain.invoke({
      testName,
      schemaDescription,
      engine,
      focusInstruction: focus ? `Focus primarily on: ${focus}` : 'Cover all tables in the schema.',
    });

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
        scenarioName: `[${(s.category || 'functional').toUpperCase()}] ${s.scenarioName}`,
        commit: false,
        assertions: (s.assertions || []).map((a: any) => {
          const assertion: any = { type: a.type, path: a.path || undefined, operator: a.operator, expected: a.expected };
          if (a.aggregateFunction) assertion.function = a.aggregateFunction;
          return assertion;
        }),
        extract: [],
      };
      if (s.query) step.query = s.query;
      if (s.collection) step.collection = s.collection;
      if (s.operation) step.operation = s.operation;
      const filter = tryParseJson(s.filter);
      if (filter !== undefined) step.filter = filter;
      const pipeline = tryParseJson(s.pipeline);
      if (pipeline !== undefined) step.pipeline = pipeline;
      return step;
    });

    const integritySteps = buildIntegrityStepsFromSchema(schema, engine);
    const regressionSteps = buildRegressionStepsFromSchema(schema, engine);
    const allSteps = [...steps, ...regressionSteps, ...integritySteps];

    if (allSteps.length === 0) {
      throw new Error('EMPTY_SCHEMA_SUITE: no steps were generated for this schema.');
    }

    return JSON.stringify(allSteps);
  }
}
