import assert from 'node:assert/strict';
import test from 'node:test';
import './no_provider_network.js';

const { UnivusClient } = await import('../src/univus_client.js');
const { ProviderError } = await import('../src/provider_http.js');
const NOW = Date.parse('2026-09-11T05:56:00Z');
const ORIGIN = 'https://inetapps.nus.edu.sg';
const BASE = `${ORIGIN}/univus/web/`;
const PRIVATE = 'synthetic-private-session-value';

function cookies(id = 'one') {
  return [
    `UNIVUS_WEB_API_DATA=${PRIVATE}-${id}==; path=/univus/web; Secure; HttpOnly; SameSite=Lax`,
    `.AspNetCore.Antiforgery.test=antiforgery-${id}; path=/univus/web; Secure; HttpOnly; SameSite=Strict`,
    `UNIVUS_WEB_XSRF_TOKEN=xsrf-${id}%2B%2F%3D; path=/univus/web; Secure; SameSite=Lax`,
    'UNIVUS_WEB_USER_DOMAIN=PUBLIC; path=/univus/web; Secure; SameSite=Lax',
    'UNIVUS_WEB_USER_NAME=Guest; path=/univus/web; Secure; SameSite=Lax',
    `.Univus.Web.Session=${PRIVATE}-${id}; path=/; Secure; HttpOnly; SameSite=Lax`,
    'ApplicationGatewayAffinity=affinity; Path=/',
    'ApplicationGatewayAffinityCORS=affinity; Path=/; SameSite=None; Secure',
    'UNIVUS_WEB_CREATE_ACCOUNT_F=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/univus/web; Secure'
  ];
}
function login({ id = 'one', values = cookies(id), location = `${BASE}#/home`, status = 302 } = {}) {
  const headers = new Headers({ location });
  for (const value of values) headers.append('set-cookie', value);
  return new Response(null, { status, headers });
}
function data(buses = [], timestamp = NOW) {
  return {
    code: '00000', data: {
      TimeStamp: typeof timestamp === 'number' ? new Date(timestamp).toISOString() : timestamp,
      ActiveBusCount: String(buses.length), activebus: buses
    }
  };
}
function json(payload, { status = 200, values = [] } = {}) {
  const headers = new Headers({ 'content-type': 'text/plain' });
  for (const value of values) headers.append('set-cookie', value);
  return new Response(JSON.stringify(payload), { status, headers });
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup(handler, options = {}) {
  const calls = [];
  const client = new UnivusClient({
    now: () => NOW,
    fetchImpl: async (url, request) => {
      const call = { url: String(url), request, payload: request.body ? JSON.parse(request.body) : null };
      calls.push(call);
      return handler(call, calls.length);
    }, ...options
  });
  return { client, calls };
}

test('official guest login uses the fixed origin, session cookies and XSRF without exposing credentials', async () => {
  const { client, calls } = setup(call => call.request.method === 'GET' ? login() : json(data()));
  assert.deepEqual(client.getStatus(), { hasSession: false, tokenSource: 'guest', tokenExpiresAt: null, sessionRenewAt: null });
  assert.equal(await client.ensureSession(), undefined);
  assert.deepEqual(await client.fetchRouteBuses('A1'), []);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${BASE}api/login/loginPublic`);
  assert.equal(calls[0].request.redirect, 'manual');
  assert.equal(calls[0].request.headers.Cookie, undefined);
  assert.equal(calls[1].url, `${BASE}api/esb`);
  assert.equal(calls[1].request.redirect, 'error');
  assert.deepEqual(calls[1].payload, { methodpath: '/univus/api/bus-proxy/active-bus', route_code: 'A1' });
  const headers = calls[1].request.headers;
  assert.equal(headers['X-XSRF-TOKEN'], 'xsrf-one+/=');
  assert.equal(headers.Origin, ORIGIN);
  assert.equal(headers.Referer, BASE);
  assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
  assert.ok(headers.Cookie.includes(`${PRIVATE}-one==`), 'Cookie padding must survive parsing');
  assert.ok(headers.Cookie.includes('.AspNetCore.Antiforgery.test=antiforgery-one'));
  assert.ok(headers.Cookie.includes('ApplicationGatewayAffinity=affinity'));
  assert.equal(headers.Cookie.includes('UNIVUS_WEB_CREATE_ACCOUNT_F'), false);
  assert.deepEqual(client.getStatus(), {
    hasSession: true, tokenSource: 'guest', tokenExpiresAt: null,
    sessionRenewAt: new Date(NOW + (24 * 60 - 15) * 60000).toISOString()
  });
  assert.equal(JSON.stringify(client).includes(PRIVATE), false);
  assert.equal(JSON.stringify(client.getStatus()).includes(PRIVATE), false);
});

test('full route collection preserves measured zeros, GPS, unknown values, and a common poll timestamp', async () => {
  const vehicle = { vehplate: 'TEST-BUS', lat: 0, lng: 103.78, speed: 0, loadInfo: { capacity: 88, ridership: 0, occupancy: 0 } };
  const { client } = setup(call => call.request.method === 'GET' ? login()
    : json(data(call.payload.route_code === 'A1' ? [vehicle, { vehplate: 'UNKNOWN' }] : [vehicle])));
  const result = await client.fetchBuses({ routes: ['A1', 'A2'] });
  assert.equal(result.length, 2, 'Overlapping route responses count each plate once');
  assert.equal(result[0].timestamp, NOW);
  assert.equal(result[1].timestamp, NOW);
  assert.equal(result[0].route_code, 'A1');
  assert.equal(result[0].lat, 0);
  assert.equal(result[0].lng, 103.78);
  assert.equal(result[0].speed, 0);
  assert.equal(result[0].ridership, 0);
  assert.equal(result[0].occupancy, 0);
  assert.equal(result[0].crowd_level, 'low');
  for (const key of ['lat', 'lng', 'speed', 'capacity', 'ridership', 'occupancy', 'crowd_level']) assert.equal(result[1][key], null);
});

test('ASP.NET JSON string wrappers are decoded once and malformed inner payloads remain failures', async () => {
  const vehicle = { vehplate: 'WRAPPED-BUS', lat: 1.29, lng: 103.78, loadInfo: { capacity: 88, ridership: 12 } };
  const { client } = setup(call => call.request.method === 'GET' ? login() : json(JSON.stringify(data([vehicle]))));
  assert.deepEqual(await client.fetchRouteBuses('A1'), [vehicle]);
  for (const payload of [PRIVATE, JSON.stringify(JSON.stringify(data())), JSON.stringify(null), JSON.stringify([])]) {
    const { client: malformed } = setup(call => call.request.method === 'GET' ? login() : json(payload));
    await assert.rejects(malformed.fetchRouteBuses('A1'), error => {
      assert.equal(error.message.includes(PRIVATE), false);
      return ['invalid_json', 'invalid_response'].includes(error.code);
    });
  }
});

test('wrapped authentication failures use the same one-time renewal flow', async () => {
  for (const code of ['10007', '19000']) {
    let posts = 0;
    let logins = 0;
    const { client } = setup(call => {
      if (call.request.method === 'GET') { logins++; return login(); }
      posts++;
      return json(JSON.stringify(posts === 1 ? { code } : data()));
    });
    assert.deepEqual(await client.fetchRouteBuses('A1'), []);
    assert.equal(logins, 2);
    assert.equal(posts, 2);
  }
});

test('concurrent first queries share one guest login and the cached session', async () => {
  const gate = deferred();
  const { client, calls } = setup(call => call.request.method === 'GET' ? gate.promise : json(data()));
  const work = ['A1', 'A2', 'D1'].map(route => client.fetchRouteBuses(route));
  assert.equal(calls.length, 1);
  gate.resolve(login());
  await Promise.all(work);
  await client.ensureSession();
  assert.equal(calls.filter(call => call.request.method === 'GET').length, 1);
  assert.equal(calls.filter(call => call.request.method === 'POST').length, 3);
});

test('sessions renew daily on a planned schedule without claiming a token expiry', async () => {
  let now = NOW;
  let logins = 0;
  const { client } = setup(call => call.request.method === 'GET' ? (logins++, login()) : json(data([], now)), { now: () => now });
  await client.ensureSession();
  now += (24 * 60 - 15) * 60000 - 1;
  await client.ensureSession();
  assert.equal(logins, 1);
  now++;
  await client.ensureSession();
  assert.equal(logins, 2);
  assert.equal(client.getStatus().tokenExpiresAt, null);
});

test('explicit cookie expiration triggers earlier renewal and Max-Age overrides Expires', async () => {
  let now = NOW;
  let logins = 0;
  const values = cookies().map(cookie => cookie.startsWith('.Univus.Web.Session=')
    ? `${cookie}; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT` : cookie);
  const { client } = setup(() => { logins++; return login({ values }); }, { now: () => now });
  await client.ensureSession();
  assert.equal(client.getStatus().sessionRenewAt, new Date(NOW + 60000).toISOString());
  now += 60000;
  assert.equal(client.getStatus().hasSession, false);
  await client.ensureSession();
  assert.equal(logins, 2);
});

test('cookie updates rotate XSRF and delete expired values without sending unrelated paths or hosts', async () => {
  let posts = 0;
  const extras = [
    'foreign=forbidden; Domain=example.com; Path=/',
    'unrelated=forbidden; Path=/univus/other',
    'suffix=forbidden; Domain=evilinetapps.nus.edu.sg; Path=/',
    'temporary=remove-me; Path=/univus/web'
  ];
  const { client, calls } = setup(call => {
    if (call.request.method === 'GET') return login({ values: [...cookies(), ...extras] });
    posts++;
    return json(data(), { values: posts === 1 ? [
      'UNIVUS_WEB_XSRF_TOKEN=new%2Btoken; Path=/univus/web; Secure',
      'temporary=; Path=/univus/web; Max-Age=0'
    ] : [] });
  });
  await client.fetchRouteBuses('A1');
  await client.fetchRouteBuses('A1');
  assert.equal(calls[1].request.headers.Cookie.includes('forbidden'), false);
  assert.equal(calls[2].request.headers.Cookie.includes('remove-me'), false);
  assert.equal(calls[2].request.headers['X-XSRF-TOKEN'], 'new+token');
});

test('deleting a required cookie on a response causes a fresh login before the next request', async () => {
  let logins = 0;
  let posts = 0;
  const { client } = setup(call => {
    if (call.request.method === 'GET') { logins++; return login(); }
    posts++;
    return json(data(), { values: posts === 1 ? ['.Univus.Web.Session=; Path=/; Max-Age=0'] : [] });
  });
  await client.fetchRouteBuses('A1');
  assert.equal(client.getStatus().hasSession, false);
  await client.fetchRouteBuses('A1');
  assert.equal(logins, 2);
});

test('HTTP 401 and 403 renew once, and other HTTP failures do not cause a login loop', async () => {
  for (const status of [401, 403, 502]) {
    let logins = 0;
    let posts = 0;
    const { client } = setup(call => {
      if (call.request.method === 'GET') { logins++; return login({ id: String(logins) }); }
      posts++;
      return posts === 1 ? new Response(PRIVATE, { status }) : json(data());
    });
    if (status === 502) await assert.rejects(client.fetchRouteBuses('A1'), { httpStatus: 502 });
    else assert.deepEqual(await client.fetchRouteBuses('A1'), []);
    assert.equal(logins, status === 502 ? 1 : 2);
    assert.equal(posts, status === 502 ? 1 : 2);
  }
});

test('expired application codes renew once and a second rejection invalidates the unusable session', async () => {
  for (const code of ['10007', '19000']) {
    for (const persistent of [false, true]) {
      let logins = 0;
      let posts = 0;
      const { client } = setup(call => {
        if (call.request.method === 'GET') { logins++; return login(); }
        posts++;
        return json(persistent || posts === 1 ? { code, msg: PRIVATE } : data());
      });
      if (persistent) await assert.rejects(client.fetchRouteBuses('A1'), { code: 'univus_session_expired' });
      else await client.fetchRouteBuses('A1');
      assert.equal(logins, 2);
      assert.equal(posts, 2);
      assert.equal(client.getStatus().hasSession, !persistent);
    }
  }
});

test('late concurrent rejections of the old session reuse the completed replacement login', async () => {
  const oldA1 = deferred();
  const oldA2 = deferred();
  const started = deferred();
  let oldPosts = 0;
  let logins = 0;
  const { client } = setup(call => {
    if (call.request.method === 'GET') { logins++; return login({ id: String(logins) }); }
    if (call.request.headers.Cookie.includes(`${PRIVATE}-1;`)) {
      oldPosts++;
      if (oldPosts === 2) started.resolve();
      return call.payload.route_code === 'A1' ? oldA1.promise : oldA2.promise;
    }
    return json(data());
  });
  const first = client.fetchRouteBuses('A1');
  const second = client.fetchRouteBuses('A2');
  await started.promise;
  oldA1.resolve(new Response(null, { status: 401 }));
  await first;
  oldA2.resolve(json({ code: '19000' }));
  await second;
  assert.equal(logins, 2);
});

test('unsafe redirects, missing authentication cookies, non-public domains and malformed XSRF fail closed', async () => {
  const invalid = [
    { location: 'https://example.com/steal' },
    { location: `${ORIGIN}/univus/other/` },
    { location: 'http://inetapps.nus.edu.sg/univus/web/' },
    { location: 'https://user:password@inetapps.nus.edu.sg/univus/web/' },
    { location: '' },
    { status: 200 },
    ...['UNIVUS_WEB_API_DATA=', '.Univus.Web.Session=', 'UNIVUS_WEB_XSRF_TOKEN='].map(prefix => ({ values: cookies().filter(value => !value.startsWith(prefix)) })),
    { values: cookies().map(value => value.replace('UNIVUS_WEB_USER_DOMAIN=PUBLIC', 'UNIVUS_WEB_USER_DOMAIN=NUSSTU')) },
    { values: cookies().map(value => value.replace('xsrf-one%2B%2F%3D', '%0D%0Aheader-injection')) },
    { values: cookies().map(value => value.replace('xsrf-one%2B%2F%3D', '%malformed')) },
    { values: [...cookies(), '.Univus.Web.Session=; Path=/; Max-Age=0'] }
  ];
  for (const response of invalid) {
    const { client, calls } = setup(() => login(response));
    await assert.rejects(client.fetchRouteBuses('A1'), error => {
      assert.equal(error.message.includes(PRIVATE), false);
      return error.code === 'univus_auth_failed';
    });
    assert.equal(calls.length, 1, 'No redirect or bus request is permitted after invalid login');
    assert.equal(client.getStatus().hasSession, false);
  }
});

test('failed login can recover on a later request and never caches a rejected promise', async () => {
  let logins = 0;
  const { client } = setup(call => {
    if (call.request.method === 'GET') { logins++; return login(logins === 1 ? { status: 503 } : {}); }
    return json(data());
  });
  await assert.rejects(client.fetchRouteBuses('A1'), { code: 'univus_auth_failed' });
  assert.deepEqual(await client.fetchRouteBuses('A1'), []);
  assert.equal(logins, 2);
});

test('malformed responses and non-authentication application errors cannot become successful empty fleets', async () => {
  for (const payload of [null, [], {}, { code: '10000', msg: PRIVATE }, { ...data(), code: undefined },
    { code: '00000', data: [] }, { code: '00000', data: { TimeStamp: new Date(NOW).toISOString(), activebus: {} } },
    { code: '00000', data: { ...data().data, ActiveBusCount: '1' } }, data([null]), data([{}])]) {
    const { client, calls } = setup(call => call.request.method === 'GET' ? login() : json(payload));
    await assert.rejects(client.fetchRouteBuses('A1'), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(PRIVATE), false);
      return true;
    });
    assert.equal(calls.length, 2, 'Non-authentication failures should not trigger renewal');
  }
});

test('ActiveBusCount requires a primitive integer representation', async () => {
  for (const count of [[0], ['0'], {}, true, null, 0.5]) {
    const payload = data();
    payload.data.ActiveBusCount = count;
    const { client } = setup(call => call.request.method === 'GET' ? login() : json(payload));
    await assert.rejects(client.fetchRouteBuses('A1'), { code: 'invalid_response' });
  }
});

test('malformed response cookies cancel the body before rejecting the provider response', async () => {
  let cancelled = false;
  const { client } = setup(call => call.request.method === 'GET' ? login()
    : new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: { 'set-cookie': 'malformed-cookie-without-equals' }
    }));
  await assert.rejects(client.fetchRouteBuses('A1'), { code: 'univus_auth_failed' });
  assert.equal(cancelled, true);
});

test('timestamps are required and must be within two minutes past or sixty seconds future', async () => {
  for (const timestamp of [undefined, '', 'garbage', '2026-09-11 05:56:00', NOW - 120001, NOW + 60001]) {
    const payload = data();
    payload.data.TimeStamp = typeof timestamp === 'number' ? new Date(timestamp).toISOString() : timestamp;
    const { client } = setup(call => call.request.method === 'GET' ? login() : json(payload));
    await assert.rejects(client.fetchRouteBuses('A1'), { code: 'stale_response' });
  }
  for (const timestamp of [NOW - 120000, NOW + 60000, '2026-09-11T13:56:00+08:00']) {
    const { client } = setup(call => call.request.method === 'GET' ? login() : json(data([], timestamp)));
    assert.deepEqual(await client.fetchRouteBuses('A1'), []);
  }
});

test('invalid routes are rejected before network access and one failed route rejects the complete collection', async () => {
  const { client, calls } = setup(call => call.request.method === 'GET' ? login()
    : json(call.payload.route_code === 'A1' ? data([{ vehplate: 'VALID' }]) : { code: '10000' }));
  for (const route of ['', '../A1', 'A1&token=bad', undefined, 123]) await assert.rejects(client.fetchRouteBuses(route), { code: 'invalid_route' });
  assert.equal(calls.length, 0);
  await assert.rejects(client.fetchBuses({ routes: ['A1', 'A2'] }), { code: 'provider_response_error' });
});

test('guest login timeout aborts stalled requests and sensitive transport errors are redacted', async () => {
  let signal;
  const { client } = setup(call => {
    signal = call.request.signal;
    return new Promise(() => {});
  }, { timeoutMs: 5 });
  await assert.rejects(client.ensureSession(), { code: 'timeout' });
  assert.equal(signal.aborted, true);
  const { client: failing } = setup(() => { throw new Error(PRIVATE); });
  await assert.rejects(failing.ensureSession(), error => !error.message.includes(PRIVATE) && error.code === 'univus_auth_failed');
});

test('bus queries use the bounded HTTP helper for streaming size limits and timeout aborts', async () => {
  const { client } = setup(call => call.request.method === 'GET' ? login()
    : new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
  await assert.rejects(client.fetchRouteBuses('A1'), { code: 'response_too_large' });
  let signal;
  const { client: stalled } = setup(call => {
    if (call.request.method === 'GET') return login();
    signal = call.request.signal;
    return new Promise(() => {});
  }, { timeoutMs: 5 });
  await assert.rejects(stalled.fetchRouteBuses('A1'), { code: 'timeout' });
  assert.equal(signal.aborted, true);
});
