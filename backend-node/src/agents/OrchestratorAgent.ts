import { DiscoveryAgent } from './DiscoveryAgent';
import { RequirementsAgent } from './RequirementsAgent';
import { TestCaseAgent } from './TestCaseAgent';
import { TestDataAgent } from './TestDataAgent';
import { ScriptGenerationAgent } from './ScriptGenerationAgent';

import { ScenarioParserAgent } from './ScenarioParserAgent';

export class OrchestratorAgent {
  private executionId: string | undefined;
  private discoveryAgent: DiscoveryAgent;
  private reqAgent: RequirementsAgent;
  private tcAgent: TestCaseAgent;
  private dataAgent: TestDataAgent;
  private scriptAgent: ScriptGenerationAgent;
  private scenarioParserAgent: ScenarioParserAgent;

  constructor(executionId?: string) {
    this.executionId = executionId;
    this.discoveryAgent = new DiscoveryAgent(executionId);
    this.reqAgent = new RequirementsAgent(executionId);
    this.tcAgent = new TestCaseAgent(executionId);
    this.dataAgent = new TestDataAgent();
    this.scriptAgent = new ScriptGenerationAgent(executionId);
    this.scenarioParserAgent = new ScenarioParserAgent(executionId);
  }

  async planStrictScenarioQA(
    targetUrl: string,
    emitLog: (type: string, message: string) => void,
    emitProgress: (agent: string, status: string) => void,
    options: { sharedPage?: any; preDiscovered?: any; customScenarioText: string; preParsedScenarios?: any[]; auth?: any; isContinuation?: boolean }
  ) {
    emitLog('agent_log', `Executing in STRICT_SCENARIO mode${options.isContinuation ? ' (continuation batch - session already established)' : ''}.`);
    
    // Parse scenarios
    let scenarios = options.preParsedScenarios;
    if (!scenarios) {
      emitProgress('ScenarioParserAgent', 'parsing_scenarios');
      const parsedOutput = await this.scenarioParserAgent.parse(options.customScenarioText);
      scenarios = parsedOutput.scenarios;
    }
    emitLog('agent_log', `Parsed ${scenarios.length} strict scenarios to execute.`);

    const domSummary = options.preDiscovered?.domSummary || '';
    let allSteps: any[] = [];
    let testCases: any[] = [];

    // Collect all plan requests for the batch call
    let scenarioIndex = 0;
    let planReqs: string[] = [];

    const authString = options.auth && options.auth.username ? `\nCredentials to use:\nUsername: ${options.auth.username}\nPassword: ${options.auth.password}` : "";

    for (const scenario of scenarios) {
      scenarioIndex++;
      
      const tc = {
        name: scenario.name,
        description: `Strict execution for scenario ${scenario.id}`,
        priority: "P0",
        type: "positive",
        capability: "custom",
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        required: scenario.required
      };
      testCases.push(tc);

      const planReq = `Target: ${targetUrl}
Scenario Name: ${scenario.name}
Steps to Execute:
${scenario.steps ? scenario.steps.map((s: string) => "- " + s).join('\n') : "None"}
Assertions:
${scenario.assertions ? scenario.assertions.map((a: string) => "- " + a).join('\n') : "None"}
DOM Summary: ${domSummary.substring(0, 5000)}${authString}`;
      planReqs.push(planReq);
    }
    
    emitProgress('ScriptGenerationAgent', `generating_scenarios`);
    emitLog('agent_log', `Generating strict execution steps for ${scenarios.length} scenarios in batches...`);
    
    const executionPlanString = await this.scriptAgent.generateScript(`Strict Execution Plan`, planReqs, !!options.isContinuation);
    
    try {
      const parsedSteps = JSON.parse(executionPlanString);
      
      const generatedScripts = Array.from(new Set(parsedSteps.map((s: any) => s.scenarioName).filter(Boolean)));
      
      emitLog('telemetry', `SCRIPT_BATCH_COUNT=${planReqs.length}`);
      emitLog('telemetry', `SCRIPT_GENERATED_COUNT=${generatedScripts.length}`);
      emitLog('telemetry', `SCRIPT_EXPECTED_COUNT=${scenarios.length}`);
      
      if (generatedScripts.length !== scenarios.length) {
         emitLog('agent_log', `[Warning] SCRIPT_COUNT_MISMATCH: parsed=${scenarios.length}, generated=${generatedScripts.length}`);
      }
      
      allSteps.push(...parsedSteps);
    } catch (e: any) {
      emitLog('agent_log', `[Error] Failed to parse generated steps for scenarios`);
    }
    if (allSteps.length === 0) {
      return { success: false, error: 'Strict scenario generation failed to produce any executable steps.', requested_count: scenarios.length };
    }

    return { success: true, executionPlan: JSON.stringify(allSteps), testCases, requested_count: scenarios.length };
  }


  async planAutonomousQA(
    targetUrl: string, 
    emitLog: (type: string, message: string) => void,
    emitProgress: (agent: string, status: string) => void,
    options: { sharedPage?: any; mode?: string; preDiscovered?: { domSummary: string, capabilityMap: any, discoveredFlows: any[], fingerprint: string }, customScenario?: any[] } = {}
  ) {
    try {
      let discoveredFlows: any[] = [];
      let domSummary = '';
      let capabilityMap: any = null;

      if (options.preDiscovered) {
        emitLog('agent_log', 'Using pre-discovered DOM fingerprint and capability map...');
        discoveredFlows = options.preDiscovered.discoveredFlows;
        domSummary = options.preDiscovered.domSummary;
        capabilityMap = options.preDiscovered.capabilityMap;
      } else {
        // 1. Discovery Crawl
        emitProgress('DiscoveryAgent', 'crawling');
        emitLog('agent_log', 'Starting DiscoveryAgent to crawl and map features...');
        const discoveryResult = await this.discoveryAgent.discoverFlows(targetUrl, 3, { sharedPage: options.sharedPage });
        discoveredFlows = discoveryResult.flows;
        domSummary = discoveryResult.domSummary;
        emitLog('agent_log', `DiscoveryAgent identified ${discoveredFlows.length} potential flows.`);

        emitLog('agent_log', 'Building Feature Capability Map...');
        capabilityMap = await this.discoveryAgent.detectCapabilities(domSummary);
        emitLog('agent_log', `Capabilities: ${JSON.stringify(capabilityMap)}`);
      }

      let testCases: any[] = [];
      let inferredCaps: any = null;
      const mode = options.mode || 'full_autonomous';

      if (options.customScenario) {
        emitLog('agent_log', 'Running in Custom Scenario mode (bypassing generation)...');
        testCases = [{ name: 'Custom User Scenario', description: 'Executing user-provided natural language scenario', steps: options.customScenario }];
      } else if (mode === 'basic') {
        emitLog('agent_log', 'Running in basic mode (RequirementAgent + TestCaseAgent)...');
        const reqsText = `Target URL: ${targetUrl}\nCapabilities: ${JSON.stringify(capabilityMap)}\nDiscovered Flows:\n${discoveredFlows.map((f: any) => `- ${f.name}: ${f.description}`).join('\n')}`;
        const parsedReqs = await this.reqAgent.parseRequirements(reqsText);
        emitProgress('TestCaseAgent', 'strategizing');
        testCases = await this.tcAgent.generateTestCases(parsedReqs, capabilityMap);
      } else {
        emitLog('agent_log', 'Running in full_autonomous mode (Capability Analyzer + Test Generators)...');
        const { CapabilityAnalyzerAgent } = await import('./CapabilityAnalyzerAgent');
        const { PositiveTestGeneratorAgent } = await import('./PositiveTestGeneratorAgent');
        const { NegativeTestGeneratorAgent } = await import('./NegativeTestGeneratorAgent');
        
        emitProgress('CapabilityAnalyzerAgent', 'analyzing_capabilities');
        const capAgent = new CapabilityAnalyzerAgent(this.executionId);
        inferredCaps = await capAgent.analyze(domSummary);
        emitLog('agent_log', `Inferred Capabilities: ${JSON.stringify(inferredCaps)}`);
        
        emitProgress('TestGeneratorAgent', 'generating_tests');
        const posAgent = new PositiveTestGeneratorAgent(this.executionId);
        const negAgent = new NegativeTestGeneratorAgent(this.executionId);
        
        const [posCases, negCases] = await Promise.all([
          posAgent.generate(inferredCaps, domSummary),
          negAgent.generate(inferredCaps, domSummary)
        ]);
        
        const allCases = [...posCases, ...negCases];
        const priorityOrder: Record<string, number> = { "P0": 0, "P1": 1, "P2": 2 };
        testCases = allCases.sort((a, b) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3));
        
        if (testCases.length > 5) {
            emitLog('agent_log', `[Limiter] Truncating autonomous test cases from ${testCases.length} to 5 to maintain execution stability.`);
            testCases = testCases.slice(0, 5);
        }
        
        emitLog('agent_log', `Generated ${posCases.length} positive and ${negCases.length} negative tests.`);
      }

      // 4. Synthetic Data
      emitProgress('TestDataAgent', 'generating_data');
      emitLog('agent_log', 'TestDataAgent generating synthetic test values...');
      const dataMapping = await this.dataAgent.generateData(testCases.map((tc: any) => tc.description).join('\n'), domSummary);

      // 5. Script Generation (Executable Plan)
      emitProgress('ScriptGenerationAgent', 'building_framework');
      emitLog('agent_log', 'FrameworkBuilderAgent converting cases to Playwright JSON execution plans...');
      
      // Validation Gate 1: Check testCases
      if (!Array.isArray(testCases) || testCases.length === 0) {
        throw new Error("Validation Gate Failed: AI generated an empty or invalid test plan.");
      }
      
      let parsedPlan: any[] = [];
      let currentChunkSize = 5;
      
      for (let i = 0; i < testCases.length; ) {
        const chunk = testCases.slice(i, i + currentChunkSize);
        
        // Token-aware auto-chunking estimation (~4 chars per token)
        const chunkTokenEstimate = JSON.stringify(chunk).length / 4;
        if (chunkTokenEstimate > 12000 && currentChunkSize > 1) {
            emitLog('agent_log', `[Warning] Chunk token estimate too high (${Math.floor(chunkTokenEstimate)}). Auto-reducing chunk size.`);
            currentChunkSize = Math.max(1, Math.floor(currentChunkSize / 2));
            continue; // Re-evaluate with smaller chunk
        }

        emitLog('agent_log', `Generating script for chunk (size ${chunk.length})...`);
        const planReq = `Target: ${targetUrl}\nCases: ${JSON.stringify(chunk)}\nDOM Summary:\n${domSummary}`;
        
        try {
          const executionPlanChunk = await this.scriptAgent.generateScript(`Autonomous Execution Plan - Part`, [planReq], i > 0);
          const parsedChunk = JSON.parse(executionPlanChunk);
          if (Array.isArray(parsedChunk)) {
            parsedPlan.push(...parsedChunk);
          }
          i += currentChunkSize; // Advance only on success
          currentChunkSize = 5; // Reset chunk size for next batch
        } catch (err: any) {
           if (err.message && (err.message.toLowerCase().includes('token') || err.message.toLowerCase().includes('context') || err.message.toLowerCase().includes('limit')) && currentChunkSize > 1) {
               emitLog('agent_log', `[Warning] LLM token overflow detected. Retrying with smaller chunk size...`);
               currentChunkSize = Math.max(1, Math.floor(currentChunkSize / 2));
               // We don't advance `i`, so next iteration retries with smaller chunk
           } else {
               emitLog('agent_log', `[Error] Failed to generate script for chunk: ${err.message}`);
               i += currentChunkSize; // Skip this chunk and move on if we can't reduce further
               currentChunkSize = 5;
           }
        }
      }

      const executionPlan = JSON.stringify(parsedPlan);

      // Validation Gate 2: Check executionPlan
      if (parsedPlan.length === 0) {
         throw new Error("Validation Gate Failed: ScriptGenerationAgent output is malformed or empty");
      }

      // Generate Fingerprint for caching
      let fingerprint = options.preDiscovered?.fingerprint || '';
      if (!fingerprint) {
        const crypto = await import('crypto');
        fingerprint = crypto.createHash('sha256')
          .update(JSON.stringify(mode === 'basic' ? capabilityMap : inferredCaps))
          .digest('hex');
      }

      return {
        success: true,
        executionPlan,
        testCases,
        fingerprint
      };
    } catch (e: any) {
      console.error("[OrchestratorAgent] Pipeline failed:", e);
      return {
        success: false,
        error: e.message
      };
    }
  }
}
