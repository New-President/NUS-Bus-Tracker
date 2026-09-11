# Vercel deployment

The static dashboard and Node API handler can run on Vercel. The current SQLite adapter uses an instance-local temporary file there: historical records and dashboard-saved credentials can disappear on a cold start, and separate function instances do not share data. The dashboard reports this storage limitation. For reliable historical collection, use the standalone server with persistent disk or replace the SQLite adapter with shared durable storage before production use.

## Configuration

1. Import the repository into Vercel with Framework Preset **Other**. `vercel.json` sets the output directory to `public` and rewrites `/api/*` to `api/index.js`.
2. Select a supported Node.js version that includes unflagged native SQLite (22.13 or newer). Vercel resolves the runtime using project settings and `package.json`; see [supported Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).
3. Official uNivUS guest sessions and daily renewal are automatic. Use `BUS_PROVIDER=univus` for direct queries only, or default `auto` for a public arrivals fallback during outages. `FMS_TOKEN` is an optional older ConnectX override. Add `ADMIN_TOKEN` to enable dashboard administrative actions and `CRON_SECRET` for scheduled collection. Use distinct secrets. Guest session cookies are cached in memory and acquired again after a cold start.
4. Deploy through the Vercel dashboard or CLI. This repository update does not deploy automatically.

The supplied cron runs every ten minutes. This frequency requires a plan supporting intervals shorter than daily; Hobby cron is limited to once per day. See [cron usage limits](https://vercel.com/docs/cron-jobs/usage-and-pricing). Remove the cron entry if you only need manual collection on a plan that does not support it.

Vercel sends the configured `CRON_SECRET` as a bearer authorization header. The API rejects missing or incorrect credentials before contacting the provider; see [securing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).

## Runtime behavior

- The standalone collector timer is not started inside serverless functions; authorized cron and manual polls trigger collection.
- Read requests never trigger provider calls. This keeps dashboard loading and status checks independent of upstream availability.
- Route requests run concurrently with an eight-second deadline per request. A cold uNivUS session needs one guest login first. A rejected guest session renews once. Public fallback requests have the same eight-second limit and run concurrently; the function limit is sixty seconds to allow this bounded flow.
- Only complete, successful responses are stored. Automatic mode can use the labelled public arrivals fallback after a direct uNivUS failure. Failures without a successful fallback return HTTP 502. No observations are inserted for failed collection; successful batches retain their actual provider and coverage.
- A successful empty response is stored as an empty poll batch.
- `GET /api/status` reports configuration, latest successful collection, latest failure, data freshness, and storage type without exposing token values.

## Verify locally

```powershell
npm.cmd test
npm.cmd run build
```

The handler suite exercises the serverless entry point with an isolated in-memory database and no network dependency. Passing these tests validates local handler behavior; a deployed provider connection still requires a successful live collection. See the direct connection and diagnostic instructions in [README.md](README.md#checks).


