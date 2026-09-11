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
| `ADMIN_TOKEN` | A long, random secret for dashboard polling, settings, and history deletion |
| `CRON_SECRET` | A different long, random secret for scheduled polling |
| `BUS_PROVIDER` | `auto` (recommended default), or `univus` to disable the public fallback |

You can generate each administrator/cron secret locally with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use distinct secrets and keep them out of Git. All these variables are backend-only. You do not need a NUS login, a manual FMS token, `HOST`, or `PORT` on Vercel. Automatic uNivUS guest sessions are created as needed and renewed daily; a new function instance establishes its own session.

If you enable Preview deployments, give them a separate Turso database and separate secrets so preview administrative actions cannot clear production history. Changing Vercel environment variables requires a redeployment.

## 4. Verify the deployment

1. Open `https://YOUR-PROJECT.vercel.app/api/status`. Expect HTTP 200 and `"storage":"turso"`. A configuration error means the Turso variables need to be set or corrected.
2. Open the dashboard, go to **Data & API Settings**, and enter your `ADMIN_TOKEN` in the administrator token field. This value stays in page memory; enter it again after reloading.
3. Click **Poll Now**. A successful pull should update the last collection time. A successful empty fleet is valid; buses may not be running.
4. Check the map/live readings and history. To confirm sharing, redeploy and check that the recorded history is retained. Historical readings become stale after fifteen minutes; a new poll refreshes them.

A 401 from an administrative action means the supplied administrator token does not match. A 502 from polling means the live feed or storage failed; check the dashboard diagnostics and Vercel function logs. Missing or invalid database configuration returns HTTP 503 with a setup message. Turso access, connectivity, and SQL errors also return HTTP 503 with a safe error code; driver messages and credentials are not exposed.

## 5. Set up automatic collection

The default configuration deliberately has **no Vercel cron**, so it can deploy on Hobby. Manual **Poll Now** works on any plan. Dashboard refreshes only read stored data; leaving a browser open does not collect new observations.

For continuous history, arrange a request every ten minutes using one of these options:

### Vercel Pro cron

Add this top-level property to `vercel.json`, keeping the other properties, and redeploy:

```json
"crons": [
  { "path": "/api/cron", "schedule": "*/10 * * * *" }
]
```

Vercel cron runs on production deployments and supplies `Authorization: Bearer <CRON_SECRET>` automatically. Hobby cron is limited to once per day and rejects a ten-minute schedule during deployment. See [cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) and [cron authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).

### External scheduler with Vercel Hobby

Configure your scheduler to send:

- Method: `GET`
- URL: `https://YOUR-PROJECT.vercel.app/api/cron`
- Header: `Authorization: Bearer YOUR_CRON_SECRET`
- Interval: every ten minutes
- Timeout: at least 60 seconds

Store the header value in the scheduler's secret settings. If Vercel Deployment Protection covers that URL, configure its automation bypass for the scheduler as well. Ordinary function usage limits still apply.

To test from PowerShell after setting `CRON_SECRET` in your local session:

```powershell
Invoke-RestMethod -Uri 'https://YOUR-PROJECT.vercel.app/api/cron' -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }
```

The response reports success only after a complete provider batch is committed. No collection timer runs inside Vercel functions. The dashboard shows on-demand/external scheduling because it cannot predict when an external scheduler will run.

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
