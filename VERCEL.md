# Deploy the NUS Bus Tracker on Vercel

The dashboard and API can run on Vercel, with Turso providing shared, durable history. The repository includes the serverless handler, API rewrites, a Node.js 24 runtime requirement, and Singapore function region (`sin1`). No frontend framework conversion is needed.

Turso is the only database backend, both locally and on Vercel. The app requires `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`; it never creates or opens a local database file. Missing or invalid configuration returns a setup error.

## 1. Create the history database

Create a **libSQL-compatible Turso database** in the [Turso dashboard](https://app.turso.tech/). Copy its database URL (`libsql://...turso.io` or `https://...turso.io`) and create a database auth token with read/write access. Choose a region near Singapore when available.

The backend uses the supported [`@libsql/client` HTTP client](https://docs.turso.tech/sdk/ts/reference). Tables and indexes are created automatically on the first database request. Use a new database for this app. The app accepts its current database schema (version 4) and rejects unsupported schemas without modifying them. Schema versions are stored in the `bus_schema_version` table because [Turso Cloud treats `PRAGMA user_version` as read-only](https://docs.turso.tech/cloud/limitations). Old local database files are not read or imported automatically.

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
| `TURSO_DATABASE_URL` | Your Turso database URL |
| `TURSO_AUTH_TOKEN` | Its read/write database token |
| `ADMIN_TOKEN` | A long, random secret for settings modifications and history deletion (optional) |
| `BUS_PROVIDER` | `auto` (recommended default), or `univus` to disable the public fallback |

You can generate an administrator secret locally with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

No authentication secrets are required for polling: `/api/cron` collects without any tokens. All these variables are backend-only. You do not need a NUS login, a manual FMS token, `HOST`, or `PORT` on Vercel. Automatic uNivUS guest sessions are created as needed and renewed daily; a new function instance establishes its own session.

If you enable Preview deployments, give them a separate Turso database and separate secrets so preview administrative actions cannot clear production history. Changing Vercel environment variables requires a redeployment.

## 4. Verify the deployment

1. Open `https://YOUR-PROJECT.vercel.app/api/status`. Expect HTTP 200 and `"storage":"turso"`. A configuration error means the Turso variables need to be set or corrected.
2. Open the dashboard.
3. Click **Poll Now**. A successful pull should update the last collection time. A successful empty fleet is valid; buses may not be running.
4. Check the map/live readings and history. To confirm sharing, redeploy and check that the recorded history is retained. Historical readings become stale after fifteen minutes; a new poll refreshes them.

A 502 from polling means the live feed or storage failed; check the dashboard diagnostics and Vercel function logs. Missing or invalid database configuration returns HTTP 503 with a setup message. Turso access, connectivity, and SQL errors also return HTTP 503 with a safe error code; driver messages and credentials are not exposed.

## 5. Automatic JavaScript polling (every 10 minutes)

Collection runs every ten minutes using pure JavaScript without requiring any authentication or secrets:

### Method A: Standalone Node.js poller script

Run the included JavaScript poller on any machine, container, or background runner:

```powershell
# Set TRACKER_URL to your Vercel origin to poll the deployment over HTTP
$env:TRACKER_URL = 'https://YOUR-PROJECT.vercel.app'
npm run poll
```

Or run directly:

```powershell
node scripts/poll.js
```

The script polls immediately on startup, then continues polling every 10 minutes without authentication. Pass `--once` if you only want to execute a single poll cycle (`node scripts/poll.js --once`).

### Method B: Browser client-side automatic polling

When the dashboard is open in any browser tab, client-side JavaScript automatically polls the uNivUS API every 10 minutes (and on initial load if data is stale) without authentication.

### Method C: Unauthenticated HTTP endpoint

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

### Method D: GitHub Actions

The repository includes `.github/workflows/poll.yml`, which runs `node scripts/poll.js --once` every ten minutes and writes directly to Turso. The workflow targets the `Production` GitHub environment. Add these **environment secrets** under **Settings > Environments > Production**:

| Secret | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | Your Turso database URL |
| `TURSO_AUTH_TOKEN` | A read/write Turso database token |

Optional repository **Actions variables** are `BUS_PROVIDER`, `FMS_ROUTES`, and `BUS_STOPS`. They default to `auto`, `A1,A2,D1,D2,E,K`, and `UTOWN,KR-MRT`. The workflow can also be started manually from the **Actions** tab. GitHub may delay scheduled runs during periods of high load; the workflow's concurrency setting prevents delayed runs from overlapping.

## Local checks and development

With Node.js 24 installed:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
```

The tests use isolated databases and controlled provider responses, including SQLite persistence tests, actual libSQL SQL/rollback checks, and async API integration tests. `npm run build` checks JavaScript syntax, configuration, and assets; it does not deploy or establish a live Turso/uNivUS connection.

Local operation also requires Turso. Copy `.env.example` to `.env`, enter the credentials for a separate development Turso database, and run:

```powershell
npm.cmd start
```

The local server collects every ten minutes. `npm start` loads `.env` when present; environment variables already set in the shell take precedence. The cloud adapter uses HTTP, so it needs no writable database file. CSV exports above 4 MB return a clear error on hosted deployments; reduce the `limit` parameter to stay below Vercel's response-size limit.
