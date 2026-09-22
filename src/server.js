import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseConfigurationError, getDatabase } from './db.js';
import { BusCollector } from './collector.js';
import { databaseFailure } from './database_errors.js';
import { NUS_ROUTES } from './routes.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const DAY_MS = 86400000;
const API_METHODS = {
  '/api/status': 'GET', '/api/live': 'GET', '/api/history/24h': 'GET',
  '/api/history/vehicle-snapshots': 'GET',
  '/api/analytics/optimize': 'GET', '/api/export': 'GET', '/api/cron': 'GET',
  '/api/poll-now': 'POST', '/api/settings': 'POST', '/api/clear-all': 'POST'
};
const STATIC_FILES = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
  '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'application/javascript'],
  '/_vercel/insights/script.js': ['_vercel/insights/script.js', 'application/javascript'],
  '/_vercel/speed-insights/script.js': ['_vercel/speed-insights/script.js', 'application/javascript'] };

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, code, data, cacheControl = 'no-store') {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

async function parseBody(req) {
  const maxBytes = 16384;
  const contentType = req.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new RequestError(415, 'Content-Type must be application/json.');
  let value = req.body;
  if (value === undefined) {
    if (Number(req.headers['content-length']) > maxBytes) throw new RequestError(413, 'Request body is too large.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) throw new RequestError(413, 'Request body is too large.');
      chunks.push(Buffer.from(chunk));
    }
    value = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > maxBytes) throw new RequestError(413, 'Request body is too large.');
    try { value = JSON.parse(value); } catch { throw new RequestError(400, 'Invalid JSON.'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400, 'Expected a JSON object.');
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new RequestError(413, 'Request body is too large.');
  return value;
}

function hasBearer(req, secret) {
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function hosted(env) { return Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME); }
function localRequest(req, env) {
  if (hosted(env)) return false;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    return ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname);
  } catch { return false; }
}
function authorizeAdmin(req, env) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Cross-site changes are not allowed.');
  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      if (origin.host !== req.headers.host) throw new Error();
    } catch { throw new RequestError(403, 'Request origin is not allowed.'); }
  }
  if (env.ADMIN_TOKEN) {
    if (!hasBearer(req, env.ADMIN_TOKEN)) throw new RequestError(401, 'An administrator token is required.');
  } else if (!localRequest(req, env)) {
    throw new RequestError(403, 'Configure ADMIN_TOKEN to enable remote administrative actions.');
  }
}
function dateRange(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new RequestError(400, 'date must be YYYY-MM-DD.');
  const utc = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value) throw new RequestError(400, 'Invalid calendar date.');
  const start = utc - 8 * 3600000;
  if (start < 0) throw new RequestError(400, 'Date must be after 1970-01-01.');
  return { start, end: start + DAY_MS - 1 };
}
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let text = String(value);
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}

let application;
function getApplication() {
  if (!application) {
    const db = getDatabase();
    application = { db, collector: new BusCollector(db) };
  }
  return application;
}

export function createRequestHandler({ db, collector, env = process.env } = {}) {
  const apiCache = new Map();
  function getCached(key) {
    const item = apiCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      apiCache.delete(key);
      return null;
    }
    return item.payload;
  }
  function setCached(key, payload, ttlMs) {
    apiCache.set(key, { payload, expiresAt: Date.now() + ttlMs });
    if (apiCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of apiCache) {
        if (v.expiresAt <= now || apiCache.size > 150) apiCache.delete(k);
      }
    }
  }
  function clearCache() {
    apiCache.clear();
  }

  function resolveDependencies() {
    if (!db && !collector && env === process.env) {
      ({ db, collector } = getApplication());
    } else {
      db ||= getDatabase(env);
      collector ||= new BusCollector(db, { env });
    }
  }
  return async function requestHandler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { throw new RequestError(400, 'Invalid URL encoding.'); }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) throw new RequestError(400, 'Invalid path.');
      const method = (req.method || 'GET').toUpperCase();
      if (API_METHODS['/api' + pathname]) pathname = '/api' + pathname;
      const expectedMethod = API_METHODS[pathname];
      if (expectedMethod && method === 'OPTIONS') {
        res.writeHead(204, { Allow: `${expectedMethod}, OPTIONS` });
        return res.end();
      }
      if (expectedMethod && method !== expectedMethod) {
        res.setHeader('Allow', expectedMethod);
        return sendJson(res, 405, { error: 'Method not allowed.' });
      }
      if (expectedMethod === 'POST') authorizeAdmin(req, env);
      if (expectedMethod) resolveDependencies();
      const now = Date.now();
      if (pathname === '/api/status') {
        const cached = getCached('status');
        if (cached) {
          return sendJson(res, 200, cached, 'public, max-age=15, s-maxage=30, stale-while-revalidate=60');
        }
        const [status, fleet, availableDates] = await Promise.all([
          collector.getStatus(), db.getAllFleetStatus(), db.getAvailableDates()
        ]);
        const responseData = { ...status, routes: NUS_ROUTES,
          knownFleetCount: fleet.length, availableDates,
          timeZone: 'Asia/Singapore', storage: db.storage.type,
          adminRequired: Boolean(env.ADMIN_TOKEN) || !localRequest(req, env) };
        setCached('status', responseData, 30000);
        return sendJson(res, 200, responseData, 'public, max-age=15, s-maxage=30, stale-while-revalidate=60');
      }
      if (pathname === '/api/live') {
        const cached = getCached('live');
        if (cached) {
          return sendJson(res, 200, cached, 'public, max-age=10, s-maxage=15, stale-while-revalidate=30');
        }
        const latestPollPromise = db.getLatestPoll();
        const [buses, allFleet, latestPoll, status] = await Promise.all([
          db.getLatestLiveBuses(), db.getAllFleetStatus(), latestPollPromise,
          collector.getStatus({ latestPoll: latestPollPromise })
        ]);
        const responseData = { timestamp: now, lastPolledAt: status.lastPolledAt, isStale: status.isStale,
          latestPoll,
          buses, allFleet, activeCount: buses.length,
          inactiveCount: allFleet.filter(bus => bus.status === 'inactive').length,
          staleCount: allFleet.filter(bus => bus.status === 'stale').length,
          knownFleetCount: allFleet.length, routes: NUS_ROUTES };
        setCached('live', responseData, 15000);
        return sendJson(res, 200, responseData, 'public, max-age=10, s-maxage=15, stale-while-revalidate=30');
      }
      if (pathname === '/api/history/24h') {
        const cacheKey = 'history:' + url.search;
        const cached = getCached(cacheKey);
        if (cached) {
          const cacheHeader = cached._cacheHeader || 'public, max-age=30, s-maxage=60, stale-while-revalidate=120';
          const { _cacheHeader, ...cleanData } = cached;
          return sendJson(res, 200, cleanData, cacheHeader);
        }
        const mode = url.searchParams.get('mode') || 'rolling';
        if (!['rolling', 'date'].includes(mode)) throw new RequestError(400, 'mode must be rolling or date.');
        const selectedDate = mode === 'date' ? url.searchParams.get('date') : null;
        const { start, end } = mode === 'date' ? dateRange(selectedDate) : { start: now - DAY_MS, end: now };
        const effectiveEnd = Math.min(end, now);
        const [history, dataSources, availableDates] = await Promise.all([
          db.get24HourHistory(start, effectiveEnd), db.getDataSources(start, effectiveEnd), db.getAvailableDates()
        ]);
        const responseData = { mode, selectedDate, currentTime: now, timeZone: 'Asia/Singapore',
          queryRange: { start, end, effectiveEnd, startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() },
          ...history, dataSources, availableDates, routes: NUS_ROUTES };
        const isPastDate = mode === 'date' && effectiveEnd < now - 3600000;
        const ttlMs = isPastDate ? 3600000 : 60000;
        const cacheHeader = isPastDate
          ? 'public, max-age=86400, s-maxage=86400'
          : 'public, max-age=30, s-maxage=60, stale-while-revalidate=120';
        setCached(cacheKey, { ...responseData, _cacheHeader: cacheHeader }, ttlMs);
        return sendJson(res, 200, responseData, cacheHeader);
      }
      if (pathname === '/api/history/vehicle-snapshots') {
        const plate = url.searchParams.get('plate');
        if (!plate) throw new RequestError(400, 'plate parameter is required.');
        const limit = url.searchParams.get('limit') || 200;
        const cacheKey = `vehicle:${plate}:${limit}`;
        const cached = getCached(cacheKey);
        if (cached) {
          return sendJson(res, 200, cached, 'public, max-age=15, s-maxage=30, stale-while-revalidate=60');
        }
        const snapshots = await db.getVehicleSnapshots(plate, limit);
        const responseData = { vehplate: plate, count: snapshots.length, snapshots };
        setCached(cacheKey, responseData, 30000);
        return sendJson(res, 200, responseData, 'public, max-age=15, s-maxage=30, stale-while-revalidate=60');
      }
      if (pathname === '/api/analytics/optimize') {
        const cached = getCached('analytics');
        if (cached) {
          return sendJson(res, 200, cached, 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');
        }
        const [analytics, dataSources] = await Promise.all([
          db.getHourlyAnalytics(now - 7 * DAY_MS, now), db.getDataSources(now - 7 * DAY_MS, now)
        ]);
        const responseData = { ...analytics, timeZone: 'Asia/Singapore', dataSources,
          note: 'Observed averages from the past seven days. Sampling coverage varies; these are not travel forecasts.' };
        setCached('analytics', responseData, 300000);
        return sendJson(res, 200, responseData, 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');
      }
      if (pathname === '/api/poll-now' || pathname === '/api/cron') {
        const result = await collector.pollNow();
        if (result.success) clearCache();
        return sendJson(res, result.success ? 200 : result.statusCode || 502, result);
      }
      if (pathname === '/api/settings') {
        await parseBody(req);
        if (collector.isPolling) throw new RequestError(409, 'Wait for the current poll to finish before changing credentials.');
        clearCache();
        const status = await collector.getStatus();
        return sendJson(res, 200, { success: true, authMode: status.authMode, dataProvider: status.dataProvider, hasToken: status.hasToken, message: 'Settings are managed automatically.' });
      }
      if (pathname === '/api/clear-all') {
        if (collector.isPolling) throw new RequestError(409, 'Wait for the current poll to finish before clearing history.');
        const clearedCount = await db.clearAllSnapshots();
        await db.deleteSetting('last_error');
        clearCache();
        return sendJson(res, 200, { success: true, clearedCount, remainingSnapshots: 0 });
      }
      if (pathname === '/api/export') {
        const rawLimit = url.searchParams.get('limit') || '10000';
        if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100000) throw new RequestError(400, 'limit must be between 1 and 100000.');
        const rows = await db.getExportRows(Number(rawLimit));
        const columns = ['timestamp', 'time_iso', 'time_str', 'route_code', 'vehplate', 'lat', 'lng', 'speed', 'capacity', 'crowd_level', 'occupancy', 'ridership', 'source_provider', 'data_coverage', 'monitored_stops'];
        const csv = columns.join(',') + '\r\n' + rows.map(row => columns.map(key => csvCell(row[key])).join(',')).join('\r\n');
        if (hosted(env) && Buffer.byteLength(csv) > 4_000_000) {
          throw new RequestError(413, 'Export exceeds the hosted response limit. Retry with a smaller limit, for example /api/export?limit=1000.');
        }
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="nus_bus_crowd_data.csv"',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(csv) });
        return res.end(csv);
      }
      if (!pathname.startsWith('/api') && ['GET', 'HEAD', 'POST'].includes(method) && !hosted(env)) {
        const asset = STATIC_FILES[pathname];
        if (asset && ['GET', 'HEAD'].includes(method)) {
          const content = await fs.readFile(path.join(PUBLIC_DIR, asset[0]));
          res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Content-Length': content.length,
            'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
          return res.end(method === 'HEAD' ? undefined : content);
        }
        if (pathname.startsWith('/_vercel/')) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
          return res.end('{"ok":true}');
        }
      }
      return sendJson(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (error instanceof DatabaseConfigurationError) return sendJson(res, 503, { success: false, error: error.message });
      const failure = databaseFailure(error);
      if (failure) {
        console.error(`[Database] ${failure.databaseCode}: ${failure.error}`);
        return sendJson(res, failure.statusCode, { success: false, ...failure });
      }
      return sendJson(res, error.status || 500, { success: false, error: error instanceof RequestError ? error.message : 'Internal server error.' });
    }
  };
}

export const handleRequest = createRequestHandler();
export const server = http.createServer(handleRequest);
server.requestTimeout = 15000;
server.headersTimeout = 10000;

if (!hosted(process.env) && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Validate storage before listening or starting provider collection.
  const { db, collector } = getApplication();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  server.once('error', error => {
    console.error(`Unable to start server: ${error.code || 'unknown error'}. Set PORT to an available port.`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`NUS Shuttle Bus Crowd Tracker: http://${host}:${server.address().port}`);
    console.log('Collection runs every 1 minute. Automatic guest access renews daily; source and coverage are shown in the dashboard.');
    collector.start();
  });
  const shutdown = async () => {
    collector.stop();
    await new Promise(resolve => server.close(resolve));
    if (collector.pendingPoll) await collector.pendingPoll;
    await db.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
