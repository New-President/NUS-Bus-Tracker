import assert from 'node:assert/strict';
import test from 'node:test';
import './no_provider_network.js';

for (const key of ['FMS_TOKEN', 'ADMIN_TOKEN', 'CRON_SECRET']) delete process.env[key];

const { fetchLiveRouteBuses, fetchAllLiveBuses, normalizeBus, ProviderError } = await import('../src/api_client.js');
const { BusCollector } = await import('../src/collector.js');
import { createTestDatabase } from './database_fixture.js';
const NOW = Date.parse('2026-09-10T16:05:00Z');
const TOKEN = 'private-provider-test-token';

function guestProvider(token = 'guest-provider-test-token') {
  return {
    async getToken() { return token; },
    invalidate() {},
    getStatus() { return { tokenSource: 'guest', tokenExpiresAt: null }; }
  };
}

function response(buses = []) {
  return new Response(JSON.stringify({ ActiveBusResult: { activebus: buses } }), { status: 200 });
}

test('provider client rejects missing credentials before network access', async () => {
  let called = false;
  await assert.rejects(fetchLiveRouteBuses('A1', '', {
    fetchImpl: async () => { called = true; return response(); }
  }), /token/i);
  assert.equal(called, false);
});

test('provider request sends the requested route and accepts an empty reported fleet', async () => {
  const records = await fetchLiveRouteBuses('A1', TOKEN, {
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('route_code'), 'A1');
      assert.equal(parsed.searchParams.get('token'), TOKEN);
      assert.ok(options.signal, 'Each request must have a timeout signal');
      return response();
    }
  });
  assert.deepEqual(records, []);
});

test('provider errors and malformed payloads cannot become successful empty polls', async () => {
  for (const createResponse of [
    () => new Response(TOKEN, { status: 401 }),
    () => new Response('{broken json', { status: 200 }),
    () => new Response(JSON.stringify({ error: TOKEN }), { status: 200 }),
    () => new Response(JSON.stringify({ ActiveBusResult: { activebus: {} } }), { status: 200 })
  ]) {
    await assert.rejects(fetchLiveRouteBuses('A1', TOKEN, {
      fetchImpl: async () => createResponse()
    }), error => {
      assert.equal(error.message.includes(TOKEN), false, 'Credentials must not appear in provider errors');
      return true;
    });
  }
});

test('provider rejects application-level errors even when HTTP status is successful', async () => {
  await assert.rejects(fetchLiveRouteBuses('A1', TOKEN, {
    fetchImpl: async () => new Response(JSON.stringify({ result: false, error: 4 }), { status: 200 })
  }), error => error.code === 'provider_response_error' && !error.message.includes(TOKEN));
});

test('provider rejects stale, invalid, or future feed timestamps before accepting fleet readings', async () => {
  for (const field of ['TimeStamp', 'Timestamp']) {
    for (const timestamp of [new Date(NOW - 16 * 60 * 1000).toISOString(), new Date(NOW + 61000).toISOString(), 'invalid']) {
      await assert.rejects(fetchLiveRouteBuses('A1', TOKEN, {
        now: () => NOW,
        fetchImpl: async () => new Response(JSON.stringify({ ActiveBusResult: { [field]: timestamp, activebus: [] } }))
      }), error => error.code === 'stale_response');
    }
    const fresh = await fetchLiveRouteBuses('A1', TOKEN, {
      now: () => NOW,
      fetchImpl: async () => new Response(JSON.stringify({ ActiveBusResult: {
        [field]: '2026-09-11T00:05:00+08:00', activebus: []
      } }))
    });
    assert.deepEqual(fresh, []);
  }
});

test('provider request timeout aborts the underlying fetch', async () => {
  let signal;
  await assert.rejects(fetchLiveRouteBuses('A1', TOKEN, {
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(response()), 100);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Request aborted', 'AbortError'));
        }, { once: true });
      });
    }
  }));
  assert.equal(signal.aborted, true);
});

test('normalization retains unknown telemetry and legitimate zero readings', () => {
  const unknown = normalizeBus({ vehplate: 'TEST-UNKNOWN' }, 'A1', NOW);
  for (const key of ['occupancy', 'ridership', 'capacity', 'speed', 'lat', 'lng']) {
    assert.equal(unknown[key], null, `Missing ${key} must remain unknown`);
  }
  assert.equal(unknown.crowd_level, null);
  const zero = normalizeBus({
    vehplate: 'TEST-ZERO', lat: 0, lng: 0, speed: 0,
    loadInfo: { capacity: 70, occupancy: 0, ridership: 0 }
  }, 'A1', NOW);
  assert.equal(zero.lat, 0);
  assert.equal(zero.lng, 0);
  assert.equal(zero.occupancy, 0);
  assert.equal(zero.ridership, 0);
  assert.equal(zero.crowd_level, 'low');
  assert.equal(zero.time_str, '00:05', 'Display time must be Singapore time regardless of host zone');
});

test('normalization rejects invalid load numbers without inventing empty buses', () => {
  const bus = normalizeBus({
    vehplate: 'TEST-INVALID', lat: 999, lng: -999, speed: -2,
    loadInfo: { capacity: -1, occupancy: -0.5, ridership: -7 }
  }, 'A1', NOW);
  for (const key of ['occupancy', 'ridership', 'capacity', 'speed', 'lat', 'lng']) {
    assert.equal(bus[key], null, `Invalid ${key} must remain unknown`);
  }
});

test('all-route collection deduplicates vehicle plates and propagates route failures', async () => {
  const records = await fetchAllLiveBuses(TOKEN, {
    routes: ['A1', 'A2'], now: () => NOW,
    fetchRoute: async () => [{ vehplate: 'TEST-DUPLICATE', loadInfo: { occupancy: 0.5 } }]
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].timestamp, NOW);
  await assert.rejects(fetchAllLiveBuses(TOKEN, {
    routes: ['A1', 'A2'], now: () => NOW,
    fetchRoute: async route => {
      if (route === 'A2') throw new Error('Provider unavailable');
      return [{ vehplate: 'TEST-PARTIAL' }];
    }
  }));
});

test('guest authentication failure reports an error and writes no observations', async t => {
  const db = createTestDatabase(t);
  let calls = 0;
  const tokenProvider = guestProvider();
  tokenProvider.getToken = async () => { throw new ProviderError('Guest authentication unavailable'); };
  const collector = new BusCollector(db, {
    now: () => NOW, env: { BUS_PROVIDER: 'connectx' }, tokenProvider, fetchBuses: async () => { calls++; return []; }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 502);
  assert.equal(calls, 0);
  assert.equal(await db.getTotalSnapshotsCount(), 0);
  assert.equal((await collector.getStatus()).lastPolledAt, 0);
});

test('collector obtains a guest token and collects without manual credentials', async t => {
  const db = createTestDatabase(t);
  let receivedToken;
  const collector = new BusCollector(db, {
    now: () => NOW, env: { BUS_PROVIDER: 'connectx' }, tokenProvider: guestProvider(),
    fetchBuses: async token => {
      receivedToken = token;
      return [normalizeBus({ vehplate: 'TEST-GUEST' }, 'A1', NOW)];
    }
  });
  const before = await collector.getStatus();
  assert.equal(before.authMode, 'guest');
  assert.equal(before.tokenSource, 'guest');
  assert.equal(before.requiresToken, false);
  assert.equal(before.canPoll, true);
  const result = await collector.pollNow();
  assert.equal(result.success, true);
  assert.equal(receivedToken, 'guest-provider-test-token');
  assert.equal(await db.getTotalSnapshotsCount(), 1);
  assert.equal((await collector.getStatus()).connectionState, 'healthy');
  assert.equal(JSON.stringify(await collector.getStatus()).includes(receivedToken), false);
});

test('an expired guest session is renewed once before storing a successful collection', async t => {
  const db = createTestDatabase(t);
  let issued = 0;
  let invalidations = 0;
  const tokensUsed = [];
  const tokenProvider = guestProvider();
  tokenProvider.getToken = async () => `guest-session-${++issued}`;
  tokenProvider.invalidate = () => { invalidations++; };
  const collector = new BusCollector(db, {
    now: () => NOW, env: { BUS_PROVIDER: 'connectx' }, tokenProvider,
    fetchBuses: async token => {
      tokensUsed.push(token);
      if (tokensUsed.length === 1) throw new ProviderError('Session expired', { httpStatus: 401 });
      return [normalizeBus({ vehplate: 'TEST-RENEWED' }, 'A1', NOW)];
    }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, true);
  assert.deepEqual(tokensUsed, ['guest-session-1', 'guest-session-2']);
  assert.equal(invalidations, 1);
  assert.equal(await db.getTotalSnapshotsCount(), 1);
});

test('repeated guest authorization failures stop after one renewal without storing observations', async t => {
  const db = createTestDatabase(t);
  let issued = 0;
  let invalidations = 0;
  let attempts = 0;
  const tokenProvider = guestProvider();
  tokenProvider.getToken = async () => `guest-session-${++issued}`;
  tokenProvider.invalidate = () => { invalidations++; };
  const collector = new BusCollector(db, {
    now: () => NOW, env: { BUS_PROVIDER: 'connectx' }, tokenProvider,
    fetchBuses: async () => { attempts++; throw new ProviderError('Authorization failed', { httpStatus: 403 }); }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 502);
  assert.equal(attempts, 2);
  assert.equal(issued, 2);
  assert.equal(invalidations, 1);
  assert.equal(await db.getTotalSnapshotsCount(), 0);
  assert.equal((await collector.getStatus()).connectionState, 'error');
});

test('provider application errors do not trigger session renewal or create a successful empty poll', async t => {
  const db = createTestDatabase(t);
  let attempts = 0;
  let invalidations = 0;
  const tokenProvider = guestProvider();
  tokenProvider.invalidate = () => { invalidations++; };
  const collector = new BusCollector(db, {
    now: () => NOW, env: { BUS_PROVIDER: 'connectx' }, tokenProvider,
    fetchBuses: async () => {
      attempts++;
      throw new ProviderError('Live provider reported application error 4.', { code: 'provider_response_error' });
    }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, false);
  assert.equal(attempts, 1);
  assert.equal(invalidations, 0);
  assert.equal(await db.getTotalSnapshotsCount(), 0);
  assert.equal((await collector.getStatus()).lastPolledAt, 0);
});

test('provider failure preserves existing history and successful poll time', async t => {
  const db = createTestDatabase(t);
  const timestamp = Date.now() - 1000;
  await db.recordPoll([normalizeBus({ vehplate: 'TEST-RETAINED' }, 'A1', timestamp)], timestamp);
  await db.setSetting('last_polled_at', String(timestamp));
  const collector = new BusCollector(db, {
    env: { BUS_PROVIDER: 'connectx' }, tokenProvider: guestProvider(),
    fetchBuses: async () => { throw new Error('Provider unavailable'); }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 502);
  assert.equal(await db.getTotalSnapshotsCount(), 1);
  assert.equal((await collector.getStatus()).lastPolledAt, timestamp);
  assert.equal(collector.isPolling, false);
});

test('a successful empty poll removes old buses from the current fleet', async t => {
  const db = createTestDatabase(t);
  const timestamp = Date.now() - 1000;
  await db.recordPoll([normalizeBus({ vehplate: 'TEST-DEPARTED' }, 'A1', timestamp)], timestamp);
  const collector = new BusCollector(db, {
    env: { BUS_PROVIDER: 'connectx' }, tokenProvider: guestProvider(), fetchBuses: async () => []
  });
  const result = await collector.pollNow();
  assert.equal(result.success, true);
  assert.equal(result.recordsCount, 0);
  assert.deepEqual(await db.getLatestLiveBuses(), []);
  assert.equal(await db.getTotalSnapshotsCount(), 1, 'Successful empty fleet retains historical observations');
});

test('concurrent poll requests share one provider request and one stored batch', async t => {
  const db = createTestDatabase(t);
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let calls = 0;
  const collector = new BusCollector(db, {
    env: { BUS_PROVIDER: 'connectx' }, tokenProvider: guestProvider(),
    fetchBuses: async () => {
      calls++;
      markStarted();
      await new Promise(resolve => { release = resolve; });
      return [normalizeBus({ vehplate: 'TEST-ONE-POLL' }, 'A1', Date.now())];
    }
  });
  const first = collector.pollNow();
  const second = collector.pollNow();
  await started;
  assert.equal(calls, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.success));
  assert.equal(await db.getTotalSnapshotsCount(), 1);
  assert.equal(collector.isPolling, false);
});

function modernClient(fetchBuses = async () => []) {
  return { fetchBuses, getStatus: () => ({ hasSession: true, tokenSource: 'guest', tokenExpiresAt: null,
    sessionRenewAt: new Date(NOW + 86400000 - 900000).toISOString() }) };
}

test('automatic collection uses direct uNivUS guest sessions and retains GPS and actual source', async t => {
  const db = createTestDatabase(t);
  const univusClient = modernClient(async () => [normalizeBus({
    vehplate: 'TEST-UNIVUS', lat: 1.296, lng: 103.776, speed: 12, loadInfo: { capacity: 88, ridership: 0 }
  }, 'A1', NOW)]);
  const tokenProvider = guestProvider();
  tokenProvider.getToken = async () => assert.fail('Modern access does not obtain a ConnectX token');
  const collector = new BusCollector(db, {
    env: {}, now: () => NOW, univusClient, tokenProvider,
    fetchBuses: async () => assert.fail('Modern access must not call the old FMS client'),
    fetchPublic: async () => assert.fail('A successful direct feed must not use public arrivals')
  });
  const result = await collector.pollNow();
  assert.equal(result.success, true);
  assert.equal(result.authMode, 'guest');
  assert.equal(result.dataProvider, 'univus');
  assert.equal(result.coverage, 'route-fleet');
  assert.equal(result.providerWarning, null);
  const status = await collector.getStatus();
  assert.equal(status.hasToken, true);
  assert.equal(status.tokenExpiresAt, null, 'Opaque session expiry must not be invented');
  assert.equal(status.sessionRenewAt, univusClient.getStatus().sessionRenewAt);
  const record = (await db.getLatestLiveBuses(NOW))[0];
  assert.equal(record.source_provider, 'univus');
  assert.equal(record.ridership, 0);
  assert.equal(record.lat, 1.296);
});

test('temporary direct failures use labelled public observations and direct collection recovers at the next poll', async t => {
  const db = createTestDatabase(t);
  let directCalls = 0;
  let publicCalls = 0;
  const univusClient = modernClient(async () => {
    directCalls++;
    if (directCalls === 1) throw new ProviderError('uNivUS unavailable', { code: 'http_error', httpStatus: 503 });
    return [normalizeBus({ vehplate: 'TEST-RECOVERED' }, 'A1', NOW)];
  });
  const collector = new BusCollector(db, {
    env: { BUS_PROVIDER: '   ' }, now: () => NOW, univusClient,
    fetchPublic: async options => {
      assert.deepEqual(Object.keys(options).sort(), ['now', 'stops']);
      assert.deepEqual(options.stops, ['UTOWN', 'KR-MRT']);
      publicCalls++;
      return [normalizeBus({ vehplate: 'TEST-ARRIVING' }, 'A1', NOW)];
    }
  });
  const fallback = await collector.pollNow();
  assert.equal(fallback.success, true);
  assert.equal(fallback.dataProvider, 'community');
  assert.equal(fallback.coverage, 'stop-arrivals');
  assert.match(fallback.providerWarning, /uNivUS/);
  assert.equal((await db.getLatestPoll()).source_provider, 'community');
  assert.equal((await collector.getStatus()).configuredProvider, 'univus');
  const recovered = await collector.pollNow();
  assert.equal(recovered.success, true);
  assert.equal(recovered.dataProvider, 'univus');
  assert.equal(recovered.providerWarning, null);
  assert.equal(publicCalls, 1);
  assert.equal(directCalls, 2);
  assert.equal((await db.getLatestPoll()).source_provider, 'univus');
});

test('a failed public fallback preserves previous observations and never commits a partial batch', async t => {
  const db = createTestDatabase(t);
  await db.recordPoll([normalizeBus({ vehplate: 'TEST-KEPT' }, 'A1', NOW - 1)], NOW - 1);
  const collector = new BusCollector(db, {
    env: {}, now: () => NOW,
    univusClient: modernClient(async () => { throw new ProviderError('uNivUS unavailable'); }),
    fetchPublic: async () => { throw new ProviderError('Public observations are stale.', { code: 'stale_response' }); }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, false);
  assert.equal(result.dataProvider, 'community');
  assert.match(result.error, /stale/);
  assert.equal(await db.getTotalSnapshotsCount(), 1);
  assert.equal((await collector.getStatus()).lastPolledAt, NOW - 1);
});

test('explicitly direct configurations never silently switch providers', async t => {
  for (const env of [{ BUS_PROVIDER: 'connectx' }, { BUS_PROVIDER: 'univus' }]) {
    const db = createTestDatabase(t);
    const fail = async () => { throw new ProviderError('Upstream failed'); };
    const collector = new BusCollector(db, {
      env, now: () => NOW, tokenProvider: guestProvider(), univusClient: modernClient(fail), fetchBuses: fail,
      fetchPublic: async () => { assert.fail('No fallback was selected'); }
    });
    assert.equal((await collector.pollNow()).success, false);
    assert.equal(await db.getTotalSnapshotsCount(), 0);
  }
});

test('explicit public mode does not acquire or forward any credentials', async t => {
  const db = createTestDatabase(t);
  const tokenProvider = guestProvider();
  tokenProvider.getToken = async () => assert.fail('Public mode cannot authenticate');
  const collector = new BusCollector(db, {
    env: { BUS_PROVIDER: 'community', BUS_STOPS: 'UTOWN' }, now: () => NOW, tokenProvider,
    univusClient: modernClient(async () => assert.fail('Public mode cannot authenticate')),
    fetchBuses: async () => assert.fail('Public mode cannot contact ConnectX'),
    fetchPublic: async options => { assert.deepEqual(options.stops, ['UTOWN']); return []; }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, true);
  assert.equal(result.authMode, 'public');
  assert.equal((await collector.getStatus()).hasToken, false);
  assert.equal((await collector.getStatus()).tokenSource, 'none');
});

test('status attributes stored observations correctly after restart before direct collection resumes', async t => {
  const db = createTestDatabase(t);
  await db.recordPoll([normalizeBus({ vehplate: 'TEST-PROVENANCE' }, 'A1', NOW)], NOW, {
    dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN']
  });
  const collector = new BusCollector(db, { env: {}, now: () => NOW, univusClient: modernClient() });
  const status = await collector.getStatus();
  assert.equal(status.dataProvider, 'community');
  assert.equal(status.configuredProvider, 'univus');
  assert.equal(status.authMode, 'guest');
  assert.equal(status.coverage, 'stop-arrivals');
  assert.deepEqual(status.monitoredStops, ['UTOWN']);
});

function asyncDatabase(t) {
  const stored = createTestDatabase(t);
  const calls = [];
  const db = {};
  for (const method of ['getSetting', 'setSetting', 'deleteSetting', 'recordPoll', 'getLatestPoll', 'getTotalSnapshotsCount']) {
    db[method] = async (...args) => {
      calls.push(method);
      await Promise.resolve();
      return stored[method](...args);
    };
  }
  return { db, stored, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('collector defers shared database access and resolves status asynchronously', async t => {
  const { db, stored, calls } = asyncDatabase(t);
  await stored.setSetting('last_attempt_at', NOW);
  await stored.recordPoll([normalizeBus({ vehplate: 'TEST-SHARED-STATUS' }, 'A1', NOW)], NOW);
  const collector = new BusCollector(db, { env: {}, now: () => NOW, tokenProvider: guestProvider() });
  t.after(() => collector.stop());
  assert.deepEqual(calls, [], 'Constructing a cold function must not read the database');
  const status = await collector.getStatus();
  assert.equal(status.authMode, 'guest');
  assert.equal(status.configuredProvider, 'univus');
  assert.equal(status.connectionState, 'healthy');
  assert.equal(status.lastPolledAt, NOW);
  assert.equal(status.totalSnapshots, 1);
  assert.equal(status.collectionMode, 'on-demand');
  assert.equal(status.nextPollInSec, null);
  collector.start();
  const scheduled = await collector.getStatus();
  assert.equal(scheduled.collectionMode, 'scheduled');
  assert.equal(scheduled.nextPollInSec, 600);
});

test('collection stays pending until shared observations and error cleanup are persisted', async t => {
  const { db, stored } = asyncDatabase(t);
  await stored.setSetting('last_error', 'Previous failure');
  const writeStarted = deferred();
  const allowWrite = deferred();
  const cleanupStarted = deferred();
  const allowCleanup = deferred();
  db.recordPoll = async (...args) => {
    writeStarted.resolve();
    await allowWrite.promise;
    return await stored.recordPoll(...args);
  };
  db.deleteSetting = async key => {
    cleanupStarted.resolve();
    await allowCleanup.promise;
    return await stored.deleteSetting(key);
  };
  const collector = new BusCollector(db, {
    env: { BUS_PROVIDER: 'connectx' }, now: () => NOW, tokenProvider: guestProvider(),
    fetchBuses: async () => [normalizeBus({ vehplate: 'TEST-SHARED-COMMIT' }, 'A1', NOW)]
  });
  let settled = false;
  const pending = collector.pollNow().then(result => { settled = true; return result; });
  try {
    await writeStarted.promise;
    assert.equal(settled, false);
    assert.equal(collector.isPolling, true);
    assert.equal(await stored.getTotalSnapshotsCount(), 0);
    assert.equal(await stored.getSetting('last_attempt_at'), String(NOW));
    allowWrite.resolve();
    await cleanupStarted.promise;
    assert.equal(settled, false, 'A response cannot report success before cleanup is durable');
    assert.equal(await stored.getTotalSnapshotsCount(), 1);
    assert.equal(await stored.getSetting('last_error'), 'Previous failure');
    allowCleanup.resolve();
    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(await stored.getSetting('last_error'), null);
    assert.equal(collector.isPolling, false);
  } finally {
    allowWrite.resolve();
    allowCleanup.resolve();
    await pending;
  }
});

test('a rejected shared database commit cannot report a successful collection', async t => {
  const { db, stored } = asyncDatabase(t);
  db.recordPoll = async () => {
    await Promise.resolve();
    throw new Error('Private database connection detail');
  };
  const collector = new BusCollector(db, {
    env: { BUS_PROVIDER: 'connectx' }, now: () => NOW, tokenProvider: guestProvider(),
    fetchBuses: async () => [normalizeBus({ vehplate: 'TEST-NOT-COMMITTED' }, 'A1', NOW)]
  });
  const result = await collector.pollNow();
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 502);
  assert.equal(result.error.includes('Private database connection detail'), false);
  assert.equal(await stored.getTotalSnapshotsCount(), 0);
  assert.equal(await stored.getSetting('last_error'), result.error);
  assert.equal((await collector.getStatus()).lastPolledAt, 0);
  assert.equal(collector.isPolling, false);
});

test('failed asynchronous attempt recording stops collection even if error recording also fails', async t => {
  const { db, stored } = asyncDatabase(t);
  db.setSetting = async () => { throw new Error('Database unavailable'); };
  let providerCalls = 0;
  const collector = new BusCollector(db, {
    env: { BUS_PROVIDER: 'connectx' }, now: () => NOW, tokenProvider: guestProvider(),
    fetchBuses: async () => { providerCalls++; return []; }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, false);
  assert.equal(providerCalls, 0);
  assert.equal(await stored.getLatestPoll(), null);
  assert.equal(collector.isPolling, false);
});

test('stopping the scheduler during a shared state read prevents a new provider poll', async t => {
  const { db } = asyncDatabase(t);
  const allowRead = deferred();
  db.getSetting = async () => { await allowRead.promise; return '0'; };
  let providerCalls = 0;
  const collector = new BusCollector(db, {
    env: { BUS_PROVIDER: 'connectx' }, now: () => NOW,
    fetchBuses: async () => { providerCalls++; return []; }
  });
  t.after(() => collector.stop());
  collector.start();
  collector.stop();
  allowRead.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(providerCalls, 0);
  assert.equal(collector.isPolling, false);
  assert.equal(collector.timer, null);
});

test('local scheduling automatically collects on startup and every ten minutes until stopped', async t => {
  const db = createTestDatabase(t);
  await db.ready();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  let providerCalls = 0;
  const collector = new BusCollector(db, {
    env: { BUS_PROVIDER: 'connectx' }, tokenProvider: guestProvider(),
    fetchBuses: async () => {
      providerCalls++;
      return [normalizeBus({ vehplate: 'TEST-AUTOMATIC-POLL' }, 'A1', Date.now())];
    }
  });
  t.after(() => collector.stop());
  const flush = () => new Promise(resolve => setImmediate(resolve));

  collector.start();
  await flush();
  assert.equal(providerCalls, 1, 'Starting the local server collects without a dashboard request');
  assert.equal((await db.getLatestPoll()).timestamp, NOW);
  assert.equal((await collector.getStatus()).nextPollInSec, 600);

  t.mock.timers.tick(599999);
  await flush();
  assert.equal(providerCalls, 1, 'No second collection occurs before ten minutes');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(providerCalls, 2, 'The second automatic collection starts exactly ten minutes later');
  assert.equal((await db.getLatestPoll()).timestamp, NOW + 600000);
  assert.equal(await db.getTotalSnapshotsCount(), 2);

  collector.stop();
  t.mock.timers.tick(600000);
  await flush();
  assert.equal(providerCalls, 2, 'Stopping the server cancels the next automatic collection');
  assert.equal(collector.timer, null);
});


test('database initialization failures are reported before contacting the bus provider', async t => {
  const { LibsqlError } = await import('@libsql/client/web');
  let providerCalls = 0;
  const failure = new LibsqlError('private database SQL and secret credentials', 'SQL_PARSE_ERROR');
  const db = {
    getSetting: async () => { throw failure; },
    setSetting: async () => { throw failure; }
  };
  const collector = new BusCollector(db, {
    env: {}, univusClient: modernClient(async () => { providerCalls++; return []; })
  });
  const result = await collector.pollNow();
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.code, 'database_query_failed');
  assert.equal(result.databaseCode, 'SQL_PARSE_ERROR');
  assert.equal(providerCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), /private database SQL|secret credentials/);
});
