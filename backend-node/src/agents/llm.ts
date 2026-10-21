import { ChatOpenAI } from '@langchain/openai';
import redisConnection from '../lib/redis';

export const truncateContext = (text: string, maxTokens: number): string => {
  if (!text) return text;
  const charLimit = maxTokens * 4;
  if (text.length > charLimit) {
    console.warn(`[Token Budget] Truncating context from ${text.length} chars to ${charLimit} chars (${maxTokens} tokens)`);
    return text.substring(0, charLimit) + '\n...[TRUNCATED]';
  }
  return text;
};

/**
 * Model tiers:
 *  - 'planner' : reasoning-heavy work (scenario parsing, script generation,
 *                discovery, test-case generation). Controlled by
 *                OPENAI_MODEL_PLANNER (default gpt-4o). This is the lever that
 *                most affects generated-selector / assertion quality.
 *  - 'cheap'   : high-volume, low-stakes work (self-healing candidates).
 *                Controlled by OPENAI_MODEL_CHEAP (default gpt-4o-mini).
 * `OPENAI_MODEL` remains a separate knob used by the reporting / test-data
 * agents and is intentionally NOT consulted here.
 */
export const getPlannerModelName = () => process.env.OPENAI_MODEL_PLANNER || 'gpt-4o';
export const getCheapModelName = () => process.env.OPENAI_MODEL_CHEAP || 'gpt-4o-mini';

let _loggedModels = false;

export const getModel = (modelType: 'planner' | 'cheap' = 'planner') => {
  const modelName = modelType === 'planner' ? getPlannerModelName() : getCheapModelName();

  if (!_loggedModels) {
    _loggedModels = true;
    console.log(`[LLM] planner=${getPlannerModelName()} cheap=${getCheapModelName()} (OPENAI_MODEL=${process.env.OPENAI_MODEL || 'gpt-4o-mini'} used by reporting/data agents)`);
  }

  return new ChatOpenAI({
    modelName,
    temperature: 0.2,
    openAIApiKey: process.env.OPENAI_API_KEY || 'mock-key',
    // Long scenarios produce large JSON plans; 30s is too short for them. Override with LLM_TIMEOUT_MS.
    timeout: parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10),
    maxRetries: 1
  });
};

export interface LlmContext {
  executionId: string;
  agentName: string;
  promptType: string;
}

const MAX_LLM_CALLS = parseInt(process.env.MAX_LLM_CALLS || '50', 10);
const MAX_TOTAL_TOKENS = parseInt(process.env.MAX_TOTAL_TOKENS || '500000', 10);
const MAX_ESTIMATED_COST = parseFloat(process.env.MAX_ESTIMATED_COST || '2.50');
const COST_PER_MILLION_TOKENS = 5.00;

const MAX_RETRIES_PER_AGENT = 3;

export const invokeWithRetry = async (
  modelOrChain: any, 
  input: any, 
  maxTokens: number, 
  contextKeysToTruncate: string[] = [],
  context?: LlmContext
) => {
  let attempt = 1;
  let currentTokens = maxTokens;
  let lastError: any = null;

  if (context && context.executionId) {
    const callCountKey = `execution_stats:${context.executionId}:llm_calls`;
    const tokenCountKey = `execution_stats:${context.executionId}:total_tokens`;
    
    const [callsStr, tokensStr, scenarioCountStr] = await Promise.all([
      redisConnection.get(callCountKey),
      redisConnection.get(tokenCountKey),
      redisConnection.get(`execution_stats:${context.executionId}:scenario_count`)
    ]);

    const calls = callsStr ? parseInt(callsStr, 10) : 0;
    const tokens = tokensStr ? parseInt(tokensStr, 10) : 0;
    const estimatedCost = (tokens / 1000000) * COST_PER_MILLION_TOKENS;

    // The base caps are sized for a single scenario. A run with N scenarios gets the caps multiplied by
    // ceil(N / 5) (so 21 scenarios => x5), bounded at x10, instead of aborting half-way through.
    const scenarioCount = scenarioCountStr ? parseInt(scenarioCountStr, 10) : 1;
    const budgetScale = Math.min(10, Math.max(1, Math.ceil((Number.isFinite(scenarioCount) ? scenarioCount : 1) / 5)));
    const callCap = MAX_LLM_CALLS * budgetScale;
    const tokenCap = MAX_TOTAL_TOKENS * budgetScale;
    const costCap = MAX_ESTIMATED_COST * budgetScale;

    let thresholdBreached = false;
    let breachReason = "";

    if (calls >= callCap) {
      thresholdBreached = true;
      breachReason = `LLM_CALL_COUNT (${calls}) >= MAX_LLM_CALLS (${callCap} = ${MAX_LLM_CALLS} x ${budgetScale})`;
    } else if (tokens >= tokenCap) {
      thresholdBreached = true;
      breachReason = `TOTAL_TOKENS (${tokens}) >= MAX_TOTAL_TOKENS (${tokenCap})`;
    } else if (estimatedCost >= costCap) {
      thresholdBreached = true;
      breachReason = `ESTIMATED_COST ($${estimatedCost.toFixed(4)}) >= MAX_ESTIMATED_COST ($${costCap})`;
    }

    if (thresholdBreached) {
      console.log(JSON.stringify({
        log_type: "telemetry",
        event: "BUDGET_THRESHOLD_HIT",
        EXECUTION_ID: context.executionId,
        LLM_CALL_COUNT: calls,
        TOTAL_TOKENS: tokens,
        ESTIMATED_COST: estimatedCost,
        BREACH_REASON: breachReason,
        TIMESTAMP: new Date().toISOString()
      }));
      console.error(`[SAFETY CAP] Execution ${context.executionId} breached budget: ${breachReason}. Aborting.`);
      throw new Error("LLM_BUDGET_EXCEEDED");
    }
    
    await redisConnection.incr(callCountKey);
  }

  while (attempt <= MAX_RETRIES_PER_AGENT) {
    try {
      let currentInput = input;
      let promptLength = 0;

      if (typeof input === 'string') {
        currentInput = truncateContext(input, currentTokens);
        promptLength = currentInput.length;
      } else if (typeof input === 'object' && input !== null) {
        currentInput = { ...input };
        for (const key of contextKeysToTruncate) {
          if (typeof currentInput[key] === 'string') {
            currentInput[key] = truncateContext(currentInput[key], currentTokens);
          }
        }
        promptLength = JSON.stringify(currentInput).length;
      }
      
      const tokenEstimate = Math.ceil(promptLength / 4);

      if (context) {
        console.log(JSON.stringify({
          log_type: "LLM_CALL",
          AGENT_NAME: context.agentName,
          EXECUTION_ID: context.executionId,
          PROMPT_TYPE: context.promptType,
          TOKEN_ESTIMATE: tokenEstimate,
          TIMESTAMP: new Date().toISOString()
        }));
      }

      const response = await modelOrChain.invoke(currentInput);
      
      if (context && context.executionId) {
        let actualTokens = tokenEstimate;
        if (response && response.response_metadata && response.response_metadata.tokenUsage) {
          actualTokens = response.response_metadata.tokenUsage.totalTokens || tokenEstimate;
        }
        await redisConnection.incrby(`execution_stats:${context.executionId}:total_tokens`, actualTokens);
      }
      
      return response;
    } catch (err: any) {
      if (err.message?.includes('429') || err.message?.includes('too large') || err.message?.includes('maximum context length') || err.status === 429) {
        console.warn(`[LLM Error] Token limit or rate limit exceeded on attempt ${attempt}. Error: ${err.message}. Retrying with reduced context.`);
        lastError = err;
        attempt++;
        currentTokens = Math.floor(currentTokens / 2);
        // Wait a bit before retrying in case of rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        throw err;
      }
    }
  }
  
  throw new Error(`LLM invocation failed after ${MAX_RETRIES_PER_AGENT} attempts due to token limits or other errors. Last error: ${lastError?.message || 'Unknown'}`);
};
