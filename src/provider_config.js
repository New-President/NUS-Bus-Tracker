export function getProviderConfig(env = process.env, fallbackArg = false, legacyFallback = false) {
  const publicFallback = typeof fallbackArg === 'boolean' && legacyFallback ? legacyFallback : Boolean(fallbackArg);
  const mode = env.BUS_PROVIDER?.trim() || 'auto';
  if (!['auto', 'univus', 'community', 'connectx'].includes(mode)) {
    throw new Error('BUS_PROVIDER must be auto, univus, community, or connectx.');
  }
  const fallback = mode === 'auto' && publicFallback;
  const provider = mode === 'auto' ? (fallback ? 'community' : 'univus') : mode;
  if (provider === 'community') {
    const stops = [...new Set((env.BUS_STOPS || 'UTOWN,KR-MRT').split(',').map(stop => stop.trim().toUpperCase()))];
    if (!stops.length || stops.length > 5 || stops.some(stop => !/^[A-Z0-9-]{1,20}$/.test(stop))) {
      throw new Error('BUS_STOPS must contain 1 to 5 comma-separated stop identifiers.');
    }
    return {
      dataProvider: 'community', authMode: fallback ? 'guest' : 'public', coverage: 'stop-arrivals',
      sourceUrl: 'https://bus.hewliyang.com/', monitoredStops: stops,
      coverageNote: `Buses listed in arrivals at ${stops.join(' and ')}. Coverage is limited to these stops; locations are unavailable.`,
      providerWarning: fallback ? 'Direct uNivUS access is unavailable. Collecting public arrival observations and retrying direct access at the next poll.' : null
    };
  }
  if (provider === 'univus') return {
    dataProvider: 'univus', authMode: 'guest', coverage: 'route-fleet',
    sourceUrl: 'https://univus.nus.edu.sg/', monitoredStops: [],
    coverageNote: 'Vehicles reported directly by uNivUS for the configured routes.', providerWarning: null
  };
  return {
    dataProvider: 'connectx', authMode: 'guest', coverage: 'route-fleet',
    sourceUrl: 'https://fms.connectx.com.sg', monitoredStops: [],
    coverageNote: 'Vehicles reported by ConnectX for the configured routes.', providerWarning: null
  };
}
