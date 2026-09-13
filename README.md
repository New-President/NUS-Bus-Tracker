# NUS Shuttle Bus Crowd Tracker

A Node.js application that queries uNivUS directly for real-time NUS shuttle bus positions, speeds, passenger loads, and crowd levels, stores observations in shared Turso storage, and visualizes live vehicle tracking and historical commute analytics. The backend uses Node.js with the libSQL HTTP client for Turso; the frontend uses Leaflet for interactive campus mapping, high-precision road-snapped route tracing, and Chart.js-style canvas visualizations.

---

## Features

- **Live Campus Shuttle Map**: Real-time GPS locations and bearing markers for all active NUS shuttle buses across Kent Ridge campus.
- **Road-Snapped Route Traces**: Realistic, high-resolution route highlights for routes `A1`, `A2`, `D1`, `D2`, `K`, `R1`, and `R2` that trace actual campus roads (snapped to road networks without cutting through buildings). Includes a toggle checkbox (`Show Route Highlights`) on the map.
- **Vehicle Telemetry & Analytics Dashboard**: Detailed modal inspection for individual buses showing plate number, route badge, live coordinates, speed, load factor, passenger headcount, and 24-hour occupancy/pax trend graphs.
- **Direct Official uNivUS Integration**: Authenticates as guest via official uNivUS API endpoints; no student login, manual API key, or expiring user credentials needed.
- **Durable Turso Storage**: Centralized libSQL database storing historical observations, aggregate hourly occupancy, and fleet states across Vercel serverless deployments.
- **Mobile Responsive Design**: Clean, responsive layout optimized for desktop, tablet, and mobile browsers with fluid touch controls and collapsible filters.
- **Dismissible Live Status Banner**: Dismissible connection status alert with one-click close button.
- **Automated Background Polling**: Built for serverless deployment with a GitHub Actions workflow (`.github/workflows/poll.yml`) that can be triggered on schedule (e.g., via cron-job.org or native cron) to poll uNivUS and write directly to Turso DB.

---

## Quick Start (Run Locally)

Requires **Node.js 24+** and a **Turso database**.

```powershell
npm.cmd ci
Copy-Item .env.example .env
# Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env
npm.cmd start
```

1. Create a free database at [Turso](https://app.turso.tech/) and set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env`.
2. Run `npm start`. The server starts at `http://127.0.0.1:3000`.
3. Open `http://127.0.0.1:3000` in your browser. Click **Poll Now** to perform an immediate live collection.

---

## Polling Architecture

Bus telemetry is collected and stored in Turso DB through automated or on-demand execution:

1. **GitHub Actions (Recommended for Production)**:
   - Workflow file: `.github/workflows/poll.yml`
   - Runs `npm run poll -- --once` (`node scripts/poll.js --once`).
   - Triggerable on a schedule via cron or external webhooks (e.g. `cron-job.org` via GitHub repository dispatch).
   - Direct connection: connects directly to uNivUS, normalizes telemetry, and writes records straight to Turso DB.
2. **On-Demand Poller Command**:
   - `npm run poll -- --once`: Executes a single poll cycle, logs records count, and exits.
   - `npm run poll`: Runs a continuous 10-minute polling daemon in Node.js.
3. **Web Dashboard (Reader)**:
   - The web app fetches `/api/live` and `/api/history` every 30 seconds to refresh the interface.
   - Contains an on-demand **Poll Now** button for administrative manual refreshes.
4. **HTTP Cron Endpoint**:
   - `GET /api/cron` triggers an immediate collection cycle in hosted serverless environments.

---

## Direct uNivUS Connection

The adapter emulates the **Continue as Guest** flow in the [official uNivUS web app](https://univus.nus.edu.sg/):

1. `GET https://inetapps.nus.edu.sg/univus/web/api/login/loginPublic` creates an official guest session.
2. Session cookies and anti-forgery tokens are held securely in memory.
3. `POST https://inetapps.nus.edu.sg/univus/web/api/esb` queries the modern ESB proxy endpoint (`/univus/api/bus-proxy/active-bus`) for each route code (`A1`, `A2`, `D1`, `D2`, `K`, etc.).
4. The response yields `data.activebus` containing precise latitude/longitude, speed, capacity, ridership, and crowd levels.
5. Sessions renew automatically within a 24-hour cycle or when response cookies expire. If a session is rejected, the client re-authenticates and retries.

---

## Data Quality & Reliability

- **Strict Validation**: Timestamps must be valid and within two minutes of current time. Active bus counts in payload headers must match the reported vehicles.
- **Fail-Safe History**: If a collection fails or uNivUS is temporarily unreachable, existing historical observations are preserved.
- **Community Fallback**: If configured in `auto` mode, an outage can fall back to the public arrivals feed (`bus.hewliyang.com`) for monitored stops (`UTOWN`, `KR-MRT`).
- **Telemetry Sanitization**: Missing readings stay `null` (never fabricated). Genuine zero values (0 km/h speed, 0 ridership) are preserved as `0`.
- **Deduplication**: Multi-route overlapping vehicle plates are counted once per poll batch.
- **Stale Expiry**: Observations older than 15 minutes are moved to historical fleet status.
- **Time Zone Consistency**: All historical analytics and timestamps are formatted in **Asia/Singapore** time (UTC+8).

---

## Configuration (`.env`)

| Variable | Description | Default |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | **Required.** Turso database URL (`libsql://...` or `https://...`). | — |
| `TURSO_AUTH_TOKEN` | **Required.** Read/write auth token for your Turso database. | — |
| `BUS_PROVIDER` | Data source mode: `auto` (default, direct uNivUS with community fallback), `univus` (direct only), `community`, or `connectx`. | `auto` |
| `FMS_ROUTES` | Comma-separated route codes to collect. | `A1,A2,D1,D2,E,K` |
| `BUS_STOPS` | Monitored stop codes for community fallback mode. | `UTOWN,KR-MRT` |
| `ADMIN_TOKEN` | Optional bearer secret for administrative settings modification and data deletion. | — |
| `HOST` | Bind address for local development server. | `127.0.0.1` |
| `PORT` | Port for local development server. | `3000` |

---

## Verification & Automated Tests

All tests run in completely isolated environments using in-memory databases and offline HTTP mocks. Tests never touch your live Turso database or external providers.

```powershell
# Run the complete test suite (151 tests)
npm test

# Run frontend UI, Leaflet map, and contract tests (26 tests)
node tests/test_frontend.js

# Run codebase syntax and asset integrity check (30 files)
npm run check

# Verify direct uNivUS live feed connectivity without writing to DB
npm run verify-live -- --direct
```

---

## Project Structure

```
NUS-Bus-Tracker/
├── .github/
│   └── workflows/
│       └── poll.yml              # Scheduled GitHub Actions poller (npm run poll -- --once)
├── api/
│   └── index.js                  # Vercel serverless request handler
├── public/
│   ├── app.js                    # Frontend logic: Leaflet map, bus markers, road polylines, charts
│   ├── favicon.svg               # Application bus icon
│   ├── index.html                # Responsive dashboard UI layout & navigation
│   └── style.css                 # Dark theme, mobile responsive styles, modals
│   └── styles.css                # Dark theme, mobile responsive styles, modals
├── scripts/
│   ├── check.js                  # Linter and asset integrity validator
│   ├── poll.js                   # Standalone poller (supports --once for CI/cron)
│   ├── server.js                 # Local development HTTP server runner
│   └── verify_live.js            # Live uNivUS telemetry diagnostic test tool
├── src/
│   ├── api_client.js             # Telemetry normalizer & ConnectX fallback
│   ├── collector.js              # Polling orchestrator & batch recorder
│   ├── database_errors.js        # Safe Turso error mapping
│   ├── db.js                     # Database client factory
│   ├── db_shared.js              # Shared SQL parameter sanitization & batching
│   ├── provider_config.js        # Provider configuration validation
│   ├── provider_http.js          # Bounded HTTP fetcher with timeout/size limits
│   ├── public_feed.js            # Community arrival fallback provider
│   ├── remote_db.js              # Turso SQL schema, queries, and analytics
│   ├── routes.js                 # Canonical Kent Ridge route identifiers
│   ├── server.js                 # Universal HTTP request routing & API endpoints
│   ├── univus_auth.js            # Legacy ConnectX guest token provider
│   └── univus_client.js          # Official uNivUS ESB API client (ActiveBus)
├── tests/                        # 151 unit & integration tests
│   ├── database_fixture.js       # In-memory libSQL fixture for isolated testing
│   ├── no_provider_network.js    # Network isolation guard for tests
│   ├── run_all_tests.js          # Main test runner invoked by npm test
│   ├── test_database.js          # Unit tests for Turso SQL query logic
│   ├── test_frontend.js          # DOM, Leaflet map, chart, and HTML contract tests
│   ├── test_public_feed.js       # Community arrival parsing tests
│   ├── test_remote_database.js   # Turso transactions, schema migrations & concurrency
│   ├── test_server_endpoints.js  # HTTP API endpoint tests (/api/live, /api/history)
│   ├── test_suite.js             # Data normalization & collector recovery tests
│   ├── test_univus_auth.js       # ConnectX token provider tests
│   ├── test_univus_client.js     # uNivUS ESB API parsing & session tests
│   └── test_vercel_handler.js    # Serverless deployment edge case tests
├── package.json                  # Dependencies, test scripts, and Node 24 requirement
├── VERCEL.md                     # Deployment guide for Vercel + Turso
└── vercel.json                   # Vercel deployment configuration
```

---

## Deployment

See [VERCEL.md](VERCEL.md) for full instructions on deploying the dashboard to Vercel and setting up the Turso database and GitHub Actions cron poller.
