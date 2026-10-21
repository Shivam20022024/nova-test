import express from 'express';
import cors from 'cors';

const app = express();
app.set('trust proxy', 1);

app.use(cors());

import suitesRoutes from './routes/suites';
import executionRoutes from './routes/executions';
import projectsRoutes from './routes/projects';
import dashboardRoutes from './routes/dashboard';
import { ensureBucketsExist } from './utils/storage';
import rateLimit from 'express-rate-limit';
import { mobileProxy, MOBILE_API_PREFIX, enforceProjectScope } from './routes/mobile';
import { authenticate } from './middleware/auth';

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // Limit each IP to 10000 requests per `window`
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use('/api/', apiLimiter);

// ── Mobile testing engine proxy ─────────────────────────────────────────
// Deliberately mounted BEFORE express.json(). The mobile API takes multipart
// APK uploads (hundreds of MB) and other raw bodies; if the JSON parser ran
// first it would consume the stream and the proxied request would arrive at
// the Python engine empty. Everything below this line still gets JSON parsing
// exactly as before — express.json() simply moved down past this mount.
//
// The bearer check is applied to the API prefix only. /storage/mobile/** is
// artifact bytes fetched by <img>/<video> tags, which cannot send an
// Authorization header (see routes/mobile.ts).
app.use(MOBILE_API_PREFIX, authenticate);
// Ownership check runs after authenticate (it needs req.user) and before the
// proxy, so an unverified project claim never reaches the engine.
app.use(MOBILE_API_PREFIX, enforceProjectScope);
app.use(mobileProxy);

app.use(express.json());

import discoveryRoutes from './routes/discovery';
import aiRoutes from './routes/ai';
import autonomousRoutes from './routes/autonomous';
import jiraRoutes from './routes/jira';
import healingRoutes from './routes/healing';
import visualRoutes from './routes/visual';
import ciRoutes from './routes/ci';
import releasesRoutes from './routes/releases';
import sprintsRoutes from './routes/sprints';
import testCasesRoutes from './routes/testCases';
import dbConnectionsRoutes from './routes/dbConnections';
import apiTestsRoutes from './routes/apiTests';
import dbTestsRoutes from './routes/dbTests';
import jiraIntakeRoutes from './routes/jiraIntake';

app.use('/api/v1/suites', suitesRoutes);
app.use('/api/v1/executions', executionRoutes);
app.use('/api/v1/projects', projectsRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/discovery', discoveryRoutes);
app.use('/api/v1/ai', aiRoutes);
app.use('/api/v1/autonomous', autonomousRoutes);
app.use('/api/v1/jira', jiraRoutes);
app.use('/api/v1/healing', healingRoutes);
app.use('/api/v1/visual', visualRoutes);
app.use('/api/v1/ci', ciRoutes);
app.use('/api/v1/releases', releasesRoutes);
app.use('/api/v1/sprints', sprintsRoutes);
app.use('/api/v1/test-cases', testCasesRoutes);
app.use('/api/v1/db-connections', dbConnectionsRoutes);
app.use('/api/v1/api-tests', apiTestsRoutes);
app.use('/api/v1/db-tests', dbTestsRoutes);
app.use('/api/v1/jira-intake', jiraIntakeRoutes);

// Ensure Supabase buckets exist
ensureBucketsExist().catch(console.error);

app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', service: 'novalantis-backend' });
});

export default app;
