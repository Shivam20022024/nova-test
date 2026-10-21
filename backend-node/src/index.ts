import 'dotenv/config';

import { createServer } from 'http';
import { Server } from 'socket.io';
import app from './app';

const PORT = process.env.PORT || 8080;

process.on('uncaughtException', (err) => {
  console.error('[Global] Uncaught Exception:', err.message || err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Global] Unhandled Rejection at:', promise, 'reason:', reason);
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  // Engine.IO installs its own 'upgrade' listener and, for any upgrade whose
  // path is not its own, destroys the socket after destroyUpgradeTimeout
  // (1s by default). The mobile engine's live-view WebSocket lives at
  // /api/v1/mobile/executions/:id/ws and is proxied by the handler below, so
  // without this it would be silently torn down about a second after opening.
  // Socket.IO keeps serving its own /socket.io/ path exactly as before.
  destroyUpgrade: false,
});

import { initExecutionWorker } from './queue/executionWorker';
import { initApiDbTestWorker } from './queue/apiDbTestWorker';
import { initJiraIntakePoller } from './services/jiraIntakePoller';
import { mobileProxy, authenticateUpgrade, denyUpgrade, MOBILE_API_PREFIX } from './routes/mobile';

// Live-view WebSocket for mobile executions.
//
// Upgrades bypass the Express middleware stack entirely, so the `authenticate`
// mounted in app.ts never runs for them — this handler is the only thing in
// front of the live feed, and it must therefore do its own check. A browser's
// WebSocket constructor cannot set an Authorization header, so the frontend
// passes the Supabase token as a query parameter instead.
//
// Anything not under the mobile prefix is left untouched for Socket.IO's own
// listener to handle.
httpServer.on('upgrade', async (req, socket, head) => {
  const url = req.url || '';
  if (!url.startsWith(MOBILE_API_PREFIX)) return;

  try {
    if (!(await authenticateUpgrade(req))) {
      console.warn('[Mobile Proxy] rejected unauthenticated WebSocket upgrade');
      return denyUpgrade(socket);
    }
    mobileProxy.upgrade(req as any, socket as any, head);
  } catch (err: any) {
    console.error('[Mobile Proxy] upgrade failed:', err?.message || err);
    denyUpgrade(socket, 'Upgrade Failed');
  }
});

app.set('io', io);

// Background workers are started ONLY after this process owns the HTTP port (see listen below).
// Why: a second copy of the backend (e.g. `npm run dev` started twice) used to fail to bind the port, have
// that error swallowed by the global handler, and carry on as a "ghost" worker. It then picked up test
// runs from the shared queue and streamed their live telemetry to a Socket.IO server that nobody is
// connected to - the run worked, but the Live tab stayed blank.
let workersStarted = false;
function startBackgroundWorkers() {
  if (workersStarted) return;
  workersStarted = true;
  // Initialize BullMQ background worker
  initExecutionWorker(io);
  // Separate queue/worker for API Testing and Database Testing — see
  // queue/apiDbTestWorker.ts for why this is not folded into the worker above.
  initApiDbTestWorker(io);
  // Jira Intake: watches configured Jira projects for labelled bugs and turns
  // them into autonomous runs. Inert until a project opts in (JiraIntakeConfig
  // .enabled); disable entirely with JIRA_INTAKE_DISABLED=1.
  initJiraIntakePoller();
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('subscribe', (executionId: string) => {
    socket.join(executionId);
    console.log(`TELEMETRY_CONNECTED: Socket ${socket.id} subscribed to execution ${executionId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// If the port is taken, wait briefly (a restarting copy of this server may still be shutting down), then
// exit loudly. Never keep running without the port: that is the ghost-worker situation described above.
let listenAttempts = 0;
httpServer.on('error', (err: any) => {
  if (err?.code === 'EADDRINUSE') {
    listenAttempts++;
    if (listenAttempts <= 8) {
      console.warn(`[Startup] Port ${PORT} is busy (attempt ${listenAttempts}/8); retrying in 1.5s...`);
      setTimeout(() => httpServer.listen(Number(PORT), '0.0.0.0'), 1500);
      return;
    }
    console.error(`[Startup] FATAL: port ${PORT} is already used by another NovaTest backend. Stop the other copy ('npm run dev' running twice?). This process will not start workers and is exiting.`);
    process.exit(1);
  }
  console.error('[Startup] HTTP server error:', err?.message || err);
  process.exit(1);
});

httpServer.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Novalantis Backend running on port ${PORT}`);
  startBackgroundWorkers();
});

// trigger nodemon restart
