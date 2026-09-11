import { GuestTokenProvider } from '../src/univus_auth.js';
import { UnivusClient } from '../src/univus_client.js';
import { fetchAllLiveBuses, ProviderError } from '../src/api_client.js';
import { ROUTE_CODES } from '../src/routes.js';
import { fetchPublicObservations } from '../src/public_feed.js';
import { getProviderConfig } from '../src/provider_config.js';

// One configured route, or public stops on fallback; no database imports or writes.
const route = ROUTE_CODES[0];
const forced = process.argv.includes('--connectx') ? 'connectx' : process.argv.includes('--direct') ? 'univus' : null;
const env = forced ? { ...process.env, BUS_PROVIDER: forced } : process.env;
try {
  let source = getProviderConfig(env, Boolean(env.FMS_TOKEN?.trim()));
  let records;
  if (source.dataProvider === 'univus') {
    const client = new UnivusClient();
    try {
      await client.ensureSession();
      console.log(JSON.stringify({ stage: 'authentication', success: true, authMode: 'guest', ...client.getStatus() }));
      records = await client.fetchBuses({ routes: [route] });
    } catch (error) {
      if ((env.BUS_PROVIDER?.trim() || 'auto') !== 'auto' || !(error instanceof ProviderError)) throw error;
      source = getProviderConfig(env, false, true);
      console.log(JSON.stringify({ stage: 'direct-feed', success: false, code: error.code, warning: source.providerWarning }));
    }
  } else if (source.dataProvider === 'connectx') {
    const provider = new GuestTokenProvider();
    const token = env.FMS_TOKEN?.trim() || await provider.getToken();
    console.log(JSON.stringify({ stage: 'authentication', success: true, authMode: source.authMode,
      tokenExpiresAt: source.authMode === 'guest' ? provider.getStatus().tokenExpiresAt : null }));
    records = await fetchAllLiveBuses(token, { routes: [route] });
  }
  if (source.dataProvider === 'community') records = await fetchPublicObservations({ stops: source.monitoredStops });
  console.log(JSON.stringify({ stage: 'observations', success: true, ...source, recordsCount: records.length,
    passengerReadings: records.filter(record => record.ridership !== null).length,
    occupancyReadings: records.filter(record => record.occupancy !== null).length,
    gpsReadings: records.filter(record => record.lat !== null && record.lng !== null).length }));
} catch (error) {
  console.error(JSON.stringify({ success: false, route,
    code: error instanceof ProviderError ? error.code : 'unexpected_error',
    error: error instanceof ProviderError ? error.message : 'Unable to verify the live feed.' }));
  process.exitCode = 1;
}
