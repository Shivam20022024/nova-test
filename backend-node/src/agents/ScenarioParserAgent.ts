import { getModel, invokeWithRetry } from './llm';
import { z } from 'zod';

export const scenarioSchema = z.object({
  scenarios: z.array(z.object({
    id: z.number(),
    name: z.string(),
    steps: z.array(z.string()),
    assertions: z.array(z.string()),
    required: z.boolean()
  }))
});

export class ScenarioParserAgent {
  private executionId: string | undefined;

  constructor(executionId?: string) {
    this.executionId = executionId;
  }
  extractScenarioText(input: any): string {
    if (!input) return "";

    if (typeof input === "string") {
      return input;
    }

    if (Array.isArray(input)) {
      if (input.some(item => typeof item === 'object' && item !== null && 'description' in item)) {
        return input.map((item: any) => {
          if (typeof item === 'object' && item !== null && typeof item.description === 'string') {
            const desc = item.description.trim();
            if (/^\d+\./.test(desc) || /^[-*]/.test(desc)) {
              return desc;
            } else {
              return `- ${desc}`;
            }
          }
          return '';
        }).filter(Boolean).join('\n');
      }
    }

    if (typeof input === "object") {
      if (typeof input.prompt === "string") return input.prompt;
      if (typeof input.text === "string") return input.text;
      if (typeof input.customScenario === "string") return input.customScenario;
      if (typeof input.scenario === "string") return input.scenario;
      if (typeof input.message === "string") return input.message;
      if (typeof input.content === "string") return input.content;
      // Fallback: try to stringify if it has useful keys or fallback to toString
      try {
         return JSON.stringify(input);
      } catch (e) {
         return String(input);
      }
    }

    return String(input);
  }

  async parse(customScenarioInput: any): Promise<{ scenarios: any[], auth: any }> {
    const inputType = typeof customScenarioInput;
    console.log(`[ScenarioParserAgent] CUSTOM_SCENARIO_INPUT_TYPE: ${inputType}`);

    const rawCustomScenarioText = this.extractScenarioText(customScenarioInput);
    
    if (!rawCustomScenarioText.trim()) {
      throw new Error("STRICT_SCENARIO requires non-empty custom scenario text");
    }

    const normalized = rawCustomScenarioText.replace(/\r\n/g, '\n').trim();
    console.log(`[ScenarioParserAgent] EXTRACTED_SCENARIO_TEXT_PREVIEW: ${normalized.substring(0, 100)}...`);

    let authMetadata: any = null;
    const usernameMatch = normalized.match(/(?:Username|Login|Email):\s*([^\s\n]+)/i);
    const passwordMatch = normalized.match(/Password:\s*([^\s\n]+)/i);

    if (usernameMatch || passwordMatch) {
       authMetadata = {
          username: usernameMatch ? usernameMatch[1] : undefined,
          password: passwordMatch ? passwordMatch[1] : undefined
       };
       console.log(`[ScenarioParserAgent] Detected scenario credentials for ${authMetadata.username || 'unknown'}`);
    }

    let rawChunks: string[] | null = null;
    let requestedCount = 0;
    let parserMode = '';
    let prompt = '';

    // Count matches first using robust regex
    const explicitScenarioMatches = normalized.match(/^\s*(?:[-*]\s*)?(?:Scenario|Test\s*Case)\b.*$/gmi) || [];
    const numberedMatches = normalized.match(/^\s*\d+\.\s+.+$/gm) || [];
    const bulletMatches = normalized.match(/^\s*[-*]\s+.+$/gm) || [];
    
    console.log(`[ScenarioParserAgent] EXPLICIT_SCENARIO_MATCH_COUNT=${explicitScenarioMatches.length}`);
    console.log(`[ScenarioParserAgent] NUMBERED_MATCH_COUNT=${numberedMatches.length}`);
    console.log(`[ScenarioParserAgent] BULLET_MATCH_COUNT=${bulletMatches.length}`);

    // Mode 0: EXACT_SCENARIO
    const explicitRegex = /(?:^|\n)(?=\s*(?:[-*]\s*)?(?:Scenario|Test\s*Case)\b)/i;
    const explicitChunks = normalized.split(explicitRegex).filter(chunk => /^\s*(?:[-*]\s*)?(?:Scenario|Test\s*Case)\b/i.test(chunk));

    // Mode 1: EXACT_NUMBERED
    const numberedRegex = /(?:^|\n)(?=\s*\d+\.\s+)/;
    const numberedChunks = normalized.split(numberedRegex).filter(chunk => /^\s*\d+\.\s+/.test(chunk));
    
    // Mode 2: EXACT_BULLET
    const bulletRegex = /(?:^|\n)(?=\s*[-*]\s+)/;
    const bulletChunks = normalized.split(bulletRegex).filter(chunk => /^\s*[-*]\s+/.test(chunk));
    
    if (explicitScenarioMatches.length > 0) {
       parserMode = 'EXACT_SCENARIO';
       rawChunks = explicitChunks;
       explicitChunks.forEach((chunk, idx) => {
           const match = chunk.match(/^\s*(?:[-*]\s*)?(?:Scenario|Test\s*Case).*?:\s*(.*)$/im);
           const title = (match && match[1]) ? match[1].trim() : "Unknown";
           console.log(`SCENARIO_BOUNDARY_DETECTED index=${idx + 1} title="${title}"`);
       });
    } else if (numberedMatches.length > 0) {
       parserMode = 'EXACT_NUMBERED';
       rawChunks = numberedChunks;
    } else if (bulletMatches.length > 0) {
       parserMode = 'EXACT_BULLET';
       rawChunks = bulletChunks;
    } else {
       parserMode = 'LLM_FALLBACK';
    }
    
    console.log(`[ScenarioParserAgent] PARSER_MODE=${parserMode}`);

    if (parserMode === 'EXACT_NUMBERED' || parserMode === 'EXACT_BULLET' || parserMode === 'EXACT_SCENARIO') {
      requestedCount = rawChunks!.length;
      console.log(`[ScenarioParserAgent] REQUESTED_SCENARIO_COUNT=${requestedCount}`);

      prompt = `You are a Strict Scenario Parser. The user has provided an explicit custom scenario to execute, which has been pre-split into exactly ${requestedCount} raw chunks.
Your job is to parse each chunk into exactly ONE structured test scenario.

RULES:
1. You MUST output EXACTLY ${requestedCount} scenarios, matching 1:1 with the chunks provided below. Do NOT merge or skip any chunks.
2. The title of each scenario MUST come from the main heading/bullet in the chunk.
3. Any sub-bullets or commands in the chunk must go into the 'steps' array.
4. Any validation/checking logic must go into the 'assertions' array.
5. Set required: true for every scenario.

RAW CHUNKS:
${rawChunks!.map((chunk, i) => `--- CHUNK ${i+1} ---\n${chunk.trim()}`).join('\n\n')}`;
    } else {
      console.log(`[ScenarioParserAgent] REQUESTED_SCENARIO_COUNT=UNKNOWN (LLM_FALLBACK)`);
      prompt = `You are a Flexible Scenario Parser. The user has provided free-form text detailing a custom scenario to execute.
Your job is to parse their instructions into a structured, sequential list of test scenarios.

RULES:
1. Extract distinct scenarios logically from the text.
2. Group any validation/checking logic into the 'assertions' array.
3. Keep scenario names concise but descriptive.
4. Set required: true for every scenario.

User's custom scenario instructions:
${normalized}`;
    }

    console.log(`[ScenarioParserAgent] Parsing custom scenario...`);
    const model = getModel('planner');
    const structuredModel = model.withStructuredOutput(scenarioSchema, { name: "ScenarioParsing" });
    
    let allScenarios: any[] = [];
    
    if (parserMode !== 'LLM_FALLBACK' && rawChunks && rawChunks.length > 5) {
      console.log(`[ScenarioParserAgent] Scenario count > 5 (${rawChunks.length}). Chunking into batches of 10.`);
      const CHUNK_SIZE = 10;
      
      for (let i = 0; i < rawChunks.length; i += CHUNK_SIZE) {
        const batch = rawChunks.slice(i, i + CHUNK_SIZE);
        const batchPrompt = `You are a Strict Scenario Parser. The user provided an explicit custom scenario, split into ${batch.length} chunks.
Your job is to parse each chunk into exactly ONE structured test scenario.

RULES:
1. Output EXACTLY ${batch.length} scenarios, matching 1:1 with the chunks below.
2. Title must come from the main heading/bullet.
3. Sub-bullets/commands go to 'steps'.
4. Validation/checking goes to 'assertions'.
5. Set required: true.

RAW CHUNKS (Part ${Math.floor(i/CHUNK_SIZE) + 1}):
${batch.map((chunk, idx) => `--- CHUNK ${i + idx + 1} ---\n${chunk.trim()}`).join('\n\n')}`;
        
        let batchAttempts = 0;
        let batchSuccess = false;
        while (batchAttempts < 3 && !batchSuccess) {
           batchAttempts++;
           console.log(`[ScenarioParserAgent] Parsing chunk ${Math.floor(i/CHUNK_SIZE) + 1} (Attempt ${batchAttempts})...`);
           const context = this.executionId ? { executionId: this.executionId, agentName: 'ScenarioParserAgent', promptType: 'parse_batch' } : undefined;
           const response = await invokeWithRetry(structuredModel, batchPrompt, 6000, [], context);
           if (response && response.scenarios && response.scenarios.length === batch.length) {
              allScenarios.push(...response.scenarios);
              batchSuccess = true;
           } else {
              console.warn(`[ScenarioParserAgent] Batch count mismatch. Expected ${batch.length}, got ${response?.scenarios?.length || 0}. Retrying...`);
           }
        }
        if (!batchSuccess) {
           throw new Error(`SCENARIO_BOUNDARY_MISMATCH: Failed to parse batch exactly 1:1 after 3 attempts.`);
        }
      }
    } else {
      let attempts = 0;
      let success = false;
      while (attempts < 3 && !success) {
         attempts++;
         const context = this.executionId ? { executionId: this.executionId, agentName: 'ScenarioParserAgent', promptType: 'parse' } : undefined;
         const response = await invokeWithRetry(structuredModel, prompt, 6000, [], context);
         if (response && response.scenarios) {
            if (parserMode !== 'LLM_FALLBACK' && response.scenarios.length !== requestedCount) {
               console.warn(`[ScenarioParserAgent] Count mismatch. Expected ${requestedCount}, got ${response.scenarios.length}. Retrying...`);
            } else {
               allScenarios = response.scenarios;
               success = true;
            }
         }
      }
      if (!success) {
         throw new Error(`SCENARIO_BOUNDARY_MISMATCH: Expected ${requestedCount} scenarios, but parsed failed to match after 3 attempts.`);
      }
    }

    if (allScenarios.length === 0) {
      throw new Error("Failed to parse custom scenario into structured scenarios.");
    }
    const parsedCount = allScenarios.length;
    console.log(`[ScenarioParserAgent] PARSED_SCENARIO_COUNT=${parsedCount}`);
    
    const scenarioTitles = allScenarios.map((s: any) => s.name);
    console.log(`[ScenarioParserAgent] SCENARIO_TITLES=${JSON.stringify(scenarioTitles)}`);

    return { scenarios: allScenarios, auth: authMetadata };
  }
}
