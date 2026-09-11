import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

class ScheduledPollError extends Error {}

function trackerOrigin(value) {
  try {
    if (typeof value !== 'string' || !/^https:\/\/[^/?#\\\s@]+\/?$/i.test(value.trim())) throw new Error();
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new ScheduledPollError('Configure TRACKER_URL as an HTTPS origin without a path, query, fragment, or credentials.');
  }
}

function headerSecret(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw new ScheduledPollError(`Configure ${name} as a nonempty secret without line breaks.`);
  }
  return value;
}

/** Trigger one collection without requiring authentication. A failed response is never retried here. */
export async function pollScheduled({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const origin = trackerOrigin(env.TRACKER_URL);
  const headers = {};
  if (env.CRON_SECRET !== undefined && env.CRON_SECRET !== '') {
    const secret = headerSecret(env.CRON_SECRET, 'CRON_SECRET');
    headers.Authorization = `Bearer ${secret}`;
  }
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass !== undefined && bypass !== '') {
    headers['x-vercel-protection-bypass'] = headerSecret(bypass, 'VERCEL_AUTOMATION_BYPASS_SECRET');
  }

  let response;
  try {
    response = await fetchImpl(`${origin}/api/cron`, {
      method: 'GET', headers, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(70000)
    });
  } catch {
    throw new ScheduledPollError('Scheduled collection request failed or timed out.');
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Keep upstream errors private. */ }
    throw new ScheduledPollError('Scheduled collection returned an unsuccessful HTTP status.');
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new ScheduledPollError('Scheduled collection returned an invalid JSON response.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.success !== true) {
    throw new ScheduledPollError('Scheduled collection did not report success.');
  }
  if (!Number.isSafeInteger(payload.recordsCount) || payload.recordsCount < 0 ||
      !Number.isSafeInteger(payload.timestamp) || payload.timestamp < 0 ||
      !Number.isFinite(new Date(payload.timestamp).getTime())) {
    throw new ScheduledPollError('Scheduled collection returned invalid result metadata.');
  }
  return { recordsCount: payload.recordsCount, timestamp: new Date(payload.timestamp).toISOString() };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await pollScheduled())); }
  catch (error) {
    console.error(error instanceof ScheduledPollError ? error.message : 'Scheduled collection failed.');
    process.exitCode = 1;
  }
}
