import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { ScriptGenerationAgent } from '../agents/ScriptGenerationAgent';
import { ApiScriptGenerationAgent } from '../agents/ApiScriptGenerationAgent';
import { ApiSpecImportAgent } from '../agents/ApiSpecImportAgent';
import { ApiTestSuiteGeneratorAgent } from '../agents/ApiTestSuiteGeneratorAgent';
import { DbScriptGenerationAgent } from '../agents/DbScriptGenerationAgent';
import { DbTestSuiteGeneratorAgent } from '../agents/DbTestSuiteGeneratorAgent';
import { DbTestDataGeneratorAgent } from '../agents/DbTestDataGeneratorAgent';
import { introspectSchema } from '../lib/dbSchemaIntrospection';
import { supabase } from '../utils/storage';

const router = Router();
router.use(authenticate);

// POST /api/v1/ai/codegen
router.post('/codegen', async (req: AuthRequest, res: Response) => {
  try {
    const scriptAgent = new ScriptGenerationAgent(`api_codegen_${Date.now()}`);
    const { test_name, base_url, steps } = req.body;
    
    // Add base_url to steps context if not present
    const enrichedSteps = steps ? steps.map((s: any) => ({ ...s, base_url })) : [];

    const scriptCode = await scriptAgent.generateScript(test_name, enrichedSteps);
    
    res.json({ code: scriptCode });
  } catch (err: any) {
    console.error('Codegen failed:', err);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// POST /api/v1/ai/generate-playwright (used by frontend)
router.post('/generate-playwright', async (req: AuthRequest, res: Response) => {
  try {
    const scriptAgent = new ScriptGenerationAgent(`api_codegen_${Date.now()}`);
    const { suiteName, url, steps } = req.body;
    
    // Add base_url to steps context if not present
    const enrichedSteps = steps ? steps.map((s: any) => ({ ...s, base_url: url })) : [];

    const scriptCode = await scriptAgent.generateScript(suiteName || 'Playwright_Suite', enrichedSteps);
    
    res.json({ code: scriptCode });
  } catch (err: any) {
    console.error('Codegen failed:', err);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// Mock legacy endpoints used by the UI
router.post('/generate-suite', async (req: AuthRequest, res: Response) => {
  try {
    res.json({ message: 'Legacy route replaced by ScriptGenerationAgent' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to generate suite' });
  }
});

import { RawCodeGenerationAgent } from '../agents/RawCodeGenerationAgent';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

router.post('/generate-raw-code', async (req: AuthRequest, res: Response) => {
  try {
    const { url, instructions, framework } = req.body;
    const agent = new RawCodeGenerationAgent();
    const code = await agent.generateCode(instructions, url, framework);
    res.json({ code });
  } catch (err: any) {
    console.error('Raw codegen failed:', err);
    res.status(500).json({ error: 'Failed to generate raw code' });
  }
});

router.post('/execute-raw-code', async (req: AuthRequest, res: Response) => {
  try {
    const { code, framework } = req.body;
    if (framework !== 'playwright') {
      return res.status(400).json({ error: 'Sandbox execution currently only supports Playwright tests.' });
    }
    
    // Use temp directory so nodemon ignores it, but Playwright can easily find it
    const backendRoot = path.join(__dirname, '../../');
    const tempDir = path.join(backendRoot, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const fileName = `sandbox_${Date.now()}.spec.ts`;
    const filePath = path.join(tempDir, fileName);
    
    fs.writeFileSync(filePath, code);
    
    const relativePath = `temp/${fileName}`;
    exec(`npx playwright test ${relativePath}`, { cwd: backendRoot, timeout: 60000 }, (error, stdout, stderr) => {
      // Clean up file
      try { fs.unlinkSync(filePath); } catch (e) {}
      
      const output = stdout || stderr || (error ? error.message : '');
      res.json({ output, success: !error });
    });
  } catch (err: any) {
    console.error('Execute raw code failed:', err);
    res.status(500).json({ error: 'Failed to execute raw code' });
  }
});

// POST /api/v1/ai/generate-api-suite
router.post('/generate-api-suite', async (req: AuthRequest, res: Response) => {
  try {
    const { test_name, prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const agent = new ApiScriptGenerationAgent();
    const steps = await agent.generateApiSuite(test_name || 'API Test', prompt);
    res.json({ steps: JSON.parse(steps) });
  } catch (err: any) {
    console.error('API suite generation failed:', err);
    res.status(500).json({ error: err.message || 'Failed to generate API suite' });
  }
});

// POST /api/v1/ai/import-api-spec
router.post('/import-api-spec', async (req: AuthRequest, res: Response) => {
  try {
    const { spec_type, content } = req.body;
    if (!spec_type || !content) {
      return res.status(400).json({ error: 'spec_type and content are required' });
    }
    if (!['openapi', 'postman', 'curl'].includes(spec_type)) {
      return res.status(400).json({ error: 'spec_type must be one of: openapi, postman, curl' });
    }
    const agent = new ApiSpecImportAgent();
    const steps = agent.importSpec(spec_type, content);
    res.json({ steps });
  } catch (err: any) {
    console.error('API spec import failed:', err);
    res.status(400).json({ error: err.message || 'Failed to import API spec' });
  }
});

// POST /api/v1/ai/generate-api-suite-from-spec
router.post('/generate-api-suite-from-spec', async (req: AuthRequest, res: Response) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'content is required' });
    }
    const agent = new ApiTestSuiteGeneratorAgent();
    const steps = agent.generateSuiteFromOpenApi(content);
    res.json({ steps });
  } catch (err: any) {
    console.error('Schema-aware API suite generation failed:', err);
    res.status(400).json({ error: err.message || 'Failed to generate API suite from spec' });
  }
});

// POST /api/v1/ai/generate-db-suite
router.post('/generate-db-suite', async (req: AuthRequest, res: Response) => {
  try {
    const { test_name, prompt, connection_id } = req.body;
    if (!prompt || !connection_id) {
      return res.status(400).json({ error: 'prompt and connection_id are required' });
    }
    const { data: connection } = await supabase.from('DbConnection').select('*').eq('id', connection_id).maybeSingle();
    if (!connection) {
      return res.status(404).json({ error: 'Database connection not found' });
    }
    const agent = new DbScriptGenerationAgent();
    const stepsJson = await agent.generateDbSuite(test_name || 'Database Test', prompt, connection.engine);
    const steps = JSON.parse(stepsJson).map((s: any) => ({ ...s, connectionId: connection_id }));
    res.json({ steps });
  } catch (err: any) {
    console.error('DB suite generation failed:', err);
    res.status(500).json({ error: err.message || 'Failed to generate database suite' });
  }
});

// POST /api/v1/ai/generate-db-suite-from-schema
router.post('/generate-db-suite-from-schema', async (req: AuthRequest, res: Response) => {
  try {
    const { test_name, connection_id, focus } = req.body;
    if (!connection_id) {
      return res.status(400).json({ error: 'connection_id is required' });
    }
    const { data: connection } = await supabase.from('DbConnection').select('*').eq('id', connection_id).maybeSingle();
    if (!connection) {
      return res.status(404).json({ error: 'Database connection not found' });
    }
    const schema = await introspectSchema(connection);
    const agent = new DbTestSuiteGeneratorAgent();
    const stepsJson = await agent.generateSuiteFromSchema(test_name || 'Schema-Generated Test Suite', schema, connection.engine, focus);
    const steps = JSON.parse(stepsJson).map((s: any) => ({ ...s, connectionId: connection_id }));
    res.json({ steps, schema });
  } catch (err: any) {
    console.error('Schema-aware DB suite generation failed:', err);
    res.status(500).json({ error: err.message || 'Failed to generate schema-aware database suite' });
  }
});

// POST /api/v1/ai/generate-db-test-data
router.post('/generate-db-test-data', async (req: AuthRequest, res: Response) => {
  try {
    const { connection_id, table, rowCount, style } = req.body;
    if (!connection_id || !table) {
      return res.status(400).json({ error: 'connection_id and table are required' });
    }
    const { data: connection } = await supabase.from('DbConnection').select('*').eq('id', connection_id).maybeSingle();
    if (!connection) {
      return res.status(404).json({ error: 'Database connection not found' });
    }
    const schema = await introspectSchema(connection);
    const targetTable = schema.tables.find((t) => t.name === table);
    if (!targetTable) {
      return res.status(404).json({ error: `Table/collection "${table}" not found in schema` });
    }
    const agent = new DbTestDataGeneratorAgent();
    const rows = await agent.generateRows(targetTable, Math.min(Math.max(Number(rowCount) || 5, 1), 50), style || 'realistic');
    res.json({ rows });
  } catch (err: any) {
    console.error('DB test data generation failed:', err);
    res.status(500).json({ error: err.message || 'Failed to generate database test data' });
  }
});

export default router;
