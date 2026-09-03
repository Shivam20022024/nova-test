import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { VisualRegressionAgent } from '../agents/VisualRegressionAgent';

const router = Router();

const INTERNAL_PROXY_KEY = process.env.INTERNAL_PROXY_KEY || '';

// This is the ONE shared visual-regression engine (see VisualRegressionAgent.
// compareAgainstBaseline) — the web execution agent calls it in-process, and
// this route lets the mobile engine (a separate Python service) reach the
// same engine over HTTP instead of reimplementing pixel diffing a second
// time. Reuses the SAME shared secret already used the other direction
// (Node -> Python, see routes/mobile.ts's outbound x-internal-key) rather
// than inventing a new credential. Fails closed: an unconfigured secret
// rejects everything instead of accepting anything.
function verifyInternalKey(req: Request, res: Response, next: NextFunction) {
  const provided = req.headers['x-internal-key'];
  if (!INTERNAL_PROXY_KEY || provided !== INTERNAL_PROXY_KEY) {
    return res.status(401).json({ error: 'Missing or invalid x-internal-key.' });
  }
  next();
}

router.use(verifyInternalKey);

// POST /api/v1/visual/compare?key=<stable-test-key>
// Body: raw PNG bytes (Content-Type: application/octet-stream). Raw bytes
// rather than base64-in-JSON — a full-page screenshot is well past the
// default JSON body-parser limit, and base64 adds ~33% overhead for no
// benefit here.
router.post('/compare', express.raw({ type: '*/*', limit: '15mb' }), async (req: Request, res: Response) => {
  const key = req.query.key as string | undefined;
  if (!key) {
    return res.status(400).json({ error: 'key query parameter is required' });
  }
  const buffer = req.body as Buffer;
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(400).json({ error: 'Request body must be the raw PNG image bytes.' });
  }
  try {
    const agent = new VisualRegressionAgent();
    const result = await agent.compareAgainstBaseline(key, buffer);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Visual comparison failed' });
  }
});

export default router;
