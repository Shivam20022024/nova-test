import * as dotenv from 'dotenv';
dotenv.config();
import { ExecutionAgent } from './ExecutionAgent';

async function runTest() {
  console.log("=== Running Assertion Healing Unit Test ===");
  const agent = new ExecutionAgent();
  
  // Mock page object
  const mockPage: any = {
    context: () => ({ clearCookies: async () => {}, browser: () => ({ version: () => "mock-version" }) }),
    on: () => {},
    url: () => "http://localhost",
    waitForLoadState: async () => {},
    locator: (sel: string) => ({
      waitFor: async () => { throw new Error(`Selector not found in DOM: ${sel}`); },
      count: async () => 0
    }),
    evaluate: async () => "<html></html>"
  };

  const scriptData = [
    {
      action: 'assertVisible',
      selector: '.inventory_container',
      scenarioName: 'TestScenario'
    }
  ];

  // Override emit methods so it doesn't crash outside of socket.io context
  const emitLog = (type: string, msg: string) => console.log(`[LOG - ${type}] ${msg}`);
  
  try {
    console.log("Executing script with assertVisible...");
    const result = await agent.executeScript('test-id', JSON.stringify(scriptData), 'chromium', emitLog, { sharedPage: mockPage });
    
    console.log("\nExecution Result:", result.success ? "PASSED" : "FAILED");
    console.log("Error Message:", result.error);
    
    if (result.success === false && result.error?.includes("Assertion step failed")) {
      console.log("✅ TEST PASSED: assertVisible correctly hard-failed without healing.");
    } else {
      console.log("❌ TEST FAILED: Assertion did not hard fail correctly.");
    }
  } catch (e) {
    console.error("Test framework error:", e);
  }
}

runTest();
