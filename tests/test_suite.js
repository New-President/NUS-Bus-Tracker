import assert from 'node:assert/strict';
import test from 'node:test';
import './no_provider_network.js';

// Set before dynamic imports: importing collector also creates the default DB.
process.env.BUS_DB_PATH = ':memory:';
for (const key of ['FMS_TOKEN', 'ADMIN_TOKEN', 'CRON_SECRET']) delete process.env[key];

const { fetchLiveRouteBuses, fetchAllLiveBuses, normalizeBus, ProviderError } = await import('../src/api_client.js');
const { BusCollector } = await import('../src/collector.js');
const { BusDatabase } = await import('../src/db.js');
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

function withDatabase(t) {
  const db = new BusDatabase(':memory:');
  t.after(() => db.close());
  return db;
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
  const db = withDatabase(t);
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
  assert.equal(db.getTotalSnapshotsCount(), 0);
  assert.equal(collector.getStatus().lastPolledAt, 0);
});

test('collector obtains a guest token and collects without manual credentials', async t => {
  const db = withDatabase(t);
  let receivedToken;
  const collector = new BusCollector(db, {
    now: () => NOW, env: { BUS_PROVIDER: 'connectx' }, tokenProvider: guestProvider(),
    fetchBuses: async token => {
      receivedToken = token;
      return [normalizeBus({ vehplate: 'TEST-GUEST' }, 'A1', NOW)];
    }
  });
  const before = collector.getStatus();
  assert.equal(before.authMode, 'guest');
  assert.equal(before.tokenSource, 'guest');
  assert.equal(before.requiresToken, false);
  assert.equal(before.canPoll, true);
  const result = await collector.pollNow();
  assert.equal(result.success, true);
  assert.equal(receivedToken, 'guest-provider-test-token');
  assert.equal(db.getSetting('fms_token'), '');
  assert.equal(db.getTotalSnapshotsCount(), 1);
  assert.equal(collector.getStatus().connectionState, 'healthy');
  assert.equal(JSON.stringify(collector.getStatus()).includes(receivedToken), false);
});

test('collector gives environment credentials precedence and never exposes them', async t => {
  const db = withDatabase(t);
  db.setSetting('fms_token', 'stored-test-token');
  let receivedToken;
  let guestCalls = 0;
  const tokenProvider = guestProvider();
  tokenProvider.getToken = async () => { guestCalls++; throw new Error('Manual credentials must take precedence'); };
  const collector = new BusCollector(db, {
    now: () => NOW, env: { FMS_TOKEN: TOKEN }, tokenProvider,
    fetchBuses: async token => { receivedToken = token; return []; }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, true);
  assert.equal(receivedToken, TOKEN);
  assert.equal(guestCalls, 0);
  assert.equal(collector.getStatus().authMode, 'manual');
  assert.equal(JSON.stringify(collector.getStatus()).includes(TOKEN), false);
  assert.equal(collector.getStatus().lastPolledAt, NOW);
});

test('an expired guest session is renewed once before storing a successful collection', async t => {
  const db = withDatabase(t);
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
  assert.equal(db.getTotalSnapshotsCount(), 1);
});

test('repeated guest authorization failures stop after one renewal without storing observations', async t => {
  const db = withDatabase(t);
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
  assert.equal(db.getTotalSnapshotsCount(), 0);
  assert.equal(collector.getStatus().connectionState, 'error');
});

test('provider application errors do not trigger session renewal or create a successful empty poll', async t => {
  const db = withDatabase(t);
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
  assert.equal(db.getTotalSnapshotsCount(), 0);
  assert.equal(collector.getStatus().lastPolledAt, 0);
});

test('a rejected manual override is not silently replaced with guest authentication', async t => {
  const db = withDatabase(t);
  let guestCalls = 0;
  let attempts = 0;
  const tokenProvider = guestProvider();
  tokenProvider.getToken = async () => { guestCalls++; return 'guest-token'; };
  const collector = new BusCollector(db, {
    now: () => NOW, env: { FMS_TOKEN: TOKEN }, tokenProvider,
    fetchBuses: async () => { attempts++; throw new ProviderError('Manual authorization failed', { httpStatus: 401 }); }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, false);
  assert.equal(result.authMode, 'manual');
  assert.equal(attempts, 1);
  assert.equal(guestCalls, 0);
  assert.equal(db.getTotalSnapshotsCount(), 0);
});

test('provider failure preserves existing history and successful poll time', async t => {
  const db = withDatabase(t);
  const timestamp = Date.now() - 1000;
  db.recordPoll([normalizeBus({ vehplate: 'TEST-RETAINED' }, 'A1', timestamp)], timestamp);
  db.setSetting('last_polled_at', String(timestamp));
  const collector = new BusCollector(db, {
    env: { FMS_TOKEN: TOKEN }, tokenProvider: guestProvider(),
    fetchBuses: async () => { throw new Error('Provider unavailable'); }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 502);
  assert.equal(db.getTotalSnapshotsCount(), 1);
  assert.equal(collector.getStatus().lastPolledAt, timestamp);
  assert.equal(collector.isPolling, false);
});

test('a successful empty poll removes old buses from the current fleet', async t => {
  const db = withDatabase(t);
  const timestamp = Date.now() - 1000;
  db.recordPoll([normalizeBus({ vehplate: 'TEST-DEPARTED' }, 'A1', timestamp)], timestamp);
  const collector = new BusCollector(db, {
    env: { FMS_TOKEN: TOKEN }, tokenProvider: guestProvider(), fetchBuses: async () => []
  });
  const result = await collector.pollNow();
  assert.equal(result.success, true);
  assert.equal(result.recordsCount, 0);
  assert.deepEqual(db.getLatestLiveBuses(), []);
  assert.equal(db.getTotalSnapshotsCount(), 1, 'Successful empty fleet retains historical observations');
});

test('concurrent poll requests share one provider request and one stored batch', async t => {
  const db = withDatabase(t);
  let release;
  let calls = 0;
  const collector = new BusCollector(db, {
    env: { FMS_TOKEN: TOKEN }, tokenProvider: guestProvider(),
    fetchBuses: async () => {
      calls++;
      await new Promise(resolve => { release = resolve; });
      return [normalizeBus({ vehplate: 'TEST-ONE-POLL' }, 'A1', Date.now())];
    }
  });
  const first = collector.pollNow();
  const second = collector.pollNow();
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.success));
  assert.equal(db.getTotalSnapshotsCount(), 1);
  assert.equal(collector.isPolling, false);
});

function modernClient(fetchBuses = async () => []) {
  return { fetchBuses, getStatus: () => ({ hasSession: true, tokenSource: 'guest', tokenExpiresAt: null,
    sessionRenewAt: new Date(NOW + 86400000 - 900000).toISOString() }) };
}

test('automatic collection uses direct uNivUS guest sessions and retains GPS and actual source', async t => {
  const db = withDatabase(t);
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
  const status = collector.getStatus();
  assert.equal(status.hasToken, true);
  assert.equal(status.tokenExpiresAt, null, 'Opaque session expiry must not be invented');
  assert.equal(status.sessionRenewAt, univusClient.getStatus().sessionRenewAt);
  const record = db.getLatestLiveBuses(NOW)[0];
  assert.equal(record.source_provider, 'univus');
  assert.equal(record.ridership, 0);
  assert.equal(record.lat, 1.296);
  assert.equal(db.getSetting('fms_token'), '');
});

test('temporary direct failures use labelled public observations and direct collection recovers at the next poll', async t => {
  const db = withDatabase(t);
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
  assert.equal(db.getLatestPoll().source_provider, 'community');
  assert.equal(collector.getStatus().configuredProvider, 'univus');
  const recovered = await collector.pollNow();
  assert.equal(recovered.success, true);
  assert.equal(recovered.dataProvider, 'univus');
  assert.equal(recovered.providerWarning, null);
  assert.equal(publicCalls, 1);
  assert.equal(directCalls, 2);
  assert.equal(db.getLatestPoll().source_provider, 'univus');
});

test('a failed public fallback preserves previous observations and never commits a partial batch', async t => {
  const db = withDatabase(t);
  db.recordPoll([normalizeBus({ vehplate: 'TEST-KEPT' }, 'A1', NOW - 1)], NOW - 1);
  const collector = new BusCollector(db, {
    env: {}, now: () => NOW,
    univusClient: modernClient(async () => { throw new ProviderError('uNivUS unavailable'); }),
    fetchPublic: async () => { throw new ProviderError('Public observations are stale.', { code: 'stale_response' }); }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, false);
  assert.equal(result.dataProvider, 'community');
  assert.match(result.error, /stale/);
  assert.equal(db.getTotalSnapshotsCount(), 1);
  assert.equal(collector.getStatus().lastPolledAt, NOW - 1);
});

test('manual and explicitly direct configurations never silently switch providers', async t => {
  for (const env of [{ FMS_TOKEN: TOKEN }, { BUS_PROVIDER: 'connectx' }, { BUS_PROVIDER: 'univus' }]) {
    const db = withDatabase(t);
    const fail = async () => { throw new ProviderError('Upstream failed'); };
    const collector = new BusCollector(db, {
      env, now: () => NOW, tokenProvider: guestProvider(), univusClient: modernClient(fail), fetchBuses: fail,
      fetchPublic: async () => { assert.fail('No fallback was selected'); }
    });
    assert.equal((await collector.pollNow()).success, false);
    assert.equal(db.getTotalSnapshotsCount(), 0);
  }
});

test('explicit public mode does not acquire or forward any credentials', async t => {
  const db = withDatabase(t);
  const tokenProvider = guestProvider();
  tokenProvider.getToken = async () => assert.fail('Public mode cannot authenticate');
  const collector = new BusCollector(db, {
    env: { BUS_PROVIDER: 'community', BUS_STOPS: 'UTOWN', FMS_TOKEN: TOKEN }, now: () => NOW, tokenProvider,
    univusClient: modernClient(async () => assert.fail('Public mode cannot authenticate')),
    fetchBuses: async () => assert.fail('Public mode cannot contact ConnectX'),
    fetchPublic: async options => { assert.deepEqual(options.stops, ['UTOWN']); return []; }
  });
  const result = await collector.pollNow();
  assert.equal(result.success, true);
  assert.equal(result.authMode, 'public');
  assert.equal(collector.getStatus().hasToken, false);
  assert.equal(collector.getStatus().tokenSource, 'none');
});

test('status attributes stored observations correctly after restart before direct collection resumes', async t => {
  const db = withDatabase(t);
  db.recordPoll([normalizeBus({ vehplate: 'TEST-PROVENANCE' }, 'A1', NOW)], NOW, {
    dataProvider: 'community', coverage: 'stop-arrivals', monitoredStops: ['UTOWN']
  });
  const collector = new BusCollector(db, { env: {}, now: () => NOW, univusClient: modernClient() });
  const status = collector.getStatus();
  assert.equal(status.dataProvider, 'community');
  assert.equal(status.configuredProvider, 'univus');
  assert.equal(status.authMode, 'guest');
  assert.equal(status.coverage, 'stop-arrivals');
  assert.deepEqual(status.monitoredStops, ['UTOWN']);
});
