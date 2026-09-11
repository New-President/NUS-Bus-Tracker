import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dbInstance } from './db.js';
import { collectorInstance } from './collector.js';
import { NUS_ROUTES } from './routes.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const DAY_MS = 86400000;
const API_METHODS = {
  '/api/status': 'GET', '/api/live': 'GET', '/api/history/24h': 'GET',
  '/api/analytics/optimize': 'GET', '/api/export': 'GET', '/api/cron': 'GET',
  '/api/poll-now': 'POST', '/api/settings': 'POST', '/api/clear-all': 'POST'
};
const STATIC_FILES = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
  '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'application/javascript'] };

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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

export function createRequestHandler({ db = dbInstance, collector = collectorInstance, env = process.env } = {}) {
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
      const now = Date.now();
      if (pathname === '/api/status') {
        return sendJson(res, 200, { ...collector.getStatus(), routes: NUS_ROUTES,
          knownFleetCount: db.getAllFleetStatus().length, availableDates: db.getAvailableDates(),
          timeZone: 'Asia/Singapore', storage: db.storage.type,
          adminRequired: Boolean(env.ADMIN_TOKEN) || !localRequest(req, env),
          settingsEditable: !env.FMS_TOKEN?.trim() });
      }
      if (pathname === '/api/live') {
        const buses = db.getLatestLiveBuses();
        const allFleet = db.getAllFleetStatus();
        const status = collector.getStatus();
        return sendJson(res, 200, { timestamp: now, lastPolledAt: status.lastPolledAt, isStale: status.isStale,
          latestPoll: db.getLatestPoll(),
          buses, allFleet, activeCount: buses.length,
          inactiveCount: allFleet.filter(bus => bus.status === 'inactive').length,
          staleCount: allFleet.filter(bus => bus.status === 'stale').length,
          knownFleetCount: allFleet.length, routes: NUS_ROUTES });
      }
      if (pathname === '/api/history/24h') {
        const mode = url.searchParams.get('mode') || 'rolling';
        if (!['rolling', 'date'].includes(mode)) throw new RequestError(400, 'mode must be rolling or date.');
        const selectedDate = mode === 'date' ? url.searchParams.get('date') : null;
        const { start, end } = mode === 'date' ? dateRange(selectedDate) : { start: now - DAY_MS, end: now };
        const effectiveEnd = Math.min(end, now);
        return sendJson(res, 200, { mode, selectedDate, currentTime: now, timeZone: 'Asia/Singapore',
          queryRange: { start, end, effectiveEnd, startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() },
          ...db.get24HourHistory(start, effectiveEnd), dataSources: db.getDataSources(start, effectiveEnd),
          availableDates: db.getAvailableDates(), routes: NUS_ROUTES });
      }
      if (pathname === '/api/analytics/optimize') {
        return sendJson(res, 200, { ...db.getHourlyAnalytics(now - 7 * DAY_MS, now), timeZone: 'Asia/Singapore',
          dataSources: db.getDataSources(now - 7 * DAY_MS, now),
          note: 'Observed averages from the past seven days. Sampling coverage varies; these are not travel forecasts.' });
      }
      if (pathname === '/api/poll-now' || pathname === '/api/cron') {
        if (pathname === '/api/cron') {
          if (!env.CRON_SECRET) throw new RequestError(503, 'Configure CRON_SECRET to enable scheduled collection.');
          if (!hasBearer(req, env.CRON_SECRET)) throw new RequestError(401, 'Unauthorized cron request.');
        }
        const result = await collector.pollNow();
        return sendJson(res, result.success ? 200 : result.statusCode || 502, result);
      }
      if (pathname === '/api/settings') {
        const body = await parseBody(req);
        if (Object.keys(body).some(key => key !== 'fms_token') || typeof body.fms_token !== 'string' || body.fms_token.length > 4096 || /[\r\n\0]/.test(body.fms_token)) {
          throw new RequestError(400, 'Provide only fms_token as a string of at most 4096 characters.');
        }
        if (env.FMS_TOKEN?.trim()) throw new RequestError(409, 'FMS_TOKEN is configured by the deployment environment.');
        if (collector.isPolling) throw new RequestError(409, 'Wait for the current poll to finish before changing credentials.');
        db.setSetting('fms_token', body.fms_token.trim());
        db.deleteSetting('last_error');
        db.deleteSetting('last_attempt_at');
        const status = collector.getStatus();
        return sendJson(res, 200, { success: true, authMode: status.authMode, dataProvider: status.dataProvider, hasToken: status.hasToken });
      }
      if (pathname === '/api/clear-all') {
        if (collector.isPolling) throw new RequestError(409, 'Wait for the current poll to finish before clearing history.');
        const clearedCount = db.clearAllSnapshots();
        db.deleteSetting('last_error');
        return sendJson(res, 200, { success: true, clearedCount, remainingSnapshots: 0 });
      }
      if (pathname === '/api/export') {
        const rawLimit = url.searchParams.get('limit') || '10000';
        if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100000) throw new RequestError(400, 'limit must be between 1 and 100000.');
        const rows = db.getExportRows(Number(rawLimit));
        const columns = ['timestamp', 'time_iso', 'time_str', 'route_code', 'vehplate', 'lat', 'lng', 'speed', 'capacity', 'crowd_level', 'occupancy', 'ridership', 'source_provider', 'data_coverage', 'monitored_stops'];
        const csv = columns.join(',') + '\r\n' + rows.map(row => columns.map(key => csvCell(row[key])).join(',')).join('\r\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="nus_bus_crowd_data.csv"',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(csv) });
        return res.end(csv);
      }
      if (!pathname.startsWith('/api') && ['GET', 'HEAD'].includes(method) && !hosted(env)) {
        const asset = STATIC_FILES[pathname];
        if (asset) {
          const content = await fs.readFile(path.join(PUBLIC_DIR, asset[0]));
          res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Content-Length': content.length,
            'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
          return res.end(method === 'HEAD' ? undefined : content);
        }
      }
      return sendJson(res, 404, { error: 'Not found.' });
    } catch (error) {
      return sendJson(res, error.status || 500, { success: false, error: error instanceof RequestError ? error.message : 'Internal server error.' });
    }
  };
}

export const handleRequest = createRequestHandler();
export const server = http.createServer(handleRequest);
server.requestTimeout = 15000;
server.headersTimeout = 10000;

if (!hosted(process.env) && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  server.once('error', error => {
    console.error(`Unable to start server: ${error.code || 'unknown error'}. Set PORT to an available port.`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`NUS Shuttle Bus Crowd Tracker: http://${host}:${server.address().port}`);
    console.log('Collection runs every 10 minutes. Automatic guest access renews daily; source and coverage are shown in the dashboard.');
    collectorInstance.start();
  });
  const shutdown = async () => {
    collectorInstance.stop();
    await new Promise(resolve => server.close(resolve));
    if (collectorInstance.pendingPoll) await collectorInstance.pendingPoll;
    dbInstance.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
