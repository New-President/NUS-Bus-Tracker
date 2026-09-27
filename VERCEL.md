# Deploy the NUS Bus Tracker on Vercel

The dashboard and API can run on Vercel, with Supabase PostgreSQL providing shared, durable history. The repository includes the serverless handler, API rewrites, a Node.js 24 runtime requirement, and Singapore function region (`sin1`). No frontend framework conversion is needed.

Supabase is the database backend, both locally and on Vercel. The app requires `SUPABASE_DB_URL` (or `DATABASE_URL`); it never creates or opens a local database file. Missing or invalid configuration returns a setup error.

## 1. Create the Supabase database

1. Create a project at [Supabase](https://supabase.com/). Choose a region near Singapore (`ap-southeast-1`) for optimal latency.
2. In the Supabase project dashboard, navigate to **Project Settings** > **Database** > **Connection string**.
3. Select the **Transaction** connection pooler URI (Port `6543`, uses Supavisor). It looks like:
   ```text
   postgresql://postgres.[project-ref]:[your-password]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require
   ```
   > [!IMPORTANT]
   > Use the **Transaction Pooler** (port `6543`), not the session pooler or direct port 5432. The transaction pooler is specially designed for serverless environments (Vercel, AWS Lambda) and avoids exhausting PostgreSQL connection limits.

4. The backend uses the native [`pg` client](https://node-postgres.com/). Tables, indexes, and Singapore date/time helper functions are created automatically on the first database request. Use a new database or schema for this app. The app accepts its database schema (version 4) and rejects unsupported schemas without modifying them. Old local database files are not read or imported automatically.

## 2. Import the project into Vercel

Push the project, including `package-lock.json`, to your GitHub repository. At [Vercel New Project](https://vercel.com/new), import that repository and use these settings:

| Setting | Value |
| --- | --- |
| Framework Preset | **Other** |
| Root Directory | Repository root (the folder containing `package.json`) |
| Build Command | `npm run build` |
| Output Directory | `public` |
| Install Command | Default, or `npm ci` |
| Node.js Version | **24.x**, also pinned in `package.json` |

`vercel.json` supplies the build/output settings, Singapore region, 60-second API duration, and `/api/*` rewrites. Vercel serves the dashboard assets from `public/` and invokes `api/index.js` for API requests. It does not run `npm start` as a permanent server. See [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

## 3. Add environment variables, then deploy

Before clicking **Deploy**, add these variables to the project's **Production** environment:

| Variable | Value |
| --- | --- |
| `SUPABASE_DB_URL` | Your Supabase Transaction Pooler URI |
| `ADMIN_TOKEN` | A long, random secret for settings modifications and history deletion (optional) |
| `BUS_PROVIDER` | `auto` (recommended default), or `univus` to disable the public fallback |

You can generate an administrator secret locally with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

No authentication secrets are required for polling: `/api/cron` collects without any tokens. All these variables are backend-only. You do not need a NUS login, a manual FMS token, `HOST`, or `PORT` on Vercel. Automatic uNivUS guest sessions are created as needed and renewed daily; a new function instance establishes its own session.

If you enable Preview deployments, give them a separate Supabase database and separate secrets so preview administrative actions cannot clear production history. Changing Vercel environment variables requires a redeployment.

## 4. Verify the deployment

1. Open `https://YOUR-PROJECT.vercel.app/api/status`. Expect HTTP 200 and `"storage":"supabase"`. A configuration error means the Supabase variables need to be set or corrected.
2. Open the dashboard.
3. Click **Poll Now**. A successful pull should update the last collection time. A successful empty fleet is valid; buses may not be running.
4. Check the map/live readings and history. To confirm sharing, redeploy and check that the recorded history is retained. Historical readings become stale after fifteen minutes; a new poll refreshes them.

A 502 from polling means the live feed or storage failed; check the dashboard diagnostics and Vercel function logs. Missing or invalid database configuration returns HTTP 503 with a setup message. Supabase access, connectivity, and SQL errors also return HTTP 503 with a safe error code; driver messages and credentials are not exposed.

## 5. Automatic JavaScript polling (every 10 minutes)

Collection runs every ten minutes using pure JavaScript without requiring any authentication or secrets:

### Method A: GitHub Actions Poller (Recommended)

Run the included JavaScript poller on GitHub Actions with Supabase credentials:
The repository includes `.github/workflows/poll.yml`, which runs `node scripts/poll.js --once` and writes directly to Supabase.

Add these **Repository Secrets** under **Settings > Secrets and variables > Actions > Secrets**:

| Secret | Value |
| --- | --- |
| `SUPABASE_DB_URL` | Your Supabase Transaction Pooler URI |

Optional **Actions Variables** under **Settings > Secrets and variables > Actions > Variables**: `BUS_PROVIDER`, `FMS_ROUTES`, and `BUS_STOPS`. They default to `auto`, `A1,A2,D1,D2,E,K,R1,R2`, and `UTOWN,KR-MRT`.

The workflow is configured with `workflow_dispatch`, allowing external webhook schedulers like [cron-job.org](https://cron-job.org) to trigger it reliably via GitHub's API every 10 minutes:
```http
POST https://api.github.com/repos/OWNER/REPO/actions/workflows/poll.yml/dispatches
Authorization: Bearer YOUR_GITHUB_PAT
Content-Type: application/json

{"ref":"main"}
```

### Method B: Standalone Poller Script

Run the included JavaScript poller on any background server, container, or VM with Supabase credentials:

```powershell
# Run a single poll cycle and exit
npm run poll -- --once

# Or run continuously as a 10-minute daemon
npm run poll
```

The script connects directly to the uNivUS API and writes observations to your Supabase database. Pass `--once` if you only want to execute a single poll cycle (`node scripts/poll.js --once`).

### Method C: Unauthenticated HTTP Cron Endpoint

You can trigger a poll from any JavaScript client, webhook, or cron runner by sending a plain `GET` request without authentication headers:

```powershell
Invoke-RestMethod -Uri 'https://YOUR-PROJECT.vercel.app/api/cron'
```

If you use Vercel Pro cron, add this top-level property to `vercel.json`:

```json
"crons": [
  { "path": "/api/cron", "schedule": "*/10 * * * *" }
]
```

## Local checks and development

With Node.js 24 installed:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
```

The tests use isolated databases (`pg-mem`) and controlled provider responses, including PostgreSQL transaction rollback checks, schema migrations, and async API integration tests. `npm run build` checks JavaScript syntax, configuration, and assets; it does not deploy or establish a live Supabase/uNivUS connection.

Local operation also requires Supabase. Copy `.env.example` to `.env`, enter the credentials for a development Supabase database, and run:

```powershell
npm.cmd start
```

The local server collects every ten minutes. `npm start` loads `.env` when present; environment variables already set in the shell take precedence. CSV exports above 4 MB return a clear error on hosted deployments; reduce the `limit` parameter to stay below Vercel's response-size limit.
