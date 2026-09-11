import assert from 'node:assert/strict';
import test from 'node:test';
import './no_provider_network.js';
import { fetchPublicObservations } from '../src/public_feed.js';

const NOW = Date.parse('2026-09-11T00:05:00+08:00');
const timestamp = offset => new Date(NOW + offset).toISOString();
function feed(stop, timings = [], overrides = {}) {
  return {
    degraded: false,
    etas: { busStopName: stop, lastUpdated: timestamp(-1000), timings },
    ...overrides
  };
}
function timing(name, plate, capacity, ridership) {
  return { name, arrivalTime_veh_plate: plate, arrivalTime_capacity: capacity, arrivalTime_ridership: ridership };
}
function fixture(payloads, options = {}) {
  const requests = [];
  const fetchImpl = async (url, requestOptions) => {
    requests.push({ url: String(url), options: requestOptions });
    const stop = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    const payload = payloads[stop];
    if (payload instanceof Error) throw payload;
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  return { requests, collect: () => fetchPublicObservations({ now: () => NOW, fetchImpl, ...options }) };
}

test('public arrivals preserve zero and unknown readings without supplying invented GPS or speed', async () => {
  const { collect, requests } = fixture({
    UTOWN: feed('UTOWN', [{
      ...timing('A1', ' pc-test1 ', 70, 0),
      arrivalTime_ts: timestamp(3 * 3600000),
      nextArrivalTime_veh_plate: 'PC-TEST2', nextArrivalTime_capacity: null, nextArrivalTime_ridership: null
    }]),
    'KR-MRT': feed('KR-MRT', [timing('A2', 'PC-TEST3', '70', '35')])
  });
  const records = await collect();
  assert.equal(records.length, 3);
  assert.equal(requests.length, 2);
  const zero = records.find(record => record.vehplate === 'PC-TEST1');
  assert.equal(zero.ridership, 0);
  assert.equal(zero.occupancy, 0);
  assert.equal(zero.crowd_level, 'low');
  const unknown = records.find(record => record.vehplate === 'PC-TEST2');
  for (const key of ['capacity', 'ridership', 'occupancy', 'crowd_level']) assert.equal(unknown[key], null);
  assert.equal(records.find(record => record.vehplate === 'PC-TEST3').occupancy, 0.5);
  for (const record of records) {
    assert.equal(record.timestamp, NOW, 'Predicted arrival time is not used as observation time');
    assert.equal(record.time_str, '00:05');
    for (const key of ['lat', 'lng', 'speed']) assert.equal(record[key], null);
  }
});

test('public stop requests run concurrently without authentication and deduplicate monitored stops', async () => {
  const pending = [];
  const request = fetchPublicObservations({
    now: () => NOW, stops: ['UTOWN', 'KR-MRT', 'UTOWN'],
    fetchImpl: async (url, options) => new Promise(resolve => { pending.push({ url: String(url), options, resolve }); })
  });
  assert.equal(pending.length, 2, 'Both distinct stop requests begin before either resolves');
  for (const { url, options, resolve } of pending) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://bus.hewliyang.com');
    assert.equal(parsed.search, '');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.body, undefined);
    const stop = parsed.pathname.split('/').at(-1);
    resolve(new Response(JSON.stringify(feed(stop))));
  }
  assert.deepEqual(await request, []);
});

test('duplicates prefer complete measurements, then newer complete reports, without combining fields', async () => {
  const older = feed('UTOWN', [
    timing('A1', 'COMPLETE', 70, 20), timing('A1', 'NEWEST', 70, 10), timing('A1', 'PARTIAL', 70, null)
  ]);
  older.etas.lastUpdated = timestamp(-60000);
  const newer = feed('KR-MRT', [
    timing('A1', ' complete ', null, null), timing('A1', 'NEWEST', 80, 40), timing('A1', 'PARTIAL', null, 15)
  ]);
  const { collect } = fixture({ UTOWN: older, 'KR-MRT': newer });
  const records = await collect();
  assert.equal(records.length, 3);
  const complete = records.find(record => record.vehplate === 'COMPLETE');
  assert.equal(complete.capacity, 70);
  assert.equal(complete.ridership, 20);
  const newest = records.find(record => record.vehplate === 'NEWEST');
  assert.equal(newest.capacity, 80);
  assert.equal(newest.ridership, 40);
  const partial = records.find(record => record.vehplate === 'PARTIAL');
  assert.equal(partial.capacity, null);
  assert.equal(partial.ridership, 15);
  assert.equal(partial.occupancy, null, 'Readings from distinct reports must not be merged into a ratio');
});

test('conflicting route assignments are dropped and records stay within configured routes', async () => {
  const { collect } = fixture({
    UTOWN: feed('UTOWN', [timing('A1', 'KEEP', 70, 0), timing('R1', 'AMBIGUOUS', 70, 30), timing('A1', 'EXCLUDED-CONFLICT', 70, 30)]),
    'KR-MRT': feed('KR-MRT', [timing('R2', 'ambiguous', 70, 20), timing('E', 'EXCLUDED', 70, 10), timing('E', 'EXCLUDED-CONFLICT', 70, 10)])
  }, { routes: ['A1', 'R1', 'R2'] });
  const records = await collect();
  assert.deepEqual(records.map(record => record.vehplate), ['KEEP']);
});

test('missing vehicle slots and fresh empty arrival lists do not invent buses', async () => {
  const { collect } = fixture({
    UTOWN: feed('UTOWN', [{ name: 'A1' }, timing('A2', null, null, null), timing('D1', '   ', 70, 20)]),
    'KR-MRT': feed('KR-MRT')
  });
  assert.deepEqual(await collect(), []);
});

test('invalid stop or route configuration fails before any network request', async () => {
  for (const stops of [[], ['utown'], ['../UTOWN'], ['UTOWN?x=1'], ['A'.repeat(21)], ['A', 'B', 'C', 'D', 'E', 'F'], null]) {
    const { collect, requests } = fixture({}, { stops });
    await assert.rejects(collect(), error => error.code === 'invalid_configuration');
    assert.equal(requests.length, 0);
  }
  for (const routes of [[], ['a1'], ['A1/../A2'], null]) {
    const { collect, requests } = fixture({}, { routes });
    await assert.rejects(collect(), error => error.code === 'invalid_configuration');
    assert.equal(requests.length, 0);
  }
});

test('missing, stale, invalid, future, and timezone-free timestamps reject the entire poll', async () => {
  for (const lastUpdated of [undefined, null, 'invalid', timestamp(-120001), timestamp(60001), '2026-09-11T00:05:00']) {
    const payload = feed('UTOWN');
    payload.etas.lastUpdated = lastUpdated;
    const { collect } = fixture({ UTOWN: payload, 'KR-MRT': feed('KR-MRT', [timing('A1', 'VALID', 70, 10)]) });
    await assert.rejects(collect(), error => error.code === 'stale_response');
  }
});

test('unknown health or degraded data is rejected even when timings are present', async () => {
  for (const degraded of [true, undefined, null, 0, 'false']) {
    const { collect } = fixture({
      UTOWN: feed('UTOWN', [timing('A1', 'VALID', 70, 10)], { degraded }),
      'KR-MRT': feed('KR-MRT')
    });
    await assert.rejects(collect(), error => error.code === 'degraded_response');
  }
});

test('malformed responses, wrong stops, and invalid route or vehicle shapes fail closed', async () => {
  const payloads = [
    null, [], { degraded: false }, feed('WRONG'),
    { degraded: false, etas: { busStopName: 'UTOWN', lastUpdated: timestamp(0), timings: {} } },
    feed('UTOWN', [null]), feed('UTOWN', [[]]), feed('UTOWN', [{ name: null }]),
    feed('UTOWN', [timing('invalid route', 'PLATE', 70, 1)]),
    feed('UTOWN', [timing('A1', 1234, 70, 1)]),
    feed('UTOWN', [timing('A1', 'PLATE', {}, 1)])
  ];
  for (const payload of payloads) {
    const { collect } = fixture({ UTOWN: payload, 'KR-MRT': feed('KR-MRT') });
    await assert.rejects(collect(), error => error.code === 'invalid_response');
  }
});

test('one failed stop discards an otherwise valid poll without leaking response bodies', async () => {
  const privateBody = 'untrusted response body';
  for (const badResponse of [new Response(privateBody, { status: 503 }), new Response('{invalid JSON'), new Error(privateBody)]) {
    const { collect, requests } = fixture({
      UTOWN: feed('UTOWN', [timing('A1', 'VALID', 70, 10)]), 'KR-MRT': badResponse
    });
    await assert.rejects(collect(), error => !error.message.includes(privateBody));
    assert.equal(requests.length, 2);
  }
});
