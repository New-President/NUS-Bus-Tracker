import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BUS_DB_PATH = ':memory:';
const { BusDatabase, dbInstance } = await import('../src/db.js');
after(() => dbInstance.close());

function withDatabase(callback) {
  const db = new BusDatabase(':memory:');
  try { return callback(db); } finally { db.close(); }
}

function bus(vehplate = 'OBSERVED1', extra = {}) {
  return { route_code: 'A1', vehplate, ...extra };
}

function versionThreeFile(dbPath, { orphan = false } = {}) {
  const timestamp = Date.now() - 3000;
  const previous = new DatabaseSync(dbPath);
  try {
    previous.exec(`
      CREATE TABLE poll_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, records_count INTEGER NOT NULL CHECK(records_count >= 0),
        source_provider TEXT NOT NULL DEFAULT 'connectx' CHECK(source_provider IN ('connectx', 'community')),
        data_coverage TEXT NOT NULL DEFAULT 'route-fleet' CHECK(
          (source_provider = 'connectx' AND data_coverage = 'route-fleet') OR
          (source_provider = 'community' AND data_coverage = 'stop-arrivals')),
        monitored_stops TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(monitored_stops) AND json_type(monitored_stops) = 'array')
      );
      CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, poll_batch_id INTEGER NOT NULL REFERENCES poll_batches(id) ON DELETE CASCADE,
        timestamp INTEGER NOT NULL, time_iso TEXT NOT NULL, time_str TEXT NOT NULL, route_code TEXT NOT NULL,
        vehplate TEXT NOT NULL, lat REAL, lng REAL, speed REAL, capacity INTEGER, crowd_level TEXT,
        occupancy REAL, ridership INTEGER, UNIQUE(poll_batch_id, vehplate)
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX idx_poll_batches_time ON poll_batches(timestamp DESC, id DESC);
      CREATE INDEX custom_source_index ON poll_batches(source_provider, records_count);
      CREATE INDEX custom_vehicle_index ON snapshots(vehplate);
      PRAGMA user_version = 3;
    `);
    previous.prepare('INSERT INTO poll_batches(id,timestamp,records_count) VALUES (4,?,1),(100,?,0)').run(timestamp, timestamp + 2000);
    previous.prepare(`INSERT INTO poll_batches(id,timestamp,records_count,source_provider,data_coverage,monitored_stops)
      VALUES (9,?,1,'community','stop-arrivals','["UTOWN"]')`).run(timestamp + 1000);
    previous.exec('DELETE FROM poll_batches WHERE id = 100;');
    const insert = previous.prepare(`INSERT INTO snapshots(id,poll_batch_id,timestamp,time_iso,time_str,route_code,vehplate,ridership)
      VALUES (?,?,?,?,?,'A1',?,?)`);
    insert.run(6, 4, timestamp, new Date(timestamp).toISOString(), '00:00', 'FIRST', 0);
    insert.run(11, 9, timestamp + 1000, new Date(timestamp + 1000).toISOString(), '00:00', 'PUBLIC', 5);
    insert.run(200, 9, timestamp + 1000, new Date(timestamp + 1000).toISOString(), '00:00', 'DELETED', null);
    previous.exec('DELETE FROM snapshots WHERE id = 200;');
    if (orphan) {
      previous.exec('PRAGMA foreign_keys = OFF;');
      insert.run(201, 999, timestamp, new Date(timestamp).toISOString(), '00:00', 'ORPHAN', null);
      previous.exec('PRAGMA foreign_keys = ON;');
    }
    const setting = previous.prepare('INSERT INTO settings(key,value) VALUES (?,?)');
    for (const [key, value] of Object.entries({
      last_polled_at: timestamp + 1000, last_attempt_at: timestamp + 2000,
      last_error: 'Retained provider error', fms_token: 'retained-test-token', custom_setting: 'preserve'
    })) setting.run(key, String(value));
    previous.exec(`
      CREATE TABLE poll_events (batch_id INTEGER);
      CREATE TRIGGER custom_poll_insert AFTER INSERT ON poll_batches BEGIN
        INSERT INTO poll_events(batch_id) VALUES (NEW.id);
      END;
    `);
    return {
      batches: previous.prepare('SELECT * FROM poll_batches ORDER BY id').all(),
      snapshots: previous.prepare('SELECT * FROM snapshots ORDER BY id').all(),
      settings: previous.prepare('SELECT * FROM settings ORDER BY key').all(),
      pollSequence: previous.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'poll_batches'").get().seq,
      snapshotSequence: previous.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'snapshots'").get().seq
    };
  } finally { previous.close(); }
}

test('missing provider fields remain unknown and measured zero is preserved', () => withDatabase(db => {
  const now = Date.now() - 1000;
  db.recordPoll([bus(), bus('OBSERVED2', { speed: 0, occupancy: 0, ridership: 0, lat: 0, lng: 0 })], now);
  const [unknown, zero] = db.getLatestLiveBuses(now);
  for (const field of ['lat', 'lng', 'speed', 'capacity', 'crowd_level', 'occupancy', 'ridership']) assert.equal(unknown[field], null, field);
  for (const field of ['lat', 'lng', 'speed', 'occupancy', 'ridership']) assert.equal(zero[field], 0, field);
  assert.equal(db.storage.type, 'memory');
  assert.equal(db.storage.persistent, false);
}));

test('latest successful batch defines active fleet and an empty poll clears it', () => withDatabase(db => {
  const now = Date.now() - 1000;
  db.recordPoll([bus('OBSERVED1', { lat: 1.3, lng: 103.8, speed: 18 }), bus('OBSERVED2')], now - 1000);
  db.recordPoll([bus('OBSERVED2', { route_code: 'D1' })], now);
  assert.deepEqual(db.getLatestLiveBuses(now).map(row => row.vehplate), ['OBSERVED2']);
  const fleet = db.getAllFleetStatus(now);
  assert.equal(fleet.length, 2);
  assert.equal(fleet[0].status, 'inactive');
  assert.equal(fleet[0].lat, 1.3);
  assert.equal(fleet[0].speed, 18);
  assert.equal(fleet[0].last_seen_at, now - 1000);
  assert.equal(fleet[0].location_name, undefined);
  assert.equal(fleet[1].status, 'active');
  assert.equal(fleet[1].route_code, 'D1');
  db.recordPoll([], now);
  assert.deepEqual(db.getLatestLiveBuses(now), []);
  assert.ok(db.getAllFleetStatus(now).every(row => row.status === 'inactive'));
  assert.equal(db.getLatestPoll(now).records_count, 0);
  assert.equal(db.getSetting('last_polled_at'), String(now));
}));

test('stale observations stay historical and future batches never leak into results', () => withDatabase(db => {
  const now = Date.now() - 2000;
  db.recordPoll([bus('EARLIER')], now - 16 * 60 * 1000);
  assert.deepEqual(db.getLatestLiveBuses(now), []);
  assert.equal(db.getAllFleetStatus(now)[0].status, 'stale');
  db.recordPoll([bus('LATER')], now + 1000);
  assert.deepEqual(db.getLatestLiveBuses(now), []);
  assert.equal(db.getAllFleetStatus(now).length, 1);
  assert.equal(db.getLatestPoll(now).records_count, 1);
  assert.throws(() => db.recordPoll([], Date.now() + 60000), /future/);
}));

test('a failed or duplicate batch rolls back all records and poll status', () => withDatabase(db => {
  const now = Date.now() - 1000;
  db.recordPoll([bus('EXISTING')], now - 1000);
  assert.throws(() => db.recordPoll([bus('NEW'), bus('NEW')], now), /UNIQUE/);
  assert.equal(db.getTotalSnapshotsCount(), 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM poll_batches').get().count, 1);
  assert.equal(db.getSetting('last_polled_at'), String(now - 1000));
  assert.deepEqual(db.getLatestLiveBuses(now).map(row => row.vehplate), ['EXISTING']);
  for (const invalid of [{ occupancy: NaN }, { speed: -1 }, { capacity: 0 }, { ridership: 1.5 }, { lat: 91 }, { crowd_level: 'unknown' }, { vehplate: ' ' }]) {
    assert.throws(() => db.recordPoll([bus('INVALID', invalid)], now));
  }
  assert.equal(db.getTotalSnapshotsCount(), 1);
}));

test('history and available dates use Singapore timestamps across UTC midnight', () => withDatabase(db => {
  const first = Date.parse('2026-01-01T15:59:00Z');
  const second = Date.parse('2026-01-01T16:02:00Z');
  const third = Date.parse('2026-01-03T16:02:00Z');
  db.recordPoll([bus('FIRST')], first);
  db.recordPoll([bus('SECOND', { time_str: '12:34', time_iso: 'invalid' })], second);
  db.recordPoll([bus('THIRD')], third);
  assert.deepEqual(db.getAvailableDates(), ['2026-01-04', '2026-01-02', '2026-01-01']);
  const rows = db.get24HourHistory(first, second).campusData;
  assert.deepEqual(rows.map(row => row.time_str), ['23:50', '00:00']);
  assert.equal(db.getExportRows().find(row => row.vehplate === 'SECOND').time_str, '00:02');
  const analytics = db.getHourlyAnalytics(first, second);
  assert.deepEqual(analytics.campusHourly.map(row => row.hour), [0, 23]);
  assert.equal(analytics.timezone, 'Asia/Singapore');
}));

test('analytics use measured samples only and unknown load never becomes a recommendation', () => withDatabase(db => {
  const timestamp = Date.parse('2026-01-01T00:20:00Z');
  db.recordPoll([bus('KNOWN', { occupancy: 0.6, ridership: 30 }), bus('UNKNOWN')], timestamp);
  const row = db.getHourlyAnalytics(timestamp, timestamp).campusHourly[0];
  assert.equal(row.hour, 8);
  assert.equal(row.avg_occupancy_pct, 60);
  assert.equal(row.avg_ridership, 30);
  assert.equal(row.sample_count, 2);
  assert.equal(row.occupancy_sample_count, 1);
  assert.equal(row.ridership_sample_count, 1);
  db.recordPoll([bus('UNKNOWN')], timestamp + 60 * 60 * 1000);
  const analytics = db.getHourlyAnalytics(timestamp, timestamp + 60 * 60 * 1000);
  assert.equal(analytics.campusHourly[1].avg_occupancy_pct, null);
  assert.equal(analytics.campusHourly[1].crowd_level, null);
  assert.deepEqual(analytics.bestWindows.map(item => item.hour), [8]);
  assert.deepEqual(analytics.busiestHours.map(item => item.hour), [8]);
  assert.equal(db.get24HourHistory(timestamp + 60 * 60 * 1000, timestamp + 60 * 60 * 1000).campusData[0].avg_ridership, null);
}));

test('default analytics cover seven days and all read paths exclude future timestamps', () => withDatabase(db => {
  const now = Date.now() - 1000;
  db.recordPoll([bus('OLDER')], now - 8 * 24 * 60 * 60 * 1000);
  db.recordPoll([bus('CURRENT')], now);
  db.recordPoll([bus('FUTURE')], now);
  db.db.prepare('UPDATE snapshots SET timestamp = ? WHERE vehplate = ?').run(Date.now() + 24 * 60 * 60 * 1000, 'FUTURE');
  const analytics = db.getHourlyAnalytics();
  assert.equal(analytics.campusHourly.reduce((total, row) => total + row.sample_count, 0), 1);
  assert.equal(analytics.queryRange.end - analytics.queryRange.start, 7 * 24 * 60 * 60 * 1000);
  assert.equal(db.getTotalSnapshotsCount(), 2);
  assert.deepEqual(db.getLatestLiveBuses(), []);
  assert.equal(db.getExportRows().length, 2);
  assert.equal(db.get24HourHistory(0, Date.now() + 2 * 24 * 60 * 60 * 1000).campusData.reduce((total, row) => total + row.sample_count, 0), 2);
  assert.ok(db.getAvailableDates().every(date => date <= new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)));
}));

test('clear is complete, settings survive, and reads start empty', () => withDatabase(db => {
  db.setSetting('fms_token', 'test-only-token');
  db.setSetting('temporary', 'value');
  assert.equal(db.deleteSetting('temporary'), 1);
  assert.equal(db.getSetting('temporary'), null);
  db.recordPoll([bus()], Date.now() - 1000);
  db.recordPoll([], Date.now());
  assert.equal(db.clearAllSnapshots(), 1);
  assert.equal(db.getLatestPoll(), null);
  assert.deepEqual(db.getLatestLiveBuses(), []);
  assert.deepEqual(db.getAllFleetStatus(), []);
  assert.deepEqual(db.getAvailableDates(), []);
  assert.equal(db.getSetting('last_polled_at'), '0');
  assert.equal(db.getSetting('fms_token'), 'test-only-token');
  assert.throws(() => db.getExportRows(-1), RangeError);
}));

test('observation rows retain the actual batch provider and coverage across provider changes', () => withDatabase(db => {
  const now = Date.now() - 1000;
  db.recordPoll([bus('COMMUNITY', { ridership: 0, capacity: 70 })], now - 2000, {
    dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN', 'KR-MRT'],
    sourceUrl: 'ignored-extra-metadata'
  });
  const community = db.getLatestLiveBuses(now - 2000)[0];
  assert.equal(community.source_provider, 'community');
  assert.equal(community.data_coverage, 'stop-arrivals');
  assert.deepEqual(JSON.parse(community.monitored_stops), ['KR-MRT', 'UTOWN']);
  assert.equal(community.lat, null);
  db.recordPoll([bus('DIRECT', { lat: 1.3, lng: 103.8 })], now - 1000);
  const direct = db.getLatestLiveBuses(now - 1000)[0];
  assert.equal(direct.source_provider, 'connectx');
  assert.equal(direct.data_coverage, 'route-fleet');
  assert.equal(direct.monitored_stops, '[]');
  const retained = db.getAllFleetStatus(now).find(row => row.vehplate === 'COMMUNITY');
  assert.equal(retained.source_provider, 'community');
  assert.equal(retained.status, 'inactive');
  const rows = db.getExportRows();
  assert.equal(rows.find(row => row.vehplate === 'COMMUNITY').data_coverage, 'stop-arrivals');
  assert.equal(rows.find(row => row.vehplate === 'DIRECT').data_coverage, 'route-fleet');
  db.recordPoll([bus('COMMUNITY', { lat: 1.31, lng: 103.81 })], now);
  assert.equal(db.getAllFleetStatus(now).find(row => row.vehplate === 'COMMUNITY').source_provider, 'connectx');
  assert.equal(db.getExportRows().filter(row => row.vehplate === 'COMMUNITY' && row.source_provider === 'community').length, 1);
}));

test('source summaries group equivalent stop coverage and include successful empty batches', () => withDatabase(db => {
  const now = Date.now() - 1000;
  const community = { dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN', 'KR-MRT'] };
  db.recordPoll([bus('DIRECT')], now - 3000);
  db.recordPoll([bus('COMMUNITY')], now - 2000, community);
  db.recordPoll([], now - 1000, { ...community, monitoredStops: ['KR-MRT', 'UTOWN', 'UTOWN'] });
  db.recordPoll([], now, { ...community, monitoredStops: ['UTOWN'] });
  const sources = db.getDataSources(now - 3000, now);
  assert.equal(sources.length, 3);
  const pair = sources.find(source => source.monitoredStops.length === 2);
  assert.deepEqual(pair, {
    dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['KR-MRT', 'UTOWN'],
    batchCount: 2, recordsCount: 1, firstObservedAt: now - 2000, lastObservedAt: now - 1000
  });
  assert.deepEqual(db.getDataSources(now, now), [{
    dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN'],
    batchCount: 1, recordsCount: 0, firstObservedAt: now, lastObservedAt: now
  }]);
  assert.equal(db.getLatestPoll(now).source_provider, 'community');
  assert.equal(db.getLatestPoll(now).records_count, 0);
  assert.deepEqual(db.getLatestLiveBuses(now), []);
  const future = Date.now() + 3600000;
  db.db.prepare('INSERT INTO poll_batches(timestamp, records_count) VALUES (?, ?)').run(future, 10);
  assert.equal(db.getDataSources(0, future).reduce((total, row) => total + row.batchCount, 0), 4);
  assert.throws(() => db.getDataSources(-1, now), TypeError);
}));

test('invalid provenance and failed insertions cannot publish a source or advance poll status', () => withDatabase(db => {
  const now = Date.now() - 1000;
  db.recordPoll([bus('EXISTING')], now - 1000);
  const invalid = [
    null, [], { dataProvider: 'untrusted' },
    { dataProvider: 'community', coverage: 'route-fleet', monitoredStops: ['UTOWN'] },
    { dataProvider: 'connectx', coverage: 'stop-arrivals' },
    { monitoredStops: ['UTOWN'] },
    { dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: [] },
    { dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['../UTOWN'] },
    { dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['utown'] },
    { dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['A', 'B', 'C', 'D', 'E', 'F'] },
    { dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: 'UTOWN' }
  ];
  for (const metadata of invalid) assert.throws(() => db.recordPoll([bus('REJECTED')], now, metadata), TypeError);
  assert.throws(() => db.recordPoll([bus('DUPLICATE'), bus('DUPLICATE')], now, {
    dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN']
  }), /UNIQUE/);
  assert.equal(db.getTotalSnapshotsCount(), 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM poll_batches').get().count, 1);
  assert.equal(db.getSetting('last_polled_at'), String(now - 1000));
  assert.deepEqual(db.getDataSources(now - 1000, now).map(source => source.dataProvider), ['connectx']);
}));

test('direct uNivUS provenance is supported without changing the default ConnectX source', () => withDatabase(db => {
  const now = Date.now() - 1000;
  db.recordPoll([bus('COMPATIBLE')], now - 1000);
  assert.equal(db.getLatestPoll().source_provider, 'connectx');
  db.recordPoll([bus('OFFICIAL', { occupancy: 0, ridership: 0 })], now, {
    dataProvider: 'univus', coverage: 'route-fleet', monitoredStops: []
  });
  const record = db.getLatestLiveBuses(now)[0];
  assert.equal(record.source_provider, 'univus');
  assert.equal(record.data_coverage, 'route-fleet');
  assert.equal(record.monitored_stops, '[]');
  assert.equal(db.getAllFleetStatus(now).find(row => row.vehplate === 'OFFICIAL').source_provider, 'univus');
  assert.equal(db.getExportRows()[0].source_provider, 'univus');
  assert.ok(db.getDataSources(now - 1000, now).some(source => source.dataProvider === 'univus'));
  for (const metadata of [
    { dataProvider: 'univus', coverage: 'stop-arrivals', monitoredStops: ['UTOWN'] },
    { dataProvider: 'univus', coverage: 'route-fleet', monitoredStops: ['UTOWN'] }
  ]) assert.throws(() => db.recordPoll([], now, metadata), TypeError);
  assert.throws(() => db.db.prepare(`INSERT INTO poll_batches(timestamp,records_count,source_provider,data_coverage)
    VALUES (?,0,'univus','stop-arrivals')`).run(now), /CHECK/);
}));

test('version-three upgrade preserves IDs, references, indexes, sequences, and collection status', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-tracker-v4-test-'));
  const dbPath = path.join(directory, 'version-three.db');
  let upgraded;
  try {
    const before = versionThreeFile(dbPath);
    upgraded = new BusDatabase(dbPath);
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.deepEqual(upgraded.db.prepare('SELECT * FROM poll_batches ORDER BY id').all(), before.batches);
    assert.deepEqual(upgraded.db.prepare('SELECT * FROM snapshots ORDER BY id').all(), before.snapshots);
    for (const setting of before.settings) assert.equal(upgraded.getSetting(setting.key), setting.value);
    assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(upgraded.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    const reference = upgraded.db.prepare('PRAGMA foreign_key_list(snapshots)').all()[0];
    assert.equal(reference.table, 'poll_batches');
    assert.equal(reference.on_delete, 'CASCADE');
    const indexes = upgraded.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all().map(row => row.name);
    for (const index of ['idx_poll_batches_time', 'custom_source_index', 'custom_vehicle_index']) assert.ok(indexes.includes(index), index);
    assert.equal(upgraded.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'poll_batches'").get().seq, before.pollSequence);
    assert.equal(upgraded.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'snapshots'").get().seq, before.snapshotSequence);
    assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS count FROM poll_events').get().count, 0);
    assert.throws(() => upgraded.db.prepare('UPDATE snapshots SET poll_batch_id = 999 WHERE id = 6').run(), /FOREIGN KEY/);
    const next = upgraded.recordPoll([bus('UNIVUS')], Date.now() - 1, { dataProvider: 'univus', coverage: 'route-fleet' });
    assert.equal(next.batchId, before.pollSequence + 1);
    assert.equal(upgraded.getLatestLiveBuses()[0].id, before.snapshotSequence + 1);
    assert.equal(upgraded.db.prepare('SELECT batch_id FROM poll_events').get().batch_id, next.batchId);
    upgraded.close();
    upgraded = new BusDatabase(dbPath);
    assert.equal(upgraded.getTotalSnapshotsCount(), 3);
    assert.equal(upgraded.getLatestPoll().source_provider, 'univus');
    assert.equal(upgraded.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    upgraded?.close();
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});

test('failed source migration rolls back the replacement table and original schema version', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-tracker-v4-rollback-test-'));
  const dbPath = path.join(directory, 'invalid-reference.db');
  let inspect;
  let upgraded;
  try {
    const before = versionThreeFile(dbPath, { orphan: true });
    assert.throws(() => new BusDatabase(dbPath), /foreign key references are invalid/);
    inspect = new DatabaseSync(dbPath);
    assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 3);
    assert.deepEqual(inspect.prepare('SELECT * FROM poll_batches ORDER BY id').all(), before.batches);
    assert.deepEqual(inspect.prepare('SELECT * FROM snapshots ORDER BY id').all(), before.snapshots);
    assert.deepEqual(inspect.prepare('SELECT * FROM settings ORDER BY key').all(), before.settings);
    assert.equal(inspect.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'poll_batches'").get().seq, before.pollSequence);
    assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'poll_batches_v4'").get().count, 0);
    assert.throws(() => inspect.prepare(`INSERT INTO poll_batches(timestamp,records_count,source_provider)
      VALUES (?,0,'univus')`).run(Date.now()), /CHECK/);
    // Remove only the deliberately invalid test row, then prove a retry works.
    inspect.exec("DELETE FROM snapshots WHERE vehplate = 'ORPHAN';");
    inspect.close();
    inspect = null;
    upgraded = new BusDatabase(dbPath);
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(upgraded.getTotalSnapshotsCount(), 2);
    assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    inspect?.close();
    upgraded?.close();
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});

test('version-two migration preserves existing batches and defaults their provenance to direct coverage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-tracker-provenance-test-'));
  const dbPath = path.join(directory, 'version-two.db');
  const now = Date.now() - 2000;
  let previous;
  let upgraded;
  try {
    previous = new DatabaseSync(dbPath);
    previous.exec(`
      CREATE TABLE poll_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, records_count INTEGER NOT NULL);
      CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, poll_batch_id INTEGER NOT NULL REFERENCES poll_batches(id),
        timestamp INTEGER NOT NULL, time_iso TEXT NOT NULL, time_str TEXT NOT NULL,
        route_code TEXT NOT NULL, vehplate TEXT NOT NULL, lat REAL, lng REAL, speed REAL,
        capacity INTEGER, crowd_level TEXT, occupancy REAL, ridership INTEGER, UNIQUE(poll_batch_id, vehplate)
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES ('fms_token', 'retained-test-token');
      PRAGMA user_version = 2;
    `);
    previous.prepare('INSERT INTO poll_batches(timestamp,records_count) VALUES (?,1),(?,0)').run(now, now + 1000);
    previous.prepare(`INSERT INTO snapshots(poll_batch_id,timestamp,time_iso,time_str,route_code,vehplate,ridership)
      VALUES (1,?,?,?,?,?,?)`).run(now, new Date(now).toISOString(), '00:00', 'A1', 'RETAINED', 0);
    previous.prepare('INSERT INTO settings VALUES (?,?)').run('last_polled_at', String(now + 1000));
    previous.close();
    previous = null;
    upgraded = new BusDatabase(dbPath);
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(upgraded.getTotalSnapshotsCount(), 1);
    assert.equal(upgraded.getLatestPoll().id, 2);
    assert.equal(upgraded.getLatestPoll().records_count, 0);
    assert.equal(upgraded.getLatestPoll().source_provider, 'connectx');
    assert.equal(upgraded.getExportRows()[0].ridership, 0);
    assert.equal(upgraded.getExportRows()[0].data_coverage, 'route-fleet');
    assert.equal(upgraded.getExportRows()[0].monitored_stops, '[]');
    assert.equal(upgraded.getSetting('last_polled_at'), String(now + 1000));
    assert.equal(upgraded.getSetting('fms_token'), 'retained-test-token');
    assert.equal(upgraded.getDataSources(now, now + 1000)[0].batchCount, 2);
    upgraded.recordPoll([bus('PUBLIC')], now + 1000, { dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN'] });
    upgraded.close();
    upgraded = new BusDatabase(dbPath);
    assert.equal(upgraded.getTotalSnapshotsCount(), 2);
    assert.equal(upgraded.getLatestPoll().source_provider, 'community');
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(upgraded.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    previous?.close();
    upgraded?.close();
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});

test('one-time migration keeps proven provider observations and removes obsolete data and schema', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-tracker-db-test-'));
  const dbPath = path.join(directory, 'legacy.db');
  let legacy;
  let upgraded;
  const timestamp = Date.parse('2026-01-01T16:02:00Z');
  try {
    legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, time_iso TEXT, time_str TEXT,
        route_code TEXT, vehplate TEXT, lat REAL, lng REAL, speed INTEGER, capacity INTEGER,
        crowd_level TEXT, occupancy REAL, ridership INTEGER, is_mock INTEGER DEFAULT 1
      );
      CREATE INDEX idx_snapshots_time ON snapshots(timestamp);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES ('mode', 'retired'), ('last_polled_at', '9999999999999'), ('fms_token', 'retained-test-token');
    `);
    const insert = legacy.prepare('INSERT INTO snapshots(timestamp,time_iso,time_str,route_code,vehplate,lat,lng,speed,capacity,crowd_level,occupancy,ridership,is_mock) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    insert.run(timestamp, 'wrong', '12:00', 'A1', 'GENERATED_ONLY_MARKER', 1.3, 103.8, 24, 70, 'high', 0.8, 56, 1);
    insert.run(timestamp, 'wrong', '12:00', 'A1', 'PROVIDER', 1.3, 103.8, 15, 90, 'high', 0.8, 71, 0);
    insert.run(timestamp, 'wrong', '12:00', 'A1', 'AMBIGUOUS', 1.3, 103.8, 0, 70, 'low', 0, 0, 0);
    insert.run(timestamp, 'wrong', '12:00', 'A1', 'DERIVED', 1.3, 103.8, 0, 70, 'medium', 0.5, 35, 0);
    insert.run(timestamp, 'wrong', '12:00', 'A1', 'DERIVED-LARGER-CAPACITY', 1.3, 103.8, 15, 90, 'high', 0.8, 72, 0);
    insert.run(timestamp, 'wrong', '12:00', 'A1', 'PC-UNKNOWN', 1.3, 103.8, 0, 70, 'low', 0, 0, 0);
    insert.run(Date.now() + 60000, 'wrong', '12:00', 'A1', 'FUTURE', 1.3, 103.8, 15, 90, 'high', 0.8, 72, 0);
    legacy.close();
    legacy = null;

    upgraded = new BusDatabase(dbPath);
    assert.equal(upgraded.getTotalSnapshotsCount(), 4);
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.ok(upgraded.db.prepare('PRAGMA table_info(snapshots)').all().every(column => column.name !== 'is_mock'));
    assert.equal(upgraded.getSetting('mode'), null);
    assert.equal(upgraded.getSetting('fms_token'), 'retained-test-token');
    assert.equal(upgraded.getSetting('last_polled_at'), String(timestamp));
    const rows = upgraded.getExportRows();
    const provider = rows.find(row => row.vehplate === 'PROVIDER');
    assert.equal(provider.source_provider, 'connectx');
    assert.equal(provider.data_coverage, 'route-fleet');
    assert.equal(provider.monitored_stops, '[]');
    assert.equal(provider.capacity, 90);
    assert.equal(provider.occupancy, 0.8);
    assert.equal(provider.ridership, 71);
    assert.equal(provider.time_str, '00:02');
    assert.equal(provider.time_iso, new Date(timestamp).toISOString());
    const ambiguous = rows.find(row => row.vehplate === 'AMBIGUOUS');
    for (const field of ['speed', 'capacity', 'occupancy', 'ridership', 'crowd_level']) assert.equal(ambiguous[field], null, field);
    assert.equal(rows.find(row => row.vehplate === 'DERIVED').ridership, null);
    assert.equal(rows.find(row => row.vehplate === 'DERIVED-LARGER-CAPACITY').ridership, null);
    assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS count FROM poll_batches').get().count, 1);
    upgraded.close();
    upgraded = null;
    assert.equal(fs.readFileSync(dbPath).includes(Buffer.from('GENERATED_ONLY_MARKER')), false);

    upgraded = new BusDatabase(dbPath);
    assert.equal(upgraded.getTotalSnapshotsCount(), 4);
    assert.equal(upgraded.getSetting('fms_token'), 'retained-test-token');
    assert.equal(upgraded.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    legacy?.close();
    upgraded?.close();
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});
