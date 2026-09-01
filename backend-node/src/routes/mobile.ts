import { createProxyMiddleware } from 'http-proxy-middleware';
import { supabase } from '../utils/storage';
import type { Duplex } from 'stream';
import type { IncomingMessage } from 'http';
import type { Response, NextFunction } from 'express';
import type { AuthRequest } from '../middleware/auth';

/**
 * Reverse proxy to the Python mobile testing engine (backend/mobile).
 *
 * The engine is FastAPI + SQLAlchemy + Appium and stays its own process; only
 * its HTTP surface is republished here so the frontend keeps ONE API base and
 * ONE auth flow. Two trust hops:
 *
 *   browser --(Supabase bearer)--> backend-node --(x-internal-key)--> backend
 *
 * The bearer is verified here (the same `authenticate` middleware every other
 * route uses); the internal key then proves to the Python side that the request
 * came through this proxy rather than straight at its published port.
 */

// Port 8000, not 8001. 8001 is the port the mobile engine used as a STANDALONE
// service (IMPLEMENTATION.md §4). Mounted inside the root backend it is served
// by that app instead, which backend/start.py runs on 127.0.0.1:8000.
const MOBILE_BACKEND_URL = process.env.MOBILE_BACKEND_URL || 'http://127.0.0.1:8000';
const INTERNAL_PROXY_KEY = process.env.INTERNAL_PROXY_KEY || '';

if (!INTERNAL_PROXY_KEY) {
  console.warn(
    '[Mobile Proxy] INTERNAL_PROXY_KEY is not set. The Python engine rejects requests without it, ' +
    'so every /api/v1/mobile call will return 503 until both .env files carry the same value.',
  );
}

/** Paths this proxy owns. Mounted at the app root so `req.url` still carries
 *  the full path — no pathRewrite needed, and nothing else is intercepted.
 *
 *  `/storage/mobile` is here because the engine returns root-relative artifact
 *  URLs (`/storage/mobile/evidence/...`). Those are loaded by <img>/<video>,
 *  which cannot send an Authorization header, so that subtree is proxied
 *  without the bearer check — matching how the platform already serves web/API
 *  artifacts from public Supabase buckets. Phase 5 moves this evidence into
 *  Supabase Storage and retires the path.
 */
export const MOBILE_API_PREFIX = '/api/v1/mobile';
export const MOBILE_STORAGE_PREFIX = '/storage/mobile';

/** Header the Python engine scopes on. Set here, never accepted from a client. */
export const SCOPE_HEADER = 'x-scope-project';

/**
 * List endpoints that return project-owned data. A real user must name a
 * project for these — otherwise omitting the parameter would return every
 * project's rows, which is the same leak by a different route.
 *
 * Matched on the path only. Endpoints keyed by id (/applications/5) are scoped
 * by the engine itself, which checks the row's project against SCOPE_HEADER.
 */
const SCOPED_LIST_PATHS = new Set([
  `${MOBILE_API_PREFIX}/applications`,
  `${MOBILE_API_PREFIX}/suites`,
  `${MOBILE_API_PREFIX}/tests`,
  `${MOBILE_API_PREFIX}/executions`,
]);

/** Requests authenticated by CI_API_KEY rather than a real user. Those have no
 *  project of their own and legitimately operate across all of them. */
function isCiRunner(req: AuthRequest): boolean {
  return req.user?.id === 'ci-cd-runner';
}

/**
 * Turns the client's *claim* about which project it wants into a verified fact.
 *
 * The engine has no user model, so left alone it would filter on whatever
 * project id the caller typed — any signed-in user could read another
 * project's APKs and runs by editing one query parameter. This resolves the
 * project against the Project table scoped by userId (the same ownership rule
 * /api/v1/projects uses) and, on success, stashes it for `proxyReq` to send as
 * SCOPE_HEADER. The engine reads that header and ignores the query parameter,
 * so a forged value cannot influence anything.
 */
export async function enforceProjectScope(req: AuthRequest, res: Response, next: NextFunction) {
  // Artifact bytes are fetched by <img>/<video> and carry no project param.
  if (!req.path.startsWith(MOBILE_API_PREFIX)) return next();

  if (isCiRunner(req)) return next();

  const url = new URL(req.originalUrl || req.url, 'http://placeholder');
  const claimed = url.searchParams.get('project_uuid');
  const pathOnly = url.pathname.replace(/\/+$/, '');

  if (!claimed) {
    if (SCOPED_LIST_PATHS.has(pathOnly)) {
      return res.status(400).json({
        error: 'project_uuid is required for this endpoint.',
        detail: 'Mobile data is scoped to a project; listing every project at once is not permitted.',
      });
    }
    return next();
  }

  try {
    const { data, error } = await supabase
      .from('Project')
      .select('id')
      .eq('id', claimed)
      .eq('userId', req.user?.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      // Deliberately identical whether the project is absent or simply owned by
      // someone else — distinguishing them would confirm a project's existence.
      return res.status(403).json({ error: 'Project not found or not accessible.' });
    }

    (req as AuthRequest & { verifiedProjectUuid?: string }).verifiedProjectUuid = claimed;
    next();
  } catch (err: any) {
    console.error('[Mobile Proxy] project scope check failed:', err?.message || err);
    res.status(500).json({ error: 'Could not verify project access.' });
  }
}

export const mobileProxy = createProxyMiddleware({
  target: MOBILE_BACKEND_URL,
  changeOrigin: true,
  // ws:false is REQUIRED for the live-view auth to work. Do not set it to true.
  //
  // With ws:true, http-proxy-middleware attaches its OWN 'upgrade' listener to
  // the server on the first proxied HTTP request (catchUpgradeRequest), and that
  // listener proxies WebSockets with no authentication whatsoever. Worse, its
  // exposed .upgrade() helper is guarded by
  //   `if (server && !this.wsInternalSubscribedServers.has(server))`
  // so once it has auto-subscribed, the manual call from index.ts silently does
  // nothing — the authenticated path is dead code and every upgrade goes through
  // the unauthenticated one. This was verified: a garbage token was accepted.
  //
  // With ws:false nothing auto-subscribes, so index.ts's upgrade handler — which
  // verifies the Supabase token first — is the only way in.
  ws: false,
  secure: false,
  pathFilter: [`${MOBILE_API_PREFIX}/**`, `${MOBILE_STORAGE_PREFIX}/**`],
  // Spread rather than `headers: cond ? {...} : undefined` — tsconfig sets
  // exactOptionalPropertyTypes, so an explicit `undefined` is not the same as
  // an absent property and is rejected.
  ...(INTERNAL_PROXY_KEY ? { headers: { 'x-internal-key': INTERNAL_PROXY_KEY } } : {}),
  on: {
    proxyReq: (proxyReq: any, req: any) => {
      // Strip anything the client sent under this name before setting it. The
      // header is a server assertion; accepting a client's version would hand
      // back exactly the bypass enforceProjectScope exists to close.
      proxyReq.removeHeader(SCOPE_HEADER);
      const verified = req.verifiedProjectUuid;
      if (verified) proxyReq.setHeader(SCOPE_HEADER, verified);
    },
    error: (err: Error, _req: IncomingMessage, res: any) => {
      // `res` is a ServerResponse for HTTP and a raw Socket for a failed
      // upgrade — only the former can carry a JSON body.
      console.error('[Mobile Proxy] upstream error:', err.message);
      if (res && typeof res.writeHead === 'function' && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Mobile testing engine is unreachable.',
          detail: err.message,
          target: MOBILE_BACKEND_URL,
        }));
      } else if (res && typeof res.destroy === 'function') {
        res.destroy();
      }
    },
  },
});

/**
 * Authenticates a WebSocket upgrade for the live execution view.
 *
 * Upgrades never traverse the Express middleware stack, so `authenticate` does
 * not run for them — this is the only thing standing in front of the live feed.
 * A browser's WebSocket constructor cannot set an Authorization header either,
 * so the token arrives as a query parameter instead (the frontend appends it).
 */
export async function authenticateUpgrade(req: IncomingMessage): Promise<boolean> {
  try {
    const url = new URL(req.url || '', 'http://placeholder');
    const token = url.searchParams.get('token');
    if (!token) return false;

    const { data, error } = await supabase.auth.getUser(token);
    return !error && !!data?.user;
  } catch {
    return false;
  }
}

/** Rejects an unauthenticated upgrade without leaving the socket hanging.
 *  Typed as Duplex because that is what Node hands to an 'upgrade' listener;
 *  only write() and destroy() are needed, which Duplex provides. */
export function denyUpgrade(socket: Duplex, reason = 'Unauthorized'): void {
  try {
    socket.write(`HTTP/1.1 401 ${reason}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* socket already gone */
  }
  socket.destroy();
}
