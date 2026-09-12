import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestDatabase } from './database_fixture.js';

function bus(vehplate = 'OBSERVED1', extra = {}) {
  return { route_code: 'A1', vehplate, ...extra };
}

test('missing provider fields remain unknown and measured zero is preserved', async t => {
  const db = createTestDatabase(t);
  const now = Date.now() - 1000;
  await db.recordPoll([bus(), bus('OBSERVED2', { speed: 0, occupancy: 0, ridership: 0, lat: 0, lng: 0 })], now);
  const [unknown, zero] = await db.getLatestLiveBuses(now);
  for (const field of ['lat', 'lng', 'speed', 'capacity', 'crowd_level', 'occupancy', 'ridership']) assert.equal(unknown[field], null, field);
  for (const field of ['lat', 'lng', 'speed', 'occupancy', 'ridership']) assert.equal(zero[field], 0, field);
  assert.equal(db.storage.type, 'turso');
  assert.equal(db.storage.persistent, true);
});

test('latest successful batch defines active fleet and an empty poll clears it', async t => {
  const db = createTestDatabase(t);
  const now = Date.now() - 1000;
  await db.recordPoll([bus('OBSERVED1', { lat: 1.3, lng: 103.8, speed: 18 }), bus('OBSERVED2')], now - 1000);
  await db.recordPoll([bus('OBSERVED2', { route_code: 'D1' })], now);
  assert.deepEqual((await db.getLatestLiveBuses(now)).map(row => row.vehplate), ['OBSERVED2']);
  const fleet = await db.getAllFleetStatus(now);
  assert.equal(fleet.length, 2);
  assert.equal(fleet[0].status, 'inactive');
  assert.equal(fleet[0].lat, 1.3);
  assert.equal(fleet[0].speed, 18);
  assert.equal(fleet[0].last_seen_at, now - 1000);
  assert.equal(fleet[0].location_name, undefined);
  assert.equal(fleet[1].status, 'active');
  assert.equal(fleet[1].route_code, 'D1');
  await db.recordPoll([], now);
  assert.deepEqual(await db.getLatestLiveBuses(now), []);
  assert.ok((await db.getAllFleetStatus(now)).every(row => row.status === 'inactive'));
  assert.equal((await db.getLatestPoll(now)).records_count, 0);
  assert.equal(await db.getSetting('last_polled_at'), String(now));
});

test('stale observations stay historical and future batches never leak into results', async t => {
  const db = createTestDatabase(t);
  const now = Date.now() - 2000;
  await db.recordPoll([bus('EARLIER')], now - 16 * 60 * 1000);
  assert.deepEqual(await db.getLatestLiveBuses(now), []);
  assert.equal((await db.getAllFleetStatus(now))[0].status, 'stale');
  await db.recordPoll([bus('LATER')], now + 1000);
  assert.deepEqual(await db.getLatestLiveBuses(now), []);
  assert.equal((await db.getAllFleetStatus(now)).length, 1);
  assert.equal((await db.getLatestPoll(now)).records_count, 1);
  await assert.rejects(() => db.recordPoll([], Date.now() + 60000), /future/);
});

test('a failed or duplicate batch rolls back all records and poll status', async t => {
  const db = createTestDatabase(t);
  const now = Date.now() - 1000;
  await db.recordPoll([bus('EXISTING')], now - 1000);
  await assert.rejects(() => db.recordPoll([bus('NEW'), bus('NEW')], now), /UNIQUE/);
  assert.equal(await db.getTotalSnapshotsCount(), 1);
  assert.equal((await db.client.execute('SELECT COUNT(*) AS count FROM poll_batches')).rows[0].count, 1);
  assert.equal(await db.getSetting('last_polled_at'), String(now - 1000));
  assert.deepEqual((await db.getLatestLiveBuses(now)).map(row => row.vehplate), ['EXISTING']);
  for (const invalid of [{ occupancy: NaN }, { speed: -1 }, { capacity: 0 }, { ridership: 1.5 }, { lat: 91 }, { crowd_level: 'unknown' }, { vehplate: ' ' }]) {
    await assert.rejects(() => db.recordPoll([bus('INVALID', invalid)], now));
  }
  assert.equal(await db.getTotalSnapshotsCount(), 1);
});

test('history and available dates use Singapore timestamps across UTC midnight', async t => {
  const db = createTestDatabase(t);
  const first = Date.parse('2026-01-01T15:59:00Z');
  const second = Date.parse('2026-01-01T16:02:00Z');
  const third = Date.parse('2026-01-03T16:02:00Z');
  await db.recordPoll([bus('FIRST')], first);
  await db.recordPoll([bus('SECOND', { time_str: '12:34', time_iso: 'invalid' })], second);
  await db.recordPoll([bus('THIRD')], third);
  assert.deepEqual(await db.getAvailableDates(), ['2026-01-04', '2026-01-02', '2026-01-01']);
  const rows = (await db.get24HourHistory(first, second)).campusData;
  assert.deepEqual(rows.map(row => row.time_str), ['23:50', '00:00']);
  assert.equal((await db.getExportRows()).find(row => row.vehplate === 'SECOND').time_str, '00:02');
  const analytics = await db.getHourlyAnalytics(first, second);
  assert.deepEqual(analytics.campusHourly.map(row => row.hour), [0, 23]);
  assert.equal(analytics.timezone, 'Asia/Singapore');
});

test('analytics use measured samples only and unknown load never becomes a recommendation', async t => {
  const db = createTestDatabase(t);
  const timestamp = Date.parse('2026-01-01T00:20:00Z');
  await db.recordPoll([bus('KNOWN', { occupancy: 0.6, ridership: 30 }), bus('UNKNOWN')], timestamp);
  const row = (await db.getHourlyAnalytics(timestamp, timestamp)).campusHourly[0];
  assert.equal(row.hour, 8);
  assert.equal(row.avg_occupancy_pct, 60);
  assert.equal(row.avg_ridership, 30);
  assert.equal(row.sample_count, 2);
  assert.equal(row.occupancy_sample_count, 1);
  assert.equal(row.ridership_sample_count, 1);
  await db.recordPoll([bus('UNKNOWN')], timestamp + 60 * 60 * 1000);
  const analytics = await db.getHourlyAnalytics(timestamp, timestamp + 60 * 60 * 1000);
  assert.equal(analytics.campusHourly[1].avg_occupancy_pct, null);
  assert.equal(analytics.campusHourly[1].crowd_level, null);
  assert.deepEqual(analytics.bestWindows.map(item => item.hour), [8]);
  assert.deepEqual(analytics.busiestHours.map(item => item.hour), [8]);
  assert.equal((await db.get24HourHistory(timestamp + 60 * 60 * 1000, timestamp + 60 * 60 * 1000)).campusData[0].avg_ridership, null);
});

test('default analytics cover seven days and all read paths exclude future timestamps', async t => {
  const db = createTestDatabase(t);
  const now = Date.now() - 1000;
  await db.recordPoll([bus('OLDER')], now - 8 * 24 * 60 * 60 * 1000);
  await db.recordPoll([bus('CURRENT')], now);
  await db.recordPoll([bus('FUTURE')], now);
  await db.client.execute({
    sql: 'UPDATE snapshots SET timestamp = ? WHERE vehplate = ?',
    args: [Date.now() + 24 * 60 * 60 * 1000, 'FUTURE']
  });
  const analytics = await db.getHourlyAnalytics();
  assert.equal(analytics.campusHourly.reduce((total, row) => total + row.sample_count, 0), 1);
  assert.equal(analytics.queryRange.end - analytics.queryRange.start, 7 * 24 * 60 * 60 * 1000);
  assert.equal(await db.getTotalSnapshotsCount(), 2);
  assert.deepEqual(await db.getLatestLiveBuses(), []);
  assert.equal((await db.getExportRows()).length, 2);
  assert.equal((await db.get24HourHistory(0, Date.now() + 2 * 24 * 60 * 60 * 1000)).campusData.reduce((total, row) => total + row.sample_count, 0), 2);
  assert.ok((await db.getAvailableDates()).every(date => date <= new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)));
});

test('clear is complete, settings survive, and reads start empty', async t => {
  const db = createTestDatabase(t);
  await db.setSetting('app_setting', 'test-only-value');
  await db.setSetting('temporary', 'value');
  assert.equal(await db.deleteSetting('temporary'), 1);
  assert.equal(await db.getSetting('temporary'), null);
  await db.recordPoll([bus()], Date.now() - 1000);
  await db.recordPoll([], Date.now());
  assert.equal(await db.clearAllSnapshots(), 1);
  assert.equal(await db.getLatestPoll(), null);
  assert.deepEqual(await db.getLatestLiveBuses(), []);
  assert.deepEqual(await db.getAllFleetStatus(), []);
  assert.deepEqual(await db.getAvailableDates(), []);
  assert.equal(await db.getSetting('last_polled_at'), '0');
  assert.equal(await db.getSetting('app_setting'), 'test-only-value');
  await assert.rejects(() => db.getExportRows(-1), RangeError);
});

test('observation rows retain the actual batch provider and coverage across provider changes', async t => {
  const db = createTestDatabase(t);
  const now = Date.now() - 1000;
  await db.recordPoll([bus('COMMUNITY', { ridership: 0, capacity: 70 })], now - 2000, {
    dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN', 'KR-MRT'],
    sourceUrl: 'ignored-extra-metadata'
  });
  const community = (await db.getLatestLiveBuses(now - 2000))[0];
  assert.equal(community.source_provider, 'community');
  assert.equal(community.data_coverage, 'stop-arrivals');
  assert.deepEqual(JSON.parse(community.monitored_stops), ['KR-MRT', 'UTOWN']);
  assert.equal(community.lat, null);
  await db.recordPoll([bus('DIRECT', { lat: 1.3, lng: 103.8 })], now - 1000);
  const direct = (await db.getLatestLiveBuses(now - 1000))[0];
  assert.equal(direct.source_provider, 'connectx');
  assert.equal(direct.data_coverage, 'route-fleet');
  assert.equal(direct.monitored_stops, '[]');
  const retained = (await db.getAllFleetStatus(now)).find(row => row.vehplate === 'COMMUNITY');
  assert.equal(retained.source_provider, 'community');
  assert.equal(retained.status, 'inactive');
  const rows = await db.getExportRows();
  assert.equal(rows.find(row => row.vehplate === 'COMMUNITY').data_coverage, 'stop-arrivals');
  assert.equal(rows.find(row => row.vehplate === 'DIRECT').data_coverage, 'route-fleet');
  await db.recordPoll([bus('COMMUNITY', { lat: 1.31, lng: 103.81 })], now);
  assert.equal((await db.getAllFleetStatus(now)).find(row => row.vehplate === 'COMMUNITY').source_provider, 'connectx');
  assert.equal((await db.getExportRows()).filter(row => row.vehplate === 'COMMUNITY' && row.source_provider === 'community').length, 1);
});

test('source summaries group equivalent stop coverage and include successful empty batches', async t => {
  const db = createTestDatabase(t);
  const now = Date.now() - 1000;
  const community = { dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN', 'KR-MRT'] };
  await db.recordPoll([bus('DIRECT')], now - 3000);
  await db.recordPoll([bus('COMMUNITY')], now - 2000, community);
  await db.recordPoll([], now - 1000, { ...community, monitoredStops: ['KR-MRT', 'UTOWN', 'UTOWN'] });
  await db.recordPoll([], now, { ...community, monitoredStops: ['UTOWN'] });
  const sources = await db.getDataSources(now - 3000, now);
  assert.equal(sources.length, 3);
  const pair = sources.find(source => source.monitoredStops.length === 2);
  assert.deepEqual(pair, {
    dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['KR-MRT', 'UTOWN'],
    batchCount: 2, recordsCount: 1, firstObservedAt: now - 2000, lastObservedAt: now - 1000
  });
  assert.deepEqual(await db.getDataSources(now, now), [{
    dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN'],
    batchCount: 1, recordsCount: 0, firstObservedAt: now, lastObservedAt: now
  }]);
  assert.equal((await db.getLatestPoll(now)).source_provider, 'community');
  assert.equal((await db.getLatestPoll(now)).records_count, 0);
  assert.deepEqual(await db.getLatestLiveBuses(now), []);
  const future = Date.now() + 3600000;
  await db.client.execute({ sql: 'INSERT INTO poll_batches(timestamp, records_count) VALUES (?, ?)', args: [future, 10] });
  assert.equal((await db.getDataSources(0, future)).reduce((total, row) => total + row.batchCount, 0), 4);
  await assert.rejects(() => db.getDataSources(-1, now), TypeError);
});

test('invalid provenance and failed insertions cannot publish a source or advance poll status', async t => {
  const db = createTestDatabase(t);
  const now = Date.now() - 1000;
  await db.recordPoll([bus('EXISTING')], now - 1000);
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
  for (const metadata of invalid) await assert.rejects(() => db.recordPoll([bus('REJECTED')], now, metadata), TypeError);
  await assert.rejects(() => db.recordPoll([bus('DUPLICATE'), bus('DUPLICATE')], now, {
    dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN']
  }), /UNIQUE/);
  assert.equal(await db.getTotalSnapshotsCount(), 1);
  assert.equal((await db.client.execute('SELECT COUNT(*) AS count FROM poll_batches')).rows[0].count, 1);
  assert.equal(await db.getSetting('last_polled_at'), String(now - 1000));
  assert.deepEqual((await db.getDataSources(now - 1000, now)).map(source => source.dataProvider), ['connectx']);
});

test('direct uNivUS provenance is supported without changing the default ConnectX source', async t => {
  const db = createTestDatabase(t);
  const now = Date.now() - 1000;
  await db.recordPoll([bus('COMPATIBLE')], now - 1000);
  assert.equal((await db.getLatestPoll()).source_provider, 'connectx');
  await db.recordPoll([bus('OFFICIAL', { occupancy: 0, ridership: 0 })], now, {
    dataProvider: 'univus', coverage: 'route-fleet', monitoredStops: []
  });
  const record = (await db.getLatestLiveBuses(now))[0];
  assert.equal(record.source_provider, 'univus');
  assert.equal(record.data_coverage, 'route-fleet');
  assert.equal(record.monitored_stops, '[]');
  assert.equal((await db.getAllFleetStatus(now)).find(row => row.vehplate === 'OFFICIAL').source_provider, 'univus');
  assert.equal((await db.getExportRows())[0].source_provider, 'univus');
  assert.ok((await db.getDataSources(now - 1000, now)).some(source => source.dataProvider === 'univus'));
  for (const metadata of [
    { dataProvider: 'univus', coverage: 'stop-arrivals', monitoredStops: ['UTOWN'] },
    { dataProvider: 'univus', coverage: 'route-fleet', monitoredStops: ['UTOWN'] }
  ]) await assert.rejects(() => db.recordPoll([], now, metadata), TypeError);
  await assert.rejects(db.client.execute({
    sql: `INSERT INTO poll_batches(timestamp,records_count,source_provider,data_coverage) VALUES (?,0,'univus','stop-arrivals')`,
    args: [now]
  }), /CHECK/);
});
