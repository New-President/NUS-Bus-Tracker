import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pollScheduled } from '../scripts/poll_scheduled.js';

const env = { TRACKER_URL: 'https://tracker.example', CRON_SECRET: 'private-cron-secret' };
const timestamp = Date.parse('2026-09-11T12:30:00.000Z');
const result = { success: true, recordsCount: 9, timestamp };
const json = payload => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });

test('scheduled polling authorizes exactly one nonredirecting request and returns only validated result metadata', async () => {
  let calls = 0;
  const actual = await pollScheduled({ env, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://tracker.example/api/cron');
    assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { Authorization: 'Bearer private-cron-secret' });
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.body, undefined);
    return json({ ...result, error: 'private response details', url, secret: env.CRON_SECRET });
  } });
  assert.equal(calls, 1);
  assert.deepEqual(actual, { recordsCount: 9, timestamp: '2026-09-11T12:30:00.000Z' });
});

test('a protected Vercel deployment receives the optional bypass header, and empty successful collections remain valid', async () => {
  const actual = await pollScheduled({
    env: { ...env, TRACKER_URL: 'https://tracker.example/', VERCEL_AUTOMATION_BYPASS_SECRET: 'private-bypass-secret' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://tracker.example/api/cron');
      assert.equal(options.headers.Authorization, 'Bearer private-cron-secret');
      assert.equal(options.headers['x-vercel-protection-bypass'], 'private-bypass-secret');
      return json({ ...result, recordsCount: 0 });
    }
  });
  assert.equal(actual.recordsCount, 0);
});

test('unsafe or incomplete origin and secret configuration is rejected before sending a request', async () => {
  const invalid = [
    ...[undefined, '', 'tracker.example', 'http://tracker.example', 'https:tracker.example',
      'https://user:password@tracker.example', 'https://@tracker.example', 'https://tracker.example/dashboard',
      'https://tracker.example//', 'https://tracker.example/path/..',
      'https://tracker.example?', 'https://tracker.example#', 'https://tracker.example?token=private',
      'https://tracker.example/#private'].map(TRACKER_URL => ({ ...env, TRACKER_URL })),
    ...[undefined, '', ' ', 'private\rheader', 'private\nheader'].map(CRON_SECRET => ({ ...env, CRON_SECRET })),
    ...['private\rheader', 'private\nheader', ' '].map(VERCEL_AUTOMATION_BYPASS_SECRET => ({ ...env, VERCEL_AUTOMATION_BYPASS_SECRET }))
  ];
  for (const invalidEnv of invalid) {
    await assert.rejects(pollScheduled({ env: invalidEnv, fetchImpl: () => assert.fail('Invalid configuration must not reach the network') }), error => {
      assert.match(error.message, /^Configure (TRACKER_URL|CRON_SECRET|VERCEL_AUTOMATION_BYPASS_SECRET)/);
      assert.doesNotMatch(error.message, /private|password|tracker\.example/);
      return true;
    });
  }
});

test('request failures are not retried and their messages cannot expose secrets or endpoints', async () => {
  let calls = 0;
  await assert.rejects(pollScheduled({ env, fetchImpl: async () => {
    calls++;
    throw new Error(`network failed for ${env.TRACKER_URL} Authorization: ${env.CRON_SECRET}`);
  } }), { message: 'Scheduled collection request failed or timed out.' });
  assert.equal(calls, 1);
});

test('HTTP errors, failed collections and non-JSON responses fail safely without retrying or printing their body', async () => {
  for (const [response, message] of [
    [new Response(`Unauthorized ${env.CRON_SECRET}`, { status: 401 }), 'Scheduled collection returned an unsuccessful HTTP status.'],
    [new Response('Deployment protection redirect', { status: 307 }), 'Scheduled collection returned an unsuccessful HTTP status.'],
    [json({ success: false, error: `provider failed: ${env.CRON_SECRET}` }), 'Scheduled collection did not report success.'],
    [new Response(`<html>${env.CRON_SECRET}</html>`), 'Scheduled collection returned an invalid JSON response.'],
    [json(null), 'Scheduled collection did not report success.'],
    [json([]), 'Scheduled collection did not report success.'],
    [json({ ...result, success: 'true' }), 'Scheduled collection did not report success.']
  ]) {
    let calls = 0;
    await assert.rejects(pollScheduled({ env, fetchImpl: async () => { calls++; return response; } }), { message });
    assert.equal(calls, 1);
  }
});

test('success requires a nonnegative integer count and a representable integer timestamp', async () => {
  const invalid = [
    ...[undefined, -1, 0.5, '9', Number.MAX_SAFE_INTEGER + 1].map(recordsCount => ({ ...result, recordsCount })),
    ...[undefined, -1, 0.5, '2026-09-11T12:30:00.000Z', 8640000000000001].map(timestamp => ({ ...result, timestamp }))
  ];
  for (const payload of invalid) {
    await assert.rejects(pollScheduled({ env, fetchImpl: async () => json(payload) }), {
      message: 'Scheduled collection returned invalid result metadata.'
    });
  }
});

test('the CLI exits unsuccessfully with a safe configuration diagnostic and no stack trace', () => {
  const childEnv = { ...process.env };
  delete childEnv.TRACKER_URL;
  delete childEnv.CRON_SECRET;
  delete childEnv.VERCEL_AUTOMATION_BYPASS_SECRET;
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/poll_scheduled.js', import.meta.url))], {
    env: childEnv, encoding: 'utf8'
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr.trim(), 'Configure TRACKER_URL as an HTTPS origin without a path, query, fragment, or credentials.');
});
