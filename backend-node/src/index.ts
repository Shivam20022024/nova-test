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

// Initialize BullMQ background worker
initExecutionWorker(io);

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

httpServer.listen(PORT, () => {
  console.log(`Novalantis Backend running on port ${PORT}`);
});

// trigger nodemon restart
