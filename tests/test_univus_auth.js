import assert from 'node:assert/strict';
import test from 'node:test';
import './no_provider_network.js';

const { GuestTokenProvider } = await import('../src/univus_auth.js');
const { ProviderError, requestProviderJson } = await import('../src/provider_http.js');
const NOW = Date.parse('2026-09-11T04:00:00Z');
const USER_ID = '9369b806-8063-46f9-a093-67a2c84c3797';
const FMS_TOKEN = 'test-private-fms-token';
const DAY_MS = 24 * 60 * 60 * 1000;

function jwt(exp) {
  return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.test-signature`;
}
function accessData(overrides = {}) {
  return { code: '00000', data: { domain: 'PUBLIC', userid: USER_ID, token: jwt((NOW + DAY_MS) / 1000), ...overrides } };
}
function initData(token = FMS_TOKEN) { return { code: '00000', data: { tokens: { nextbus_token2: token } } }; }
function json(data) { return new Response(JSON.stringify(data), { status: 200 }); }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fakeProvider(payloads, overrides = {}) {
  const calls = [];
  const provider = new GuestTokenProvider({
    now: () => NOW, env: {},
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      assert.ok(payloads.length, 'Unexpected additional provider request');
      const next = payloads.shift();
      return typeof next === 'function' ? next() : json(next);
    }, ...overrides
  });
  return { provider, calls };
}

test('guest bootstrap follows the public flow and caches only safe status', async () => {
  const access = accessData();
  const { provider, calls } = fakeProvider([access, initData()], {
    env: { UNIVUS_HTD_API: ' custom-htd ', UNIVUS_APP_API: 'custom-app', UNIVUS_APP_VERSION: '2.99.0' }
  });
  assert.deepEqual(provider.getStatus(), { tokenSource: 'guest', tokenExpiresAt: null });
  assert.equal(await provider.getToken(), FMS_TOKEN);
  assert.equal(await provider.getToken(), FMS_TOKEN);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://myizaac2.nus.edu.sg/univus-public/mobile/get-access-token');
  assert.equal(calls[1].url, 'https://myizaac2.nus.edu.sg/univus/mobile/buswidget/get-init-data');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['X-HTD-API'], 'custom-htd');
  assert.equal(calls[0].options.headers['X-APP-API'], 'custom-app');
  assert.equal(calls[0].body.version, '2.99.0');
  assert.equal(calls[0].body.ipaddr, '0.0.0.0');
  assert.match(calls[0].body.deviceid, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(calls[1].body, { ...calls[0].body, ...access.data });
  assert.deepEqual(provider.getStatus(), { tokenSource: 'guest', tokenExpiresAt: new Date(NOW + DAY_MS).toISOString() });
  assert.equal(JSON.stringify(provider.getStatus()).includes(FMS_TOKEN), false);
  assert.equal(JSON.stringify(provider).includes(FMS_TOKEN), false);
});

test('concurrent guest requests share one bootstrap and initialization', async () => {
  const gate = deferred();
  const { provider, calls } = fakeProvider([() => gate.promise, initData()]);
  const tokens = Array.from({ length: 8 }, () => provider.getToken());
  assert.equal(calls.length, 1);
  gate.resolve(json(accessData()));
  assert.deepEqual(await Promise.all(tokens), Array(8).fill(FMS_TOKEN));
  assert.equal(calls.length, 2);
});

test('guest credentials renew five minutes before JWT expiry', async () => {
  let clock = NOW;
  const firstExpiry = NOW + 60 * 60 * 1000;
  const secondExpiry = NOW + 2 * 60 * 60 * 1000;
  const { provider, calls } = fakeProvider([
    accessData({ token: jwt(firstExpiry / 1000) }), initData('first-fms'),
    accessData({ token: jwt(secondExpiry / 1000) }), initData('renewed-fms')
  ], { now: () => clock });
  assert.equal(await provider.getToken(), 'first-fms');
  clock = firstExpiry - 5 * 60 * 1000 - 1;
  assert.equal(await provider.getToken(), 'first-fms');
  assert.equal(calls.length, 2);
  clock++;
  assert.equal(await provider.getToken(), 'renewed-fms');
  assert.equal(calls.length, 4);
  assert.equal(calls[2].body.deviceid, calls[0].body.deviceid);
  assert.equal(provider.getStatus().tokenExpiresAt, new Date(secondExpiry).toISOString());
});

test('cache lifetime is bounded by 24 hours and earlier FMS JWT expiration', async () => {
  const cases = [
    { access: jwt((NOW + 7 * DAY_MS) / 1000), fms: FMS_TOKEN, expires: NOW + DAY_MS },
    { access: 'opaque-access-token', fms: FMS_TOKEN, expires: NOW + DAY_MS },
    { access: 'a.invalid-json.c', fms: FMS_TOKEN, expires: NOW + DAY_MS },
    { access: jwt((NOW + DAY_MS) / 1000), fms: jwt((NOW + 3600000) / 1000), expires: NOW + 3600000 }
  ];
  for (const entry of cases) {
    const { provider } = fakeProvider([accessData({ token: entry.access }), initData(entry.fms)]);
    await provider.getToken();
    assert.equal(provider.getStatus().tokenExpiresAt, new Date(entry.expires).toISOString());
  }
});

test('expired access credentials fail before requesting bus initialization', async () => {
  const { provider, calls } = fakeProvider([accessData({ token: jwt(NOW / 1000) })]);
  await assert.rejects(provider.getToken(), error => error instanceof ProviderError && error.code === 'guest_auth_failed');
  assert.equal(calls.length, 1);
  assert.equal(provider.getStatus().tokenExpiresAt, null);
});

test('invalid guest identity and bootstrap shapes cannot authorize initialization', async () => {
  for (const payload of [null, [], {}, { data: [] }, { ...accessData(), code: '10000' }, accessData({ domain: 'NUSSTU' }),
    accessData({ userid: 'invalid-id' }), accessData({ token: '' }), accessData({ token: 'bad token' }),
    accessData({ token: { value: 'token' } })]) {
    const { provider, calls } = fakeProvider([payload]);
    await assert.rejects(provider.getToken(), { code: 'guest_auth_failed' });
    assert.equal(calls.length, 1);
    assert.equal(provider.getStatus().tokenExpiresAt, null);
  }
});

test('initialization requires nextbus_token2 and rejects deprecated or malformed tokens', async () => {
  for (const payload of [null, [], {}, { data: { tokens: [] } },
    { code: '00000', data: { tokens: { nextbus_token: FMS_TOKEN } } }, { ...initData(), code: '10000' }, initData(''), initData('bad token'),
    initData({ token: FMS_TOKEN }), initData(jwt((NOW - 1000) / 1000))]) {
    const { provider } = fakeProvider([accessData(), payload]);
    await assert.rejects(provider.getToken(), error => {
      assert.equal(error.message.includes(FMS_TOKEN), false);
      return error.code === 'guest_auth_failed';
    });
    assert.equal(provider.getStatus().tokenExpiresAt, null);
  }
});

test('failed initialization is not cached and the next request can recover', async () => {
  const { provider, calls } = fakeProvider([accessData(), {}, accessData(), initData()]);
  await assert.rejects(provider.getToken(), { code: 'guest_auth_failed' });
  assert.equal(await provider.getToken(), FMS_TOKEN);
  assert.equal(calls.length, 4);
});

test('invalidation forces renewal and obsolete work cannot overwrite a newer cache', async () => {
  const obsolete = deferred();
  let accessRequests = 0;
  const provider = new GuestTokenProvider({
    now: () => NOW, env: {},
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('get-access-token')) {
        accessRequests++;
        return accessRequests === 1 ? obsolete.promise : json(accessData());
      }
      const body = JSON.parse(options.body);
      return json(initData(body.token === 'old-access-token' ? 'obsolete-fms' : 'new-fms'));
    }
  });
  const oldRequest = provider.getToken();
  provider.invalidate();
  assert.equal(await provider.getToken(), 'new-fms');
  obsolete.resolve(json(accessData({ token: 'old-access-token' })));
  assert.equal(await oldRequest, 'obsolete-fms');
  assert.equal(await provider.getToken(), 'new-fms');
  assert.equal(accessRequests, 2);
  provider.invalidate();
  assert.equal(provider.getStatus().tokenExpiresAt, null);
  assert.equal(await provider.getToken(), 'new-fms');
  assert.equal(accessRequests, 3);
});

test('HTTP failures retain status classification without exposing provider bodies', async () => {
  await assert.rejects(requestProviderJson(`https://provider.invalid/?token=${FMS_TOKEN}`, {
    fetchImpl: async () => new Response(FMS_TOKEN, { status: 401 })
  }), error => {
    assert.equal(error.code, 'http_error');
    assert.equal(error.httpStatus, 401);
    assert.equal(error.statusCode, 401);
    assert.equal(error.message.includes(FMS_TOKEN), false);
    return true;
  });
  await assert.rejects(requestProviderJson('https://provider.invalid', {
    fetchImpl: async () => { throw new Error(`Network error containing ${FMS_TOKEN}`); }
  }), error => error.code === 'network_error' && !error.message.includes(FMS_TOKEN));
});

test('invalid JSON and empty bodies are classified without exposing their content', async () => {
  await assert.rejects(requestProviderJson('https://provider.invalid', {
    fetchImpl: async () => new Response(FMS_TOKEN)
  }), error => error.code === 'invalid_json' && !error.message.includes(FMS_TOKEN));
  await assert.rejects(requestProviderJson('https://provider.invalid', {
    fetchImpl: async () => new Response(null)
  }), { code: 'invalid_response' });
});

test('both advertised and streamed responses enforce the 2 MB size limit', async () => {
  for (const makeResponse of [
    () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        controller.close();
      }
    }))
  ]) {
    await assert.rejects(requestProviderJson('https://provider.invalid', {
      fetchImpl: async () => makeResponse()
    }), { code: 'response_too_large' });
  }
});

test('guest bootstrap timeout aborts stalled requests and remains retryable', async () => {
  let calls = 0;
  let signal;
  const { provider } = fakeProvider([], {
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1) { signal = options.signal; return new Promise(() => {}); }
      return json(calls === 2 ? accessData() : initData());
    }
  });
  await assert.rejects(provider.getToken(), { code: 'timeout' });
  assert.equal(signal.aborted, true);
  assert.equal(await provider.getToken(), FMS_TOKEN);
});

test('provider timeout also covers response streaming after HTTP headers arrive', async () => {
  let cancelled = false;
  await assert.rejects(requestProviderJson('https://provider.invalid', {
    timeoutMs: 5,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; }
    }))
  }), { code: 'timeout' });
  assert.equal(cancelled, true);
});
