# Hosting NovaTest AI on Render (API + test worker) and Vercel (frontend)

Architecture: **Vercel** serves the React app. **Render** runs the Node API and the test worker (headless Chromium +
video) as one Docker web service. **Supabase** (database, auth, file storage) and **Upstash Redis** (job queue) are
already cloud services and are reused as they are. The Python mobile (Appium) engine is **not** hosted (see
"Not included").

## 0. Before anything is pushed - secrets (do this first)
`backend-node/.env`, `backend/.env` and `frontend/.env` were committed to the repository earlier (commit
`chore: include environment files`) and that history was pushed to GitHub. They contain the Supabase service-role key,
the OpenAI key, the Redis password and the Jira token.
1. The three files are now removed from git tracking (staged deletions; the files stay on your disk). Commit that.
2. Make the GitHub repository **private** if it is not.
3. **Rotate** every secret that was in those files: OpenAI key, Upstash Redis password, Supabase service-role key (and
   anon key if you wish), Jira API token, `CI_API_KEY`, `INTERNAL_PROXY_KEY`. Use the new values in Render/Vercel.
   (`DB_CREDENTIALS_ENCRYPTION_KEY` encrypts saved database-test connections: changing it makes those saved
   connections unreadable, so only rotate it if you are happy to re-enter them.)

## 1. Render - the API and test worker
1. Push the repository (with `render.yaml`) to GitHub.
2. Render dashboard -> **New -> Blueprint** -> pick the repo -> it reads `render.yaml` and creates `novatest-api`.
3. When asked, fill the secret values (names are in `backend-node/.env.example`):
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `OPENAI_API_KEY`, `CI_API_KEY`,
   `DB_CREDENTIALS_ENCRYPTION_KEY`, `INTERNAL_PROXY_KEY` and (optional) the four `JIRA_*` values.
4. Plan: **Standard (2 GB RAM)** or higher. A browser plus video encoding does not fit the 512 MB starter plan, and
   free instances sleep, which stops queued tests.
5. Wait for the first build (about 10 minutes: it downloads the Playwright image). When it shows **Live**, open
   `https://<service>.onrender.com/api/v1/health` - it must return `{"status":"ok",...}`. Note this URL.
6. **Masa's firewall:** Render dashboard -> `novatest-api` -> **Connect -> Outbound** lists the service's outbound IP
   addresses. Ask the Masa team to add those addresses to the same Cloudflare WAF exception they created for your IPv6
   range, otherwise runs will stop at the "Just a moment" page.

## 2. Vercel - the frontend
1. Vercel -> **Add New -> Project** -> import the same repo.
2. **Root Directory:** `frontend`. Framework preset: Vite (build `npm run build`, output `dist`). The existing
   `frontend/vercel.json` already rewrites every route to `index.html`.
3. Environment variables (Production):
   - `VITE_API_BASE` = the Render URL from step 1.5 (no trailing slash)
   - `VITE_SUPABASE_URL` = your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` = your Supabase anon key
4. Deploy. Note the URL (for example `https://novatest.vercel.app`). Re-deploy after changing any variable.

## 3. Supabase - make sign-in links point at the hosted site
Supabase -> Authentication -> **URL Configuration**:
- **Site URL:** the Vercel URL
- **Redirect URLs:** add the Vercel URL (and `http://localhost:5173` if you still develop locally)
Without this, confirmation emails send people back to `localhost`.
Also check Storage has the buckets `screenshots`, `videos` and `reports` (public read for screenshots/videos).

## 4. Smoke test (about 10 minutes)
1. Open the Vercel URL -> the login page loads.
2. Sign in as the client account -> the dashboard loads (a first request after idle can take a few seconds).
3. Create a project for `https://dev.masa.life`.
4. Run one short scenario (for example "Open https://dev.masa.life/login and verify the heading 'Welcome back.'").
   Watch the Live tab: frames and events should stream, then a video and the report appear.
5. Run a signed-in scenario with the Masa test login typed in the Test username / Test password boxes.

## 5. Hand-over to the client
Send: the Vercel URL, the NovaTest account email, and the password separately (ask them to change it on first login).
Tell them: they enter the Masa test login in the run form each time; nothing is stored in the scenario text.

## Not included / limits
- **Mobile (Appium) testing** needs Android devices or an emulator and is not part of this hosting. Leave
  `MOBILE_BACKEND_URL` unset; the Mobile menu will not work on the hosted site until a mobile engine is provided.
- One test run at a time per instance (`WORKER_CONCURRENCY=1`) - concurrent runs on the same Masa account interfere.
- Local development is unaffected: it keeps using the hostname-based queue name, so it will not take the hosted
  worker's jobs (the hosted service uses the fixed queue name `masa-client`).
- The Docker image was not built on this PC (Docker Desktop was not running); Render builds it from
  `backend-node/Dockerfile.render`. The compiled build (`npm run build`) and the frontend build were both verified
  locally, and the compiled server passed its health check.
