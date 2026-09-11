import { ROUTE_CODES } from './routes.js';
import { ProviderError, requestProviderJson } from './provider_http.js';
export { ProviderError } from './provider_http.js';

const CONNECTX_BASE_URL = 'https://fms.connectx.com.sg/apiy/NUSETA';

export async function fetchLiveRouteBuses(routeCode, token, { fetchImpl = globalThis.fetch, timeoutMs = 8000, now = Date.now } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new ProviderError('A live access token is required.', { code: 'missing_token' });
  if (!/^[A-Z0-9-]{1,12}$/.test(routeCode)) throw new ProviderError('Invalid route identifier.');
  const url = new URL(`${CONNECTX_BASE_URL}/ActiveBus`);
  url.searchParams.set('route_code', routeCode);
  url.searchParams.set('token', token.trim());
  const payload = await requestProviderJson(url, { fetchImpl, timeoutMs });
  // Some provider failures arrive as HTTP 200, not an HTTP authorization error.
  if (payload?.result === false || payload?.error !== undefined && payload.error !== 0 && payload.error !== null) {
    if (payload.error === 4) {
      throw new ProviderError(`Route ${routeCode}: ConnectX returned error 4. Select BUS_PROVIDER=univus or clear the FMS override to use direct uNivUS guest access.`, { code: 'provider_response_error', providerCode: 4 });
    }
    const code = typeof payload.error === 'number' && Number.isFinite(payload.error) ? ` ${payload.error}` : '';
    throw new ProviderError(`Route ${routeCode}: live provider reported application error${code}.`, { code: 'provider_response_error' });
  }
  const result = payload?.ActiveBusResult;
  if (!Array.isArray(result?.activebus)) throw new ProviderError(`Route ${routeCode}: unexpected provider response format.`, { code: 'invalid_response' });
  const timestamp = result.Timestamp ?? result.TimeStamp;
  if (timestamp !== undefined && timestamp !== null) {
    const reportedAt = Date.parse(timestamp);
    if (!Number.isFinite(reportedAt) || now() - reportedAt > 15 * 60 * 1000 || reportedAt - now() > 60000) {
      throw new ProviderError(`Route ${routeCode}: provider timestamp is invalid or stale.`, { code: 'stale_response' });
    }
  }
  return result.activebus;
}
function numberOrNull(value, min, max, integer = false) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max && (!integer || Number.isInteger(number)) ? number : null;
}

export function normalizeBus(bus, routeCode, timestamp) {
  if (!bus || typeof bus !== 'object' || typeof bus.vehplate !== 'string' || !bus.vehplate.trim() || bus.vehplate.length > 64) {
    throw new ProviderError(`Route ${routeCode}: a vehicle is missing a valid identifier.`);
  }
  const load = bus.loadInfo || {};
  const capacity = numberOrNull(load.capacity, 1, 1000, true);
  const ridership = numberOrNull(load.ridership, 0, 1000, true);
  // Occupancy is a ratio. Derive it only when measured count and capacity both exist.
  const occupancy = numberOrNull(load.occupancy, 0, 2) ?? (capacity !== null && ridership !== null ? ridership / capacity : null);
  const reportedCrowd = typeof load.crowdLevel === 'string' ? load.crowdLevel.toLowerCase() : '';
  const crowd = occupancy !== null ? (occupancy >= 0.75 ? 'high' : occupancy >= 0.35 ? 'medium' : 'low')
    : ['low', 'medium', 'high'].includes(reportedCrowd) ? reportedCrowd : null;
  return {
    timestamp, time_iso: new Date(timestamp).toISOString(),
    time_str: new Date(timestamp + 8 * 3600000).toISOString().slice(11, 16),
    route_code: routeCode, vehplate: bus.vehplate.trim(),
    lat: numberOrNull(bus.lat, -90, 90), lng: numberOrNull(bus.lng, -180, 180),
    speed: numberOrNull(bus.speed, 0, 200), capacity, crowd_level: crowd, occupancy, ridership
  };
}

export async function fetchAllLiveBuses(token, { fetchRoute = fetchLiveRouteBuses, now = Date.now, routes = ROUTE_CODES, ...options } = {}) {
  const timestamp = now();
  const results = await Promise.allSettled(routes.map(route => fetchRoute(route, token, { ...options, now })));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason instanceof ProviderError ? failed.reason : new ProviderError('Unable to collect all configured routes.');
  const records = new Map();
  results.forEach((result, index) => {
    if (!Array.isArray(result.value)) throw new ProviderError(`Route ${routes[index]}: unexpected provider response format.`);
    for (const bus of result.value) {
      const record = normalizeBus(bus, routes[index], timestamp);
      // A vehicle can appear in overlapping route responses; count each plate once.
      if (!records.has(record.vehplate)) records.set(record.vehplate, record);
    }
  });
  return [...records.values()];
}

