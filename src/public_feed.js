import { normalizeBus } from './api_client.js';
import { ProviderError, requestProviderJson } from './provider_http.js';
import { ROUTE_CODES } from './routes.js';

const PUBLIC_BASE_URL = 'https://bus.hewliyang.com/api/stop/';
const MAX_AGE_MS = 2 * 60 * 1000;
const MAX_FUTURE_MS = 60 * 1000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalidResponse(message) {
  return new ProviderError(message, { code: 'invalid_response' });
}

function validateIdentifiers(values, maximum, pattern, label) {
  if (!Array.isArray(values) || !values.length || values.length > maximum ||
      values.some(value => typeof value !== 'string' || !pattern.test(value))) {
    throw new ProviderError(`Configure 1 to ${maximum} valid ${label} identifiers.`, { code: 'invalid_configuration' });
  }
  return [...new Set(values)];
}

function validatePayload(payload, stop, now) {
  if (!isObject(payload)) throw invalidResponse('Public arrivals returned an invalid response.');
  if (payload.degraded !== false) {
    throw new ProviderError('Public arrivals are degraded or their health is unknown.', { code: 'degraded_response' });
  }
  const etas = payload.etas;
  if (!isObject(etas) || etas.busStopName !== stop || !Array.isArray(etas.timings)) {
    throw invalidResponse('Public arrivals returned an unexpected stop or timing format.');
  }
  const reportedAt = typeof etas.lastUpdated === 'string' && ISO_TIMESTAMP.test(etas.lastUpdated)
    ? Date.parse(etas.lastUpdated) : NaN;
  if (!Number.isFinite(reportedAt) || now - reportedAt > MAX_AGE_MS || reportedAt - now > MAX_FUTURE_MS) {
    throw new ProviderError('Public arrivals timestamp is missing, invalid, or stale.', { code: 'stale_response' });
  }
  return { timings: etas.timings, reportedAt };
}

function normalizeSlot(timing, prefix, timestamp) {
  const value = timing[`${prefix}_veh_plate`];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) {
    throw invalidResponse('Public arrivals returned an invalid vehicle identifier.');
  }
  const plate = value.trim().toUpperCase();
  if (!plate) return null;
  const capacity = timing[`${prefix}_capacity`];
  const ridership = timing[`${prefix}_ridership`];
  for (const metric of [capacity, ridership]) {
    if (metric !== undefined && metric !== null && !['string', 'number'].includes(typeof metric)) {
      throw invalidResponse('Public arrivals returned invalid vehicle measurements.');
    }
  }
  return normalizeBus({ vehplate: plate, loadInfo: { capacity, ridership } }, timing.name, timestamp);
}

/**
 * Observe vehicles listed in arrivals at a small set of monitored stops.
 * Coverage is a subset of arriving buses, not a complete fleet census or GPS
 * feed. Predicted arrival times are never treated as measurement timestamps.
 * Every stop must return a fresh, healthy response before any records return.
 */
export async function fetchPublicObservations({
  fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000,
  stops = ['UTOWN', 'KR-MRT'], routes = ROUTE_CODES
} = {}) {
  const monitoredStops = validateIdentifiers(stops, 5, /^[A-Z0-9-]{1,20}$/, 'stop');
  const allowedRoutes = new Set(validateIdentifiers(routes, 20, /^[A-Z0-9-]{1,12}$/, 'route'));
  const timestamp = now();
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new ProviderError('Collection time is invalid.', { code: 'invalid_configuration' });
  }
  const responses = await Promise.allSettled(monitoredStops.map(async stop => {
    const payload = await requestProviderJson(PUBLIC_BASE_URL + encodeURIComponent(stop), { fetchImpl, timeoutMs });
    return validatePayload(payload, stop, now());
  }));
  const failure = responses.find(response => response.status === 'rejected');
  if (failure) throw failure.reason;

  const observed = new Map();
  const ambiguousPlates = new Set();
  for (const response of responses) {
    const { timings, reportedAt } = response.value;
    for (const timing of timings) {
      if (!isObject(timing) || typeof timing.name !== 'string' || !/^[A-Z0-9-]{1,12}$/.test(timing.name)) {
        throw invalidResponse('Public arrivals returned an invalid route timing.');
      }
      for (const prefix of ['arrivalTime', 'nextArrivalTime']) {
        const record = normalizeSlot(timing, prefix, timestamp);
        if (!record) continue;
        const existing = observed.get(record.vehplate);
        if (existing && existing.record.route_code !== record.route_code) ambiguousPlates.add(record.vehplate);
        const complete = record.capacity !== null && record.ridership !== null;
        if (!existing || Number(complete) > Number(existing.complete) ||
            complete === existing.complete && reportedAt > existing.reportedAt) {
          observed.set(record.vehplate, { record, complete, reportedAt });
        }
      }
    }
  }
  return [...observed.values()].map(value => value.record)
    .filter(record => allowedRoutes.has(record.route_code) && !ambiguousPlates.has(record.vehplate))
    .sort((left, right) => left.route_code.localeCompare(right.route_code) || left.vehplate.localeCompare(right.vehplate));
}
