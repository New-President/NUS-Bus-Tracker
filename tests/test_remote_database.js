import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import './no_provider_network.js';
import { createTestDatabase } from './database_fixture.js';

for (const key of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'FMS_TOKEN', 'VERCEL', 'AWS_LAMBDA_FUNCTION_NAME']) delete process.env[key];
const { createDatabase, getDatabase, DatabaseConfigurationError } = await import('../src/db.js');
const { RemoteBusDatabase } = await import('../src/remote_db.js');
const { BusCollector } = await import('../src/collector.js');
const { createRequestHandler } = await import('../src/server.js');

const DAY_MS = 86400000;
const SINGAPORE_OFFSET = 8 * 3600000;
const bus = (vehplate = 'OBSERVED1', extra = {}) => ({ route_code: 'A1', vehplate, ...extra });

// The libSQL native Windows driver retains file handles after close(). Use the
// same asynchronous client contract with real SQLite transactions on Windows;
// Linux/macOS exercise the actual libSQL SDK against the temporary file.
function windowsSqliteClient(url) {
  let database = new DatabaseSync(fileURLToPath(url));
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  function execute(statement) {
    const { sql, args = [] } = typeof statement === 'string' ? { sql: statement } : statement;
    const prepared = database.prepare(sql);
    if (prepared.columns().length) return { rows: prepared.all(...args).map(row => ({ ...row })), rowsAffected: 0 };
    const result = prepared.run(...args);
    return { rows: [], rowsAffected: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }
  return {
    async execute(statement) { return execute(statement); },
    async batch(statements, mode = 'write') {
      database.exec(mode === 'read' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE');
      try {
        const results = statements.map(execute);
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    close() { database?.close(); database = null; }
  };
}

function durableDatabase(t, wrapClient = client => client) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-remote-db-test-'));
  const url = pathToFileURL(path.join(directory, 'observations.db')).href;
  const clients = new Set();
  t.after(() => {
    for (const client of clients) client.close();
    // SQLite creates only files here; explicit removal also works in Windows
    // environments that restrict the extended paths used by recursive rm.
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  function open() {
    const client = wrapClient(process.platform === 'win32' ? windowsSqliteClient(url) : createClient({ url }));
    clients.add(client);
    return { client, db: new RemoteBusDatabase({ client }) };
  }
  return { open, ...open() };
}

// Local SQLite allows this PRAGMA write, while the hosted Turso service rejects
// it. Enforce that boundary over a real database to cover cloud bootstrap SQL.
function tursoCloudClient(client) {
  function check(statement) {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (/^\s*PRAGMA\s+(?:\w+\.)?user_version\s*(?:=|\()/i.test(sql)) {
      throw new Error('SQL_PARSE_ERROR: SQL not allowed statement: PRAGMA user_version');
    }
  }
  return {
    async execute(statement) { check(statement); return client.execute(statement); },
    async batch(statements, mode) { statements.forEach(check); return client.batch(statements, mode); },
    close() { client.close(); }
  };
}

test('Turso Cloud bootstrap, polling and cold starts work with read-only user_version', async t => {
  const first = durableDatabase(t, tursoCloudClient);
  await assert.rejects(first.client.execute('PRAGMA user_version = 4'), /SQL not allowed/);
  const timestamp = Date.now() - 1000;
  await first.db.setSetting('fms_token', 'cloud-test-token');
  await first.db.recordPoll([bus('CLOUD-FIRST')], timestamp - 1000);
  assert.equal((await first.client.execute('PRAGMA user_version')).rows[0].user_version, 0);
  first.db.close();

  const restarted = first.open();
  assert.equal(await restarted.db.getSetting('fms_token'), 'cloud-test-token');
  assert.equal((await restarted.db.getLatestPoll(timestamp)).records_count, 1);
  await restarted.db.recordPoll([bus('CLOUD-RESTARTED')], timestamp);
  const second = first.open();
  assert.equal(await second.db.getTotalSnapshotsCount(), 2);
  assert.equal(await second.db.getSetting('last_polled_at'), String(timestamp));
  assert.deepEqual((await second.db.getLatestLiveBuses(timestamp)).map(row => row.vehplate), ['CLOUD-RESTARTED']);
  assert.equal((await second.client.execute('PRAGMA user_version')).rows[0].user_version, 0);
});

test('a compatible legacy version 4 database is adopted without losing observations or settings', async t => {
  const first = durableDatabase(t);
  const timestamp = Date.now() - 1000;
  await first.db.setSetting('fms_token', 'legacy-test-token');
  await first.db.recordPoll([bus('LEGACY')], timestamp);
  // Emulate an import created by the previous version of the application.
  await first.client.batch(['DROP TABLE bus_schema_version', 'PRAGMA user_version = 4'], 'write');
  first.db.close();

  const imported = first.open();
  assert.equal(await imported.db.getSetting('fms_token'), 'legacy-test-token');
  assert.equal(await imported.db.getTotalSnapshotsCount(), 1);
  assert.equal((await imported.db.getLatestLiveBuses(timestamp))[0].vehplate, 'LEGACY');
  assert.equal((await imported.client.execute('SELECT version FROM bus_schema_version WHERE id = 1')).rows[0].version, 4);
  const reopened = first.open();
  assert.equal(await reopened.db.getSetting('last_polled_at'), String(timestamp));
});

test('independent remote database instances share settings and observations across restarts', async t => {
  const first = durableDatabase(t);
  const timestamp = Date.now() - 1000;
  await first.db.setSetting('fms_token', 'stored-test-token');
  await first.db.recordPoll([bus('DURABLE', { ridership: 0, occupancy: 0 })], timestamp, {
    dataProvider: 'univus', coverage: 'route-fleet'
  });
  const second = first.open();
  assert.equal(await second.db.getSetting('fms_token'), 'stored-test-token');
  assert.equal((await second.db.getLatestLiveBuses(timestamp))[0].vehplate, 'DURABLE');
  await first.db.close();
  const restarted = first.open();
  assert.equal(await restarted.db.getSetting('last_polled_at'), String(timestamp));
  assert.equal(await restarted.db.getTotalSnapshotsCount(), 1);
  assert.equal((await restarted.db.getDataSources(0, timestamp))[0].dataProvider, 'univus');
  await restarted.db.setSetting('last_error', 'A retained collection failure');
  assert.equal(await second.db.getSetting('last_error'), 'A retained collection failure');
  assert.deepEqual(restarted.db.storage, { type: 'turso', persistent: true });
});

test('remote duplicate plates roll back the complete batch and last successful poll time', async t => {
  const db = createTestDatabase(t);
  const { client } = db;
  const timestamp = Date.now() - 1000;
  await db.recordPoll([bus('EXISTING')], timestamp - 1000);
  const before = await db.getLatestPoll(timestamp);
  await assert.rejects(db.recordPoll([bus('DUPLICATE'), bus('DUPLICATE')], timestamp), /UNIQUE|duplicate/i);
  assert.equal(await db.getTotalSnapshotsCount(), 1);
  assert.equal((await client.execute('SELECT COUNT(*) AS count FROM poll_batches')).rows[0].count, 1);
  assert.deepEqual(await db.getLatestPoll(timestamp), before);
  assert.equal(await db.getSetting('last_polled_at'), String(timestamp - 1000));
  assert.deepEqual((await db.getLatestLiveBuses(timestamp)).map(row => row.vehplate), ['EXISTING']);

  for (const invalid of [{ occupancy: NaN }, { speed: -1 }, { capacity: 0 }, { ridership: 1.5 }, { lat: 91 }, { crowd_level: 'unknown' }]) {
    await assert.rejects(db.recordPoll([bus('INVALID', invalid)], timestamp));
  }
  assert.equal(await db.getTotalSnapshotsCount(), 1);
});

test('a remote empty poll clears the active fleet while retaining historical observations', async t => {
  const db = createTestDatabase(t);
  const timestamp = Date.now() - 1000;
  await db.recordPoll([bus('DEPARTED', { lat: 1.3, lng: 103.8 })], timestamp - 1000);
  const result = await db.recordPoll([], timestamp, {
    dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN']
  });
  assert.equal(result.recordsCount, 0);
  assert.deepEqual(await db.getLatestLiveBuses(timestamp), []);
  const fleet = await db.getAllFleetStatus(timestamp);
  assert.equal(fleet[0].status, 'inactive');
  assert.equal(fleet[0].lat, 1.3);
  assert.equal(await db.getTotalSnapshotsCount(), 1);
  assert.equal(await db.getSetting('last_polled_at'), String(timestamp));
  const sources = await db.getDataSources(0, timestamp);
  const emptySource = sources.find(source => source.dataProvider === 'community');
  assert.equal(emptySource.batchCount, 1);
  assert.equal(emptySource.recordsCount, 0);
  assert.deepEqual(emptySource.monitoredStops, ['UTOWN']);
});

test('remote observations preserve provenance, Singapore dates and measured analytics', async t => {
  const db = createTestDatabase(t);
  const midnight = Math.floor((Date.now() + SINGAPORE_OFFSET) / DAY_MS) * DAY_MS - SINGAPORE_OFFSET - DAY_MS;
  const fixtures = [
    { timestamp: midnight - 60000, records: [bus('UNKNOWN')], metadata: {} },
    { timestamp: midnight + 5 * 60000, records: [bus('ZERO', { ridership: 0, occupancy: 0, speed: 0, lat: 0, lng: 0 })],
      metadata: { dataProvider: 'univus', coverage: 'route-fleet' } },
    { timestamp: midnight + 15 * 60000, records: [bus('MEASURED', { route_code: 'D1', occupancy: 0.8, ridership: 40 }), bus('UNKNOWN')],
      metadata: { dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN', 'KR-MRT', 'UTOWN'] } },
    { timestamp: midnight + 25 * 60000, records: [], metadata: { dataProvider: 'univus', coverage: 'route-fleet' } }
  ];
  for (const [index, { records, timestamp, metadata }] of fixtures.entries()) {
    assert.deepEqual(await db.recordPoll(records, timestamp, metadata), {
      batchId: index + 1, recordsCount: records.length, timestamp
    });
  }
  const end = midnight + 30 * 60000;
  const latestPoll = await db.getLatestPoll(end);
  assert.equal(latestPoll.id, 4);
  assert.equal(latestPoll.records_count, 0);
  assert.equal(latestPoll.source_provider, 'univus');
  const live = await db.getLatestLiveBuses(midnight + 16 * 60000);
  assert.deepEqual(live.map(row => row.vehplate), ['UNKNOWN', 'MEASURED']);
  assert.ok(live.every(row => row.source_provider === 'community' && row.data_coverage === 'stop-arrivals'));
  assert.ok(live.every(row => row.monitored_stops === '["KR-MRT","UTOWN"]'));
  const zero = (await db.getLatestLiveBuses(midnight + 5 * 60000))[0];
  assert.equal(zero.source_provider, 'univus');
  for (const field of ['ridership', 'occupancy', 'speed', 'lat', 'lng']) assert.equal(zero[field], 0, field);
  const fleet = await db.getAllFleetStatus(end);
  assert.equal(fleet.length, 3);
  assert.ok(fleet.every(row => row.status === 'inactive'));
  assert.ok((await db.getAllFleetStatus(end + 20 * 60000)).every(row => row.status === 'stale'));
  assert.equal(await db.getTotalSnapshotsCount(), 4);
  const sources = await db.getDataSources(midnight - 60000, end);
  assert.deepEqual(sources.map(source => [source.dataProvider, source.batchCount, source.recordsCount]), [
    ['community', 1, 2], ['connectx', 1, 1], ['univus', 2, 1]
  ]);
  const dates = await db.getAvailableDates();
  assert.deepEqual(dates, [midnight, midnight - DAY_MS].map(value => new Date(value + SINGAPORE_OFFSET).toISOString().slice(0, 10)));
  const history = await db.get24HourHistory(midnight - 60000, end);
  assert.deepEqual(history.campusData.map(row => row.time_str), ['23:50', '00:00', '00:10']);
  assert.deepEqual(history.campusData.map(row => row.avg_occupancy_pct), [null, 0, 80]);
  assert.deepEqual(history.campusData.map(row => row.sample_count), [1, 1, 2]);
  const analytics = await db.getCommuteOptimizationAnalytics(midnight - 60000, end);
  assert.deepEqual(await db.getHourlyAnalytics(midnight - 60000, end), analytics);
  assert.equal(analytics.timezone, 'Asia/Singapore');
  assert.deepEqual(analytics.campusHourly.map(row => row.hour), [0, 23]);
  assert.equal(analytics.campusHourly[0].sample_count, 3);
  assert.equal(analytics.campusHourly[0].occupancy_sample_count, 2);
  assert.equal(analytics.campusHourly[0].avg_occupancy_pct, 40);
  assert.equal(analytics.campusHourly[0].avg_ridership, 20);
  assert.equal(analytics.campusHourly[1].avg_occupancy_pct, null);
  assert.deepEqual(analytics.bestWindows.map(row => row.hour), [0]);
  assert.deepEqual(analytics.busiestHours.map(row => row.hour), [0]);
  const exported = await db.getExportRows(2);
  assert.deepEqual(exported.map(row => row.vehplate), ['UNKNOWN', 'MEASURED']);
  assert.ok(exported.every(row => row.source_provider === 'community'));
  assert.equal(await db.clearAllSnapshots(), 4);
  assert.equal(await db.getLatestPoll(), null);
  assert.deepEqual(await db.getAvailableDates(), []);
  assert.equal(await db.getSetting('last_polled_at'), '0');
});

test('a transient remote schema initialization failure can recover on the next request', async t => {
  const { client } = createTestDatabase(t);
  let failOnce = true;
  const interruptedClient = new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (failOnce && ['execute', 'batch', 'executeMultiple'].includes(property)) {
          failOnce = false;
          return Promise.reject(new Error('Temporary database connection failure'));
        }
        return value.apply(target, args);
      };
    }
  });
  const db = new RemoteBusDatabase({ client: interruptedClient });
  await assert.rejects(db.getSetting('fms_token'), /Temporary database connection failure/);
  assert.equal(await db.getSetting('fms_token'), '');
  await db.recordPoll([bus('AFTER-RETRY')], Date.now() - 1000);
  assert.equal(await db.getTotalSnapshotsCount(), 1);
});

test('the actual libSQL SDK executes remote SQL and rolls back a failed poll', async t => {
  const db = createTestDatabase(t);
  const timestamp = Date.now() - 1000;
  const records = [bus('SDK-UNKNOWN'), bus('SDK-ZERO', { occupancy: 0, ridership: 0 })];
  const metadata = { dataProvider: 'univus', coverage: 'route-fleet' };
  await db.recordPoll(records, timestamp, metadata);
  await assert.rejects(db.recordPoll([bus('DUPLICATE'), bus('DUPLICATE')], timestamp), /UNIQUE|duplicate/i);
  const poll = await db.getLatestPoll(timestamp);
  assert.equal(poll.id, 1);
  assert.equal(poll.records_count, 2);
  assert.equal(poll.source_provider, 'univus');
  const live = await db.getLatestLiveBuses(timestamp);
  assert.deepEqual(live.map(row => row.vehplate), ['SDK-UNKNOWN', 'SDK-ZERO']);
  assert.equal(live[0].occupancy, null);
  assert.equal(live[0].ridership, null);
  assert.equal(live[1].occupancy, 0);
  assert.equal(live[1].ridership, 0);
  assert.ok((await db.getAllFleetStatus(timestamp)).every(row => row.status === 'active'));
  assert.equal(await db.getTotalSnapshotsCount(), 2);
  assert.deepEqual(await db.getDataSources(0, timestamp), [{
    dataProvider: 'univus', coverage: 'route-fleet', monitoredStops: [],
    batchCount: 1, recordsCount: 2, firstObservedAt: timestamp, lastObservedAt: timestamp
  }]);
  const history = await db.get24HourHistory(timestamp - 600000, timestamp);
  assert.equal(history.campusData.length, 1);
  assert.equal(history.campusData[0].sample_count, 2);
  assert.equal(history.campusData[0].occupancy_sample_count, 1);
  assert.equal(history.campusData[0].avg_occupancy_pct, 0);
  assert.deepEqual(await db.getAvailableDates(), [new Date(timestamp + SINGAPORE_OFFSET).toISOString().slice(0, 10)]);
  const analytics = await db.getHourlyAnalytics(timestamp - 600000, timestamp);
  assert.equal(analytics.campusHourly.length, 1);
  assert.equal(analytics.campusHourly[0].avg_occupancy_pct, 0);
  assert.equal(analytics.campusHourly[0].avg_ridership, 0);
  assert.equal(analytics.bestWindows.length, 1);
  assert.deepEqual((await db.getExportRows()).map(row => row.vehplate), ['SDK-ZERO', 'SDK-UNKNOWN']);
  assert.equal(await db.getSetting('last_polled_at'), String(timestamp));
  await db.recordPoll([], timestamp);
  assert.deepEqual(await db.getLatestLiveBuses(timestamp), []);
  assert.equal(await db.clearAllSnapshots(), 2);
  assert.equal(await db.getLatestPoll(), null);
});

test('remote configuration rejects incomplete or insecure URLs before any network request', () => {
  for (const options of [
    {}, { authToken: 'test-token' }, { url: 'libsql://example.turso.io' },
    { url: 'https://example.turso.io', authToken: ' ' },
    ...['invalid', 'http://example.turso.io', 'file:observations.db', 'libsql://example.turso.io?tls=0',
      'https://example.turso.io?token=secret', 'libsql://user:password@example.turso.io',
      'https://example.turso.io#fragment'].map(url => ({ url, authToken: 'test-token' }))
  ]) {
    assert.throws(() => new RemoteBusDatabase(options), /TURSO_DATABASE_URL|TURSO_AUTH_TOKEN/);
  }
});

test('the application requires complete Turso configuration and rejects insecure URLs', () => {
  for (const env of [
    {}, { TURSO_DATABASE_URL: 'libsql://example.turso.io' }, { TURSO_AUTH_TOKEN: 'test-token' },
    { TURSO_DATABASE_URL: ' ', TURSO_AUTH_TOKEN: 'test-token' },
    { TURSO_DATABASE_URL: 'libsql://example.turso.io', TURSO_AUTH_TOKEN: ' ' },
    { TURSO_DATABASE_URL: 'http://example.turso.io', TURSO_AUTH_TOKEN: 'test-token' },
    { TURSO_DATABASE_URL: 'file:observations.db', TURSO_AUTH_TOKEN: 'test-token' }
  ]) {
    assert.throws(() => createDatabase(env), error => {
      assert.ok(error instanceof DatabaseConfigurationError);
      assert.match(error.message, /TURSO_DATABASE_URL/);
      assert.doesNotMatch(error.message, /test-token/);
      return true;
    });
  }
});

test('application clients are lazy, shared per environment and replaced after closing', t => {
  const env = { TURSO_DATABASE_URL: 'libsql://example.turso.io', TURSO_AUTH_TOKEN: 'test-token' };
  const db = getDatabase(env);
  t.after(() => db.close());
  assert.ok(db instanceof RemoteBusDatabase);
  assert.equal(db.initialization, null);
  assert.equal(getDatabase(env), db);
  const separate = getDatabase({ ...env });
  t.after(() => separate.close());
  assert.notEqual(separate, db);
  assert.equal(separate.initialization, null);
  db.close();
  const reopened = getDatabase(env);
  t.after(() => reopened.close());
  assert.notEqual(reopened, db);
  assert.equal(reopened.closed, false);
  assert.equal(reopened.initialization, null);
});

test('remote initialization is lazy and concurrent first reads share one bootstrap', async t => {
  const { client } = createTestDatabase(t);
  let batches = 0;
  const trackedClient = {
    execute: statement => client.execute(statement),
    batch: (...args) => { batches++; return client.batch(...args); },
    close: () => client.close()
  };
  const db = new RemoteBusDatabase({ client: trackedClient });
  assert.equal(batches, 0);
  assert.deepEqual(await Promise.all([db.getSetting('fms_token'), db.getLatestPoll(), db.getTotalSnapshotsCount()]), ['', null, 0]);
  assert.equal(batches, 2, 'One schema inspection and one bootstrap must serve every first read');
  assert.equal(await db.getSetting('last_polled_at'), '0');
  assert.equal(batches, 2);
});

test('remote initialization refuses unsupported schemas without changing their contents', async t => {
  for (const version of [3, 5]) {
    const db = createTestDatabase(t);
    const { client } = db;
    await client.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await client.execute("INSERT INTO settings(key, value) VALUES ('retained', 'existing data')");
    await client.execute(`PRAGMA user_version = ${version}`);
    await assert.rejects(db.getSetting('retained'), /schema|newer/);
    assert.equal((await client.execute("SELECT value FROM settings WHERE key = 'retained'")).rows[0].value, 'existing data');
    assert.equal((await client.execute('PRAGMA user_version')).rows[0].user_version, version);
    assert.equal((await client.execute('SELECT COUNT(*) AS count FROM settings')).rows[0].count, 1);
  }
});

test('table-based schema versions reject older and newer databases without modifying stored data', async t => {
  for (const version of [3, 5]) {
    const original = createTestDatabase(t);
    await original.setSetting('retained', 'existing data');
    await original.recordPoll([bus('RETAINED')], Date.now() - 1000);
    await original.client.execute({ sql: 'UPDATE bus_schema_version SET version = ? WHERE id = 1', args: [version] });
    const reopened = new RemoteBusDatabase({ client: original.client });
    await assert.rejects(reopened.getSetting('retained'), /schema|newer/);
    assert.equal((await original.client.execute('SELECT version FROM bus_schema_version')).rows[0].version, version);
    assert.equal((await original.client.execute("SELECT value FROM settings WHERE key = 'retained'")).rows[0].value, 'existing data');
    assert.equal((await original.client.execute('SELECT COUNT(*) AS count FROM snapshots')).rows[0].count, 1);
  }
});

test('partial schemas and missing version metadata are refused without repair writes', async t => {
  for (const damage of ['DROP TABLE snapshots', 'DELETE FROM bus_schema_version']) {
    const original = createTestDatabase(t);
    await original.setSetting('retained', 'existing data');
    await original.client.execute(damage);
    const before = await original.client.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name");
    const versionBefore = await original.client.execute('SELECT id, version FROM bus_schema_version');
    const reopened = new RemoteBusDatabase({ client: original.client });
    await assert.rejects(reopened.getSetting('retained'), /schema/);
    assert.deepEqual((await original.client.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")).rows, before.rows);
    assert.deepEqual((await original.client.execute('SELECT id, version FROM bus_schema_version')).rows, versionBefore.rows);
    assert.equal((await original.client.execute("SELECT value FROM settings WHERE key = 'retained'")).rows[0].value, 'existing data');
  }
});

class Response extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.headers = {}; this.data = ''; }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
    return this;
  }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  end(chunk) { if (chunk !== undefined) this.data += chunk; this.emit('finish'); }
}

async function invoke(handler, url, { method = 'GET', body, token } = {}) {
  const req = {
    url, method, body, socket: { remoteAddress: '203.0.113.1' },
    headers: { host: 'tracker.example', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}) }
  };
  const res = new Response();
  await handler(req, res);
  const json = res.headers['content-type']?.startsWith('application/json') ? JSON.parse(res.data) : undefined;
  return { status: res.statusCode, data: res.data, json };
}

test('serverless handler awaits durable collection, reads, settings, export and clearing', async t => {
  const { db, open } = durableDatabase(t);
  const timestamp = Date.now() - 1000;
  const env = { VERCEL: '1', ADMIN_TOKEN: 'test-admin', CRON_SECRET: 'test-cron' };
  let providerCalls = 0;
  const collector = new BusCollector(db, {
    env, now: () => timestamp,
    univusClient: {
      async fetchBuses() { providerCalls++; return [bus('HTTP-DURABLE', { occupancy: 0, ridership: 0 })]; },
      getStatus() { return { hasSession: true, tokenSource: 'guest', tokenExpiresAt: null, sessionRenewAt: null }; }
    }
  });
  const handler = createRequestHandler({ db, collector, env });
  const empty = await invoke(handler, '/api/live');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.buses, []);
  assert.equal(providerCalls, 0);
  const poll = await invoke(handler, '/api/cron', { token: env.CRON_SECRET });
  assert.equal(poll.status, 200);
  assert.equal(poll.json.success, true);
  assert.equal(poll.json.recordsCount, 1);
  assert.equal(providerCalls, 1);

  const live = await invoke(handler, '/api/live');
  assert.equal(live.status, 200);
  assert.equal(live.json.buses[0].vehplate, 'HTTP-DURABLE');
  assert.equal(live.json.activeCount, 1);
  assert.equal(live.json.latestPoll.records_count, 1);
  const status = await invoke(handler, '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.storage, 'turso');
  assert.equal(status.json.lastPolledAt, timestamp);
  assert.equal(status.json.knownFleetCount, 1);
  assert.equal(status.json.availableDates.length, 1);
  const history = await invoke(handler, '/api/history/24h');
  assert.equal(history.status, 200);
  assert.equal(history.json.routeData[0].sample_count, 1);
  assert.equal(history.json.dataSources[0].dataProvider, 'univus');
  const analytics = await invoke(handler, '/api/analytics/optimize');
  assert.equal(analytics.status, 200);
  assert.equal(analytics.json.campusHourly[0].avg_occupancy_pct, 0);
  const exported = await invoke(handler, '/api/export');
  assert.equal(exported.status, 200);
  assert.match(exported.data, /HTTP-DURABLE/);
  assert.match(exported.data, /univus/);
  assert.equal(providerCalls, 1, 'Public reads must not create a collection');

  const settings = await invoke(handler, '/api/settings', {
    method: 'POST', token: env.ADMIN_TOKEN, body: { fms_token: 'saved-through-http' }
  });
  assert.equal(settings.status, 200);
  assert.equal(settings.json.success, true);
  assert.doesNotMatch(settings.data, /saved-through-http/);
  const second = open();
  assert.equal(await second.db.getSetting('fms_token'), 'saved-through-http');
  const cleared = await invoke(handler, '/api/clear-all', { method: 'POST', token: env.ADMIN_TOKEN });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.clearedCount, 1);
  assert.equal(await second.db.getTotalSnapshotsCount(), 0);
  assert.equal(await second.db.getSetting('last_polled_at'), '0');
});
