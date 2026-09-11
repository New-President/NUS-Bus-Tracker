import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import { createTestDatabase } from './database_fixture.js';
import './no_provider_network.js';

process.env.VERCEL = '1';
for (const key of ['FMS_TOKEN', 'ADMIN_TOKEN', 'CRON_SECRET', 'AWS_LAMBDA_FUNCTION_NAME', 'BUS_PROVIDER', 'BUS_STOPS', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']) delete process.env[key];
const { default: defaultHandler, createHandler } = await import('../api/index.js');
const { BusCollector } = await import('../src/collector.js');
const db = createTestDatabase();
const collector = new BusCollector(db);
const handler = createHandler({ db, collector, env: process.env });
after(() => db.close());
let univusCalls = 0;
let guestCalls = 0;
let sessionRenewAt = null;
let fetchUnivus = async () => [];
collector.univusClient = {
  async fetchBuses() {
    univusCalls++;
    if (!sessionRenewAt) {
      guestCalls++;
      sessionRenewAt = new Date(Date.now() + 86400000 - 15 * 60000).toISOString();
    }
    return fetchUnivus();
  },
  getStatus() {
    return { hasSession: sessionRenewAt !== null, tokenSource: 'guest', tokenExpiresAt: null, sessionRenewAt,
      sessionCookie: 'serverless-private-session-cookie' };
  }
};
collector.tokenProvider = {
  async getToken() { return 'serverless-guest-provider-token'; },
  invalidate() {},
  getStatus() { return { tokenSource: 'guest', tokenExpiresAt: null }; }
};

class Request extends EventEmitter {
  constructor(url, { method = 'GET', body, headers = {} } = {}) {
    super();
    this.url = url;
    this.method = method;
    this.body = body;
    this.headers = {
      host: 'tracker.example',
      'x-forwarded-proto': 'https',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    };
    this.socket = { remoteAddress: '203.0.113.1' };
  }
}

class Response extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.data = '';
    this.headersSent = false;
    this.writableEnded = false;
  }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headersSent = true;
    for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
    return this;
  }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  getHeader(key) { return this.headers[key.toLowerCase()]; }
  end(chunk) {
    if (chunk !== undefined) this.data += chunk;
    this.writableEnded = true;
    this.emit('finish');
  }
}

async function invoke(url, options = {}, target = handler) {
  const req = new Request(url, options);
  const res = new Response();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Serverless handler did not finish')), 2000);
    res.once('finish', () => { clearTimeout(timer); resolve(); });
    Promise.resolve(target(req, res)).catch(error => { clearTimeout(timer); reject(error); });
  });
  let json;
  try { json = JSON.parse(res.data); } catch {}
  return { status: res.statusCode, headers: res.headers, data: res.data, json };
}

test('serverless public reads do not contact the provider or create data', async () => {
  let called = false;
  fetchUnivus = async () => { called = true; throw new Error('Unexpected upstream access'); };
  collector.fetchBuses = async () => { called = true; throw new Error('Unexpected upstream access'); };
  for (const url of ['/api/status', '/api/live', '/api/history/24h', '/api/analytics/optimize']) {
    const res = await invoke(url);
    assert.equal(res.status, 200, url);
  }
  const live = await invoke('/api/live');
  assert.deepEqual(live.json.buses, []);
  assert.deepEqual(live.json.allFleet, []);
  assert.equal(called, false);
  assert.equal(univusCalls, 0);
  assert.equal(guestCalls, 0);
  assert.equal(await db.getTotalSnapshotsCount(), 0);
});

test('serverless cron requires a configured secret and rejects incorrect authorization', async () => {
  let calls = 0;
  fetchUnivus = async () => { calls++; return []; };
  delete process.env.CRON_SECRET;
  assert.equal((await invoke('/api/cron')).status, 503);
  process.env.CRON_SECRET = 'test-cron-secret';
  assert.equal((await invoke('/api/cron')).status, 401);
  assert.equal((await invoke('/api/cron', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal(calls, 0);
  assert.equal(guestCalls, 0);
  const res = await invoke('/api/cron', { headers: { authorization: 'Bearer test-cron-secret' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.polledCount, 0);
  assert.equal(res.json.dataProvider, 'univus');
  assert.equal(res.json.coverage, 'route-fleet');
  assert.equal(calls, 1);
  assert.equal(univusCalls, 1);
  assert.equal(guestCalls, 1);
  assert.equal(res.data.includes('test-cron-secret'), false);
  assert.equal(res.data.includes('serverless-guest-provider-token'), false);
  const status = await invoke('/api/status');
  assert.equal(status.json.dataProvider, 'univus');
  assert.equal(status.json.hasToken, true);
  assert.equal(status.json.tokenExpiresAt, null);
  assert.equal(status.json.sessionRenewAt, sessionRenewAt);
  assert.doesNotMatch(status.data, /serverless-private-session-cookie|sessionCookie|test-cron-secret/);
  delete process.env.CRON_SECRET;
});

test('serverless authorization cannot be bypassed with forwarded localhost headers', async () => {
  delete process.env.ADMIN_TOKEN;
  const res = await invoke('/api/settings', {
    method: 'POST', body: { fms_token: 'rejected-token' },
    headers: { host: 'localhost', 'x-forwarded-host': 'localhost', 'x-forwarded-for': '127.0.0.1' }
  });
  assert.ok([401, 403, 503].includes(res.status));
  assert.notEqual(await db.getSetting('fms_token'), 'rejected-token');
});

test('serverless pre-parsed settings body is validated and authenticated', async () => {
  process.env.ADMIN_TOKEN = 'serverless-admin-token';
  const headers = { authorization: 'Bearer serverless-admin-token' };
  const saved = await invoke('/api/settings', {
    method: 'POST', headers, body: { fms_token: 'stored-provider-token' }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.success, true);
  assert.equal(saved.data.includes('stored-provider-token'), false);
  assert.equal(await db.getSetting('fms_token'), 'stored-provider-token');
  for (const body of ['{broken', null, [], { fms_token: 1 }]) {
    const res = await invoke('/api/settings', { method: 'POST', headers, body });
    assert.equal(res.status, 400);
  }
  assert.equal(await db.getSetting('fms_token'), 'stored-provider-token');
  delete process.env.ADMIN_TOKEN;
});

test('serverless errors and unknown routes return usable JSON responses', async () => {
  const invalid = await invoke('/api/history/24h?mode=date&date=2026-02-31');
  assert.equal(invalid.status, 400);
  assert.equal(typeof invalid.json.error, 'string');
  const unknown = await invoke('/api/missing');
  assert.equal(unknown.status, 404);
  assert.equal(typeof unknown.json.error, 'string');
});

test('default Vercel handler reports missing Turso configuration without a local fallback', async () => {
  const res = await invoke('/api/status', {}, defaultHandler);
  assert.equal(res.status, 503);
  assert.match(res.json.error, /TURSO_DATABASE_URL.*TURSO_AUTH_TOKEN/);
});
