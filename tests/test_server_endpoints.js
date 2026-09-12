import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import './no_provider_network.js';

for (const key of ['FMS_TOKEN', 'ADMIN_TOKEN', 'CRON_SECRET', 'VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'BUS_PROVIDER', 'BUS_STOPS']) delete process.env[key];
const { createRequestHandler } = await import('../src/server.js');
import { createTestDatabase } from './database_fixture.js';
const { BusCollector } = await import('../src/collector.js');
const { normalizeBus } = await import('../src/api_client.js');

async function fixture(t, env = {}, observations = []) {
  const db = createTestDatabase();
  let calls = 0;
  let guestCalls = 0;
  let sessionRenewAt = null;
  const univusClient = {
    async fetchBuses() {
      calls++;
      if (!sessionRenewAt) {
        guestCalls++;
        sessionRenewAt = new Date(Date.now() + 86400000 - 15 * 60000).toISOString();
      }
      return observations;
    },
    getStatus() {
      return { hasSession: sessionRenewAt !== null, tokenSource: 'guest', tokenExpiresAt: null, sessionRenewAt,
        sessionCookie: 'http-private-session-cookie' };
    }
  };
  const tokenProvider = {
    async getToken() { guestCalls++; return 'http-guest-provider-token'; },
    invalidate() {},
    getStatus() { return { tokenSource: 'guest', tokenExpiresAt: null }; }
  };
  const collector = new BusCollector(db, {
    env, tokenProvider, univusClient,
    fetchBuses: async () => {
      calls++;
      return [];
    }
  });
  const handler = createRequestHandler({ db, collector, env });
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => {
      if (!res.headersSent) res.writeHead(500);
      res.end(error.message);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    collector.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const port = server.address().port;
  const request = (pathname, { method = 'GET', body, rawBody, headers = {} } = {}) => {
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: pathname, method,
        headers: {
          ...(payload === undefined ? {} : {
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)
          }),
          ...headers
        }
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, data, json });
        });
      });
      req.setTimeout(3000, () => req.destroy(new Error('Test request timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  };
  return { db, collector, tokenProvider, univusClient, request, calls: () => calls, guestCalls: () => guestCalls };
}

test('public dashboard reads remain empty until actual observations arrive and never poll', async t => {
  const { request, db, calls, guestCalls } = await fixture(t);
  for (const endpoint of ['/api/status', '/api/live', '/api/history/24h', '/api/analytics/optimize']) {
    const res = await request(endpoint);
    assert.equal(res.status, 200, endpoint);
    assert.equal(res.data.includes('http-private-session-cookie'), false);
  }
  const { json: live } = await request('/api/live');
  assert.deepEqual(live.buses, []);
  assert.deepEqual(live.allFleet, []);
  assert.equal(live.activeCount, 0);
  const { json: history } = await request('/api/history/24h');
  assert.deepEqual(history.routeData, []);
  assert.deepEqual(history.campusData, []);
  const { json: analytics } = await request('/api/analytics/optimize');
  assert.deepEqual(analytics.bestWindows, []);
  assert.deepEqual(analytics.busiestHours, []);
  assert.equal(calls(), 0);
  assert.equal(guestCalls(), 0);
  assert.equal(await db.getTotalSnapshotsCount(), 0);
});

test('static assets are served and encoded path traversal cannot read repository files', async t => {
  const { request } = await fixture(t);
  for (const [pathname, type] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/app.js', 'javascript']]) {
    const res = await request(pathname);
    assert.equal(res.status, 200, pathname);
    assert.ok(res.headers['content-type'].includes(type));
  }
  const head = await request('/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.data, '');
  for (const pathname of ['/..%2fpackage.json', '/%2e%2e%5cpackage.json', '/%00', '/%ZZ']) {
    const res = await request(pathname);
    assert.ok([400, 403, 404].includes(res.status), `Unsafe path ${pathname}: ${res.status}`);
    assert.equal(res.data.includes('"scripts"'), false);
  }
  const unknown = await request('/api/not-a-real-endpoint');
  assert.equal(unknown.status, 404);
  assert.equal(typeof unknown.json.error, 'string');
});

test('calendar history validates real dates and uses Singapore midnight on a UTC host', async t => {
  const { request } = await fixture(t);
  for (const query of ['mode=invalid', 'mode=date', 'mode=date&date=2026-02-30', 'mode=date&date=not-a-date', 'mode=date&date=2026-13-01', 'mode=date&date=0000-01-01', 'mode=date&date=1970-01-01']) {
    const res = await request('/api/history/24h?' + query);
    assert.equal(res.status, 400, query);
  }
  const res = await request('/api/history/24h?mode=date&date=2026-09-09');
  assert.equal(res.status, 200);
  assert.equal(res.json.selectedDate, '2026-09-09');
  assert.equal(res.json.queryRange.start, Date.parse('2026-09-08T16:00:00Z'));
  assert.equal(res.json.queryRange.end - res.json.queryRange.start, 86400000 - 1);
  assert.ok(res.json.queryRange.effectiveEnd <= res.json.currentTime);
});

test('on-demand collection reports guest authentication and upstream failures accurately', async t => {
  const { request, collector, univusClient, db, calls } = await fixture(t);
  univusClient.fetchBuses = async () => { throw new Error('Guest authentication failed'); };
  const unavailable = await request('/api/poll-now', { method: 'POST' });
  assert.equal(unavailable.status, 502);
  assert.equal(unavailable.json.success, false);
  assert.equal(calls(), 0);
  collector.fetchPublic = async () => { throw new Error('Provider unavailable'); };
  const failure = await request('/api/poll-now', { method: 'POST' });
  assert.equal(failure.status, 502);
  assert.equal(failure.json.success, false);
  assert.equal(await db.getTotalSnapshotsCount(), 0);
  univusClient.fetchBuses = async () => [];
  const empty = await request('/api/poll-now', { method: 'POST' });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.success, true);
  assert.equal(empty.json.polledCount, 0);
});

test('on-demand collection works with automatic guest authentication and no saved token', async t => {
  const { request, calls, guestCalls } = await fixture(t);
  const status = await request('/api/status');
  assert.equal(status.json.authMode, 'guest');
  assert.equal(status.json.dataProvider, 'univus');
  assert.equal(status.json.hasToken, false);
  assert.equal(status.json.requiresToken, false);
  assert.equal(status.json.canPoll, true);
  assert.equal(guestCalls(), 0, 'Reading status must not log in');
  const result = await request('/api/poll-now', { method: 'POST' });
  assert.equal(result.status, 200);
  assert.equal(result.json.success, true);
  assert.equal(result.json.dataProvider, 'univus');
  assert.equal(calls(), 1);
  assert.equal(guestCalls(), 1);
});

test('automatic uNivUS collection exposes measured GPS and renewal metadata with API and CSV provenance but no credentials', async t => {
  const timestamp = Date.now() - 1000;
  const observation = normalizeBus({ vehplate: 'TEST-DIRECT-UNIVUS', lat: 1.3038, lng: 103.7738, speed: 12,
    loadInfo: { capacity: 60, ridership: 30 } }, 'A1', timestamp);
  const { request, univusClient, calls, guestCalls } = await fixture(t, {}, [observation]);
  const collected = await request('/api/poll-now', { method: 'POST' });
  assert.equal(collected.status, 200);
  assert.equal(collected.json.recordsCount, 1);
  assert.equal(collected.json.dataProvider, 'univus');
  assert.equal(collected.json.coverage, 'route-fleet');
  const status = await request('/api/status');
  assert.equal(status.json.dataProvider, 'univus');
  assert.equal(status.json.sourceUrl, 'https://univus.nus.edu.sg/');
  assert.equal(status.json.authMode, 'guest');
  assert.equal(status.json.tokenSource, 'guest');
  assert.equal(status.json.hasToken, true);
  assert.equal(status.json.tokenExpiresAt, null, 'Opaque server-session expiry is not invented');
  assert.equal(status.json.sessionRenewAt, univusClient.getStatus().sessionRenewAt);
  assert.ok(Date.parse(status.json.sessionRenewAt) > Date.now());
  const live = await request('/api/live');
  assert.equal(live.json.buses.length, 1);
  assert.equal(live.json.buses[0].lat, observation.lat);
  assert.equal(live.json.buses[0].lng, observation.lng);
  assert.equal(live.json.buses[0].ridership, 30);
  assert.equal(live.json.buses[0].occupancy, 0.5);
  assert.equal(live.json.buses[0].source_provider, 'univus');
  assert.equal(live.json.buses[0].data_coverage, 'route-fleet');
  assert.equal(live.json.latestPoll.source_provider, 'univus');
  const exported = await request('/api/export');
  assert.equal(exported.status, 200);
  assert.match(exported.data, /source_provider,data_coverage,monitored_stops/);
  assert.ok(exported.data.includes('"TEST-DIRECT-UNIVUS",1.3038,103.7738,12,60,'));
  assert.ok(exported.data.includes('"univus","route-fleet","[]"'));
  for (const response of [collected, status, live, exported]) {
    assert.doesNotMatch(response.data, /http-private-session-cookie|http-guest-provider-token|sessionCookie/);
  }
  assert.equal(calls(), 1, 'Read and export endpoints never recollect');
  assert.equal(guestCalls(), 1);
});

test('API method guards and preflight requests cannot trigger collection', async t => {
  const { request, calls } = await fixture(t);
  for (const [pathname, method, allowed] of [
    ['/api/poll-now', 'GET', 'POST'], ['/api/settings', 'GET', 'POST'],
    ['/api/clear-all', 'GET', 'POST'], ['/api/cron', 'POST', 'GET']
  ]) {
    const res = await request(pathname, { method });
    assert.equal(res.status, 405, pathname);
    assert.equal(res.headers.allow, allowed);
  }
  const preflight = await request('/api/poll-now', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(calls(), 0);
});

test('settings report automatic configuration, reject invalid payloads, and reject mutations during collection', async t => {
  const { request, collector } = await fixture(t);
  for (const rawBody of ['{broken', 'null', '[]', '"token"']) {
    const res = await request('/api/settings', { method: 'POST', rawBody });
    assert.equal(res.status, 400, rawBody);
  }
  const oversized = await request('/api/settings', {
    method: 'POST', body: { data: 'x'.repeat(20 * 1024) }
  });
  assert.equal(oversized.status, 413);
  const res = await request('/api/settings', { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.dataProvider, 'univus');
  assert.equal(res.json.authMode, 'guest');
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  collector.univusClient.fetchBuses = async () => new Promise(resolve => { release = resolve; markStarted(); });
  const pending = collector.pollNow();
  await started;
  try {
    const duringPoll = await request('/api/settings', { method: 'POST', body: {} });
    assert.equal(duringPoll.status, 409);
  } finally {
    release([]);
    await pending;
  }
});

test('local administrative actions reject hostile origins and Host headers', async t => {
  const { request } = await fixture(t);
  for (const headers of [
    { Origin: 'https://untrusted.example' },
    { Host: 'untrusted.example' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' }
  ]) {
    const res = await request('/api/settings', {
      method: 'POST', body: {}, headers
    });
    assert.ok([401, 403].includes(res.status), JSON.stringify(headers));
  }
});

test('deployed administrative endpoints require the configured bearer token', async t => {
  const { request } = await fixture(t, { VERCEL: '1', ADMIN_TOKEN: 'test-admin-token' });
  for (const pathname of ['/api/settings', '/api/poll-now', '/api/clear-all']) {
    const denied = await request(pathname, { method: 'POST', body: {} });
    assert.ok([401, 403].includes(denied.status), pathname);
  }
  const allowed = await request('/api/settings', {
    method: 'POST', body: {},
    headers: { Authorization: 'Bearer test-admin-token' }
  });
  assert.equal(allowed.status, 200);
});

test('hosted deployment without administrative credentials cannot mutate data', async t => {
  const { request } = await fixture(t, { VERCEL: '1' });
  const res = await request('/api/settings', { method: 'POST', body: {} });
  assert.ok([401, 403, 503].includes(res.status));
});

test('export quotes provider text, preserves newlines, and neutralizes spreadsheet formulas', async t => {
  const { request, db } = await fixture(t);
  const timestamp = Date.now() - 1000;
  await db.recordPoll([
    normalizeBus({ vehplate: 'TEST,"QUOTED"\nPLATE' }, 'A1', timestamp),
    normalizeBus({ vehplate: '=1+2' }, 'A2', timestamp)
  ], timestamp);
  const res = await request('/api/export');
  assert.equal(res.status, 200);
  assert.ok(res.headers['content-type'].includes('text/csv'));
  assert.ok(res.data.startsWith('timestamp,time_iso'));
  assert.ok(res.data.includes('"TEST,""QUOTED""\nPLATE"'), 'CSV escapes quotes and embedded newlines');
  assert.ok(res.data.includes("'=1+2"), 'CSV formulas are prefixed with an apostrophe');
});

test('clearing history resets observed fleet and returns an accurate count', async t => {
  const { request, db } = await fixture(t);
  const timestamp = Date.now() - 1000;
  await db.recordPoll([normalizeBus({ vehplate: 'TEST-CLEAR' }, 'A1', timestamp)], timestamp);
  const res = await request('/api/clear-all', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.json.clearedCount, 1);
  assert.equal(res.json.remainingSnapshots, 0);
  const live = await request('/api/live');
  assert.deepEqual(live.json.buses, []);
  assert.deepEqual(live.json.allFleet, []);
});

test('CSV export validates the requested row limit', async t => {
  const { request } = await fixture(t);
  for (const limit of ['0', '-1', '1.5', '100001', 'invalid']) {
    const res = await request('/api/export?limit=' + limit);
    assert.equal(res.status, 400, limit);
  }
  assert.equal((await request('/api/export?limit=1')).status, 200);
});

test('hosted CSV exports reject oversized responses with a usable retry hint', async t => {
  const { request, db } = await fixture(t, { VERCEL: '1' });
  db.getExportRows = async limit => limit > 1
    ? [{ vehplate: 'x'.repeat(4_000_000) }]
    : [{ vehplate: 'TEST-SMALL-EXPORT' }];
  const oversized = await request('/api/export');
  assert.equal(oversized.status, 413);
  assert.match(oversized.headers['content-type'], /application\/json/);
  assert.match(oversized.json.error, /smaller limit/);
  const smaller = await request('/api/export?limit=1');
  assert.equal(smaller.status, 200);
  assert.match(smaller.data, /TEST-SMALL-EXPORT/);
});


test('database errors identify Turso failures without exposing driver details', async t => {
  const { LibsqlError } = await import('@libsql/client/web');
  const { request, db } = await fixture(t);
  for (const [driverCode, expectedCode] of [
    ['SQL_PARSE_ERROR', 'database_query_failed'], ['SQLITE_READONLY', 'database_access_failed'],
    ['SERVER_ERROR', 'database_unavailable']
  ]) {
    db.getAvailableDates = async () => { throw new LibsqlError('private-token https://private.example secret SQL', driverCode); };
    const res = await request('/api/status');
    assert.equal(res.status, 503);
    assert.equal(res.json.code, expectedCode);
    assert.equal(res.json.databaseCode, driverCode);
    assert.match(res.json.error, /Turso/);
    assert.doesNotMatch(res.data, /private-token|private.example|secret SQL/);
  }
});
