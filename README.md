# NUS Shuttle Bus Crowd Tracker

A Node.js application that queries uNivUS directly for real NUS shuttle positions and passenger loads, stores observations in shared Turso storage, and shows recorded crowd patterns. The backend uses Node modules and the libSQL HTTP client; the map uses Leaflet and external map tiles.

## Run locally

Use Node.js 24 (also selected for Vercel) and a Turso database. Install dependencies, create a local environment file, and fill in its values:

```powershell
npm.cmd ci
Copy-Item .env.example .env
# Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env before starting.
npm.cmd start
```

Both Turso variables are required locally and on Vercel. Use a separate development database for local work. `npm start` loads `.env` automatically; variables already set in your shell take precedence.

For local use at `http://127.0.0.1:3000`, leave `ADMIN_TOKEN` and `CRON_SECRET` blank unless you intentionally configure them. Any nonempty `ADMIN_TOKEN` requires that same value in **Data & API Settings > Dashboard admin token** before manual collection, even locally. Set real random secrets in Vercel. Restart the server after changing `.env`.

Open http://127.0.0.1:3000. Choose **Poll Now** to collect immediately. Default automatic mode uses the official uNivUS web application's guest session; no NUS account login, bus API key, or manually supplied FMS token is required. Collection runs every ten minutes while the server is running.

The session is renewed after 23 hours 45 minutes, or earlier if a returned cookie expires. The fifteen-minute margin allows a ten-minute poller to renew within the daily cycle. The dashboard shows the planned renewal time; it does not invent an expiry for opaque session cookies. A rejected session triggers one new guest login and retry. Concurrent routes share authentication.

The server binds to loopback by default. Set `HOST` and `PORT` to change the listening address; a busy port produces an error. Optional manual ConnectX overrides remain under **Data & API Settings** or `FMS_TOKEN`; environment overrides take precedence. Clear a manual FMS override to return to automatic uNivUS access.

## Direct uNivUS connection

The adapter follows **Continue as Guest** in the [official uNivUS web app](https://univus.nus.edu.sg/):

1. `GET https://inetapps.nus.edu.sg/univus/web/api/login/loginPublic` creates a guest session.
2. Session cookies and the issued request-verification token remain in server memory.
3. `POST https://inetapps.nus.edu.sg/univus/web/api/esb` queries `methodpath: /univus/api/bus-proxy/active-bus` with each configured `route_code`.

The verified response contains `data.activebus` with positions and optional `loadInfo` measurements. The public guest flow is visible in the official [web application source](https://inetapps.nus.edu.sg/univus/web/main.dart.js). The modern bus-proxy path through that session was verified with a live A1 query on 2026-09-11. This uses the NUS-hosted API directly; no community server is involved in a successful direct query.

Guest cookies are never written to the database, returned by dashboard APIs, included in logs, or forwarded to another host. Login redirects are validated without being followed, and authenticated requests use a fixed official origin. Renewing a session does not require credentials from the older ConnectX integration.

## Collection and data quality

- All configured route requests must succeed before a direct batch is stored. Each request has an eight-second deadline and a two-megabyte response limit. Missing, invalid, future, or more-than-two-minute-old uNivUS timestamps are rejected; reported bus counts must match the returned array when supplied.
- Default `auto` mode can use the labelled public arrivals source at `bus.hewliyang.com` during a uNivUS outage, retrying direct access at the next poll. Explicit `univus` mode reports direct failures without switching providers. Failed collection preserves the previous successful batch and its history.
- Public fallback coverage includes only vehicles appearing in current/next arrivals at `UTOWN` and `KR-MRT` by default. It supplies passenger readings but no GPS or speed. It requires fresh, healthy responses from all monitored stops. The [community client](https://github.com/hewliyang/nus-nextbus-web) has announced sunset maintenance, so this fallback has no service guarantee.
- Missing counts, capacity, occupancy, speed, and coordinates remain unknown. Occupancy can be calculated from reported passenger count and capacity; passenger counts are never inferred from occupancy. The direct API's occupancy field is interpreted as a ratio. Measured zero remains zero.
- Duplicate vehicle plates are counted once per batch. Conflicting route assignments in public arrivals are omitted. Counts describe observed vehicles, and absence from a batch does not establish where a bus is parked or whether it is operating.
- Successful empty responses record empty batches and clear currently reported vehicles. Observations older than fifteen minutes are stale. Historical fleet entries retain their last known measurements and location.
- History preserves gaps and uses **Asia/Singapore** dates. Hourly crowd summaries cover the last seven days with measurement counts; they describe past observations rather than guaranteed future crowd levels or seats.
- Every batch retains its actual provider and coverage. CSV exports include `source_provider`, `data_coverage`, and `monitored_stops`. Unknown values stay empty; text is quoted and spreadsheet formulas are neutralized. The default export contains the latest 10,000 rows; `/api/export?limit=100000` raises the cap.

## Configuration

| Variable | Purpose |
| --- | --- |
| `BUS_PROVIDER` | `auto` (default): direct uNivUS with public fallback; `univus`: direct uNivUS only; `community`: public arrivals only; `connectx`: older ConnectX integration only. |
| `FMS_ROUTES` | Comma-separated route identifiers shared by the adapters; default `A1,A2,D1,D2,E,K`. |
| `BUS_STOPS` | One to five public stop identifiers; default `UTOWN,KR-MRT`. Applies only to public coverage. |
| `FMS_TOKEN` | Optional manual ConnectX override in `auto`/`connectx` mode. Leave blank for automatic uNivUS sessions. |
| `UNIVUS_HTD_API`, `UNIVUS_APP_API` | Optional public-app identifier overrides for the older ConnectX authentication flow only. |
| `UNIVUS_APP_VERSION` | Older ConnectX guest client version; default `2.56.0`. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Required Turso database URL and read/write token for both local and hosted operation. |
| `HOST` | Local server bind address; default `127.0.0.1`. |
| `PORT` | Local HTTP port; default `3000`. |
| `ADMIN_TOKEN` | Bearer credential for polling, settings, and history deletion. Required for remote administrative access. |
| `CRON_SECRET` | Separate bearer credential required for `GET /api/cron`. |

`npm start` loads `.env` when present and preserves variables already set in the process environment. On Vercel, configure variables in project settings. The optional administrator token entered in the dashboard stays in page memory. Manual FMS tokens saved through Settings reside in the selected database; keep database access private. Read-only telemetry endpoints are public to anyone who can reach the server. Local writes without `ADMIN_TOKEN` require loopback, a localhost Host header, and the same origin. Hosted writes require `ADMIN_TOKEN`.

The older [documented guest/FMS flow](https://suibianp.github.io/nus-nextbus-new-api/) remains available in explicit `connectx` mode: get-access-token, buswidget initialization, then `nextbus_token2` for ConnectX requests. Its documented ActiveBus query returned error 4 during verification; the default integration now queries uNivUS directly.

## Checks

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run verify-live -- --direct
```

Tests use isolated databases and controlled HTTP responses, never your credentials or the live provider. They cover session creation and renewal, concurrent re-authentication, cookie boundaries, missing measurements, stale data, atomic batches, Turso configuration and persistence, Singapore dates, API validation, CSV escaping, administrative access, serverless behavior, and frontend rendering.

`verify-live` exercises one configured route using the selected provider and prints safe source/coverage/measurement diagnostics without database writes. `--direct` forces uNivUS without a fallback; `--connectx` checks the older integration. Session renewal timestamps are planned renewal times, not verified server-side cookie expiry times.

## Files

- `src/univus_client.js`: direct official guest sessions, daily renewal, and bus-proxy queries.
- `src/univus_auth.js`: older public guest/FMS authentication, used only for ConnectX mode.
- `src/api_client.js`: ConnectX requests and shared telemetry normalization.
- `src/public_feed.js`: public arrival fallback, freshness checks, and deduplication.
- `src/provider_config.js`: source selection and coverage descriptions.
- `src/provider_http.js`: bounded JSON requests and sanitized errors.
- `src/collector.js`: collection, scheduling, provider selection, and diagnostics.
- `src/db.js`: Turso connection creation and configuration validation.
- `src/remote_db.js` and `src/db_shared.js`: durable Turso storage, shared schema and validation, atomic batches, and analytics.
- `src/routes.js`: configured route identifiers and display colors.
- `src/server.js` and `api/index.js`: local and serverless API handlers.
- `public/`: dashboard, charts, map, and styles.
- `tests/`: isolated regression suites.

The app creates its tables in a new Turso database and accepts the current schema version. Unsupported existing schemas are rejected without modifying their data. No history is generated at startup.

See [VERCEL.md](VERCEL.md) for step-by-step Vercel deployment. The included [GitHub Actions workflow](.github/workflows/collect-buses.yml) requests a live collection every ten minutes, including on Vercel Hobby. To activate it, push the workflow to the default branch, set the GitHub Actions variable `TRACKER_URL` to your production website origin, and set the Actions secret `CRON_SECRET` to match Vercel's production environment variable. Redeploy after setting the Vercel secret, then use **Actions > Collect buses every 10 minutes > Run workflow** to verify it. GitHub can delay scheduled runs; see the deployment guide for scheduling limits and the Vercel Pro alternative. Turso is required; there is no local database fallback.
