import { PromptTemplate } from '@langchain/core/prompts';
import { getModel } from './llm';
import { DbSchemaTable } from '../lib/dbSchemaIntrospection';

export type TestDataStyle = 'realistic' | 'boundary' | 'negative';

/**
 * Generates rows/documents of appropriately-typed fake data for a given
 * table's introspected schema. Never executes anything — callers wrap the
 * result into an INSERT/insertOne/insertMany DbStep with commit:false by
 * default, so "automatic cleanup" is just the existing write/rollback
 * pipeline (DbExecutionAgent.ts) doing what it already does, not new logic.
 */
export class DbTestDataGeneratorAgent {
  async generateRows(table: DbSchemaTable, rowCount: number, style: TestDataStyle): Promise<any[]> {
    const jsonSchema = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          description: 'Each row is a JSON-stringified object mapping column/field name to a generated value.',
          items: { type: 'string' }
        }
      },
      required: ['rows'],
      additionalProperties: false
    };

    const llm = getModel('planner').withStructuredOutput(jsonSchema, { name: 'DbTestDataGeneration', strict: true });

    const columnsDescription = table.columns
      .filter((c) => !c.isPrimaryKey || c.dataType.toLowerCase().includes('uuid')) // most integer PKs are auto-generated — skip unless it's a UUID-style PK the caller must supply
      .map((c) => `${c.name} (${c.dataType}${c.nullable ? ', nullable' : ', NOT NULL'})`)
      .join(', ');

    const styleInstruction = {
      realistic: 'Generate plausible, realistic-looking values appropriate to each column\'s name and type (e.g. real-looking names/emails, sensible dates, reasonable numbers).',
      boundary: 'Generate boundary/edge-case values: empty strings, maximum-length strings, zero, negative numbers, very large numbers, far-future and far-past dates. For nullable columns, some rows should use null.',
      negative: 'Generate values specifically designed to be INVALID or violate likely constraints: null in NOT NULL-looking columns (still valid JSON, but a value that a NOT NULL check should catch if the column is truly required), malformed-looking emails, negative values where they would not make sense, obviously-wrong data — useful for testing that validation checks correctly catch bad data.',
    }[style];

    const generatePrompt = PromptTemplate.fromTemplate(`
Generate {rowCount} row(s) of test data for the table "{tableName}" with columns: {columnsDescription}.

{styleInstruction}

Return each row as a JSON-stringified object. Do not include auto-generated integer primary key columns.
`);

    const chain = generatePrompt.pipe(llm);
    const response: any = await chain.invoke({
      rowCount,
      tableName: table.name,
      columnsDescription,
      styleInstruction,
    });

    const rows = (response?.rows || []).map((r: string) => {
      try {
        return JSON.parse(r);
      } catch {
        return null;
      }
    }).filter((r: any) => r !== null);

    if (rows.length === 0) {
      throw new Error('EMPTY_TEST_DATA: LLM returned zero usable rows.');
    }

    return rows;
  }
}
