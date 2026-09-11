export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const BUCKET_MS = 10 * 60 * 1000;

const POLL_BATCH_COLUMNS = `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    records_count INTEGER NOT NULL CHECK(records_count >= 0),
    source_provider TEXT NOT NULL DEFAULT 'connectx' CHECK(source_provider IN ('connectx', 'univus', 'community')),
    data_coverage TEXT NOT NULL DEFAULT 'route-fleet' CHECK(
      (source_provider IN ('connectx', 'univus') AND data_coverage = 'route-fleet') OR
      (source_provider = 'community' AND data_coverage = 'stop-arrivals')
    ),
    monitored_stops TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(monitored_stops) AND json_type(monitored_stops) = 'array')
`;

export const SNAPSHOT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS poll_batches (${POLL_BATCH_COLUMNS});
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_batch_id INTEGER NOT NULL REFERENCES poll_batches(id) ON DELETE CASCADE,
    timestamp INTEGER NOT NULL,
    time_iso TEXT NOT NULL,
    time_str TEXT NOT NULL,
    route_code TEXT NOT NULL,
    vehplate TEXT NOT NULL,
    lat REAL,
    lng REAL,
    speed REAL CHECK(speed IS NULL OR speed >= 0),
    capacity INTEGER CHECK(capacity IS NULL OR capacity > 0),
    crowd_level TEXT CHECK(crowd_level IS NULL OR crowd_level IN ('low', 'medium', 'high')),
    occupancy REAL CHECK(occupancy IS NULL OR occupancy >= 0),
    ridership INTEGER CHECK(ridership IS NULL OR ridership >= 0),
    UNIQUE(poll_batch_id, vehplate)
  );
`;

export const AGGREGATE_COLUMNS = `
  ROUND(AVG(ridership), 1) AS avg_ridership,
  ROUND(AVG(occupancy) * 100, 1) AS avg_occupancy_pct,
  COUNT(*) AS sample_count,
  COUNT(occupancy) AS occupancy_sample_count,
  COUNT(ridership) AS ridership_sample_count,
  COUNT(DISTINCT vehplate) AS active_buses
`;

function numberOrNull(value, field, minimum = 0, maximum = Infinity, integer = false) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value;
}

export function queryRange(startTimeMs, endTimeMs, defaultDuration) {
  const now = Date.now();
  const end = endTimeMs ?? now;
  const start = startTimeMs ?? Math.max(0, Math.min(end, now) - defaultDuration);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0) {
    throw new TypeError('Query timestamps must be non-negative integer milliseconds');
  }
  return { start, end: Math.min(end, now) };
}

function provenance(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('Poll metadata must be an object');
  const { dataProvider = 'connectx', coverage = 'route-fleet', monitoredStops = [] } = metadata;
  if (!((['connectx', 'univus'].includes(dataProvider) && coverage === 'route-fleet') ||
        (dataProvider === 'community' && coverage === 'stop-arrivals'))) {
    throw new TypeError('Invalid provider and coverage combination');
  }
  if (!Array.isArray(monitoredStops) || monitoredStops.length > 5 ||
      monitoredStops.some(stop => typeof stop !== 'string' || !/^[A-Z0-9-]{1,20}$/.test(stop)) ||
      (dataProvider === 'community' ? monitoredStops.length === 0 : monitoredStops.length !== 0)) {
    throw new TypeError('Invalid monitored stops for poll coverage');
  }
  return { dataProvider, coverage, monitoredStops: JSON.stringify([...new Set(monitoredStops)].sort()) };
}

export function normalizePoll(records, timestamp, metadata) {
  if (!Array.isArray(records)) throw new TypeError('Poll records must be an array');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > Date.now()) {
    throw new TypeError('Poll timestamp must be valid and cannot be in the future');
  }
  const source = provenance(metadata);
  const timeIso = new Date(timestamp).toISOString();
  const timeStr = new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(11, 16);
  const normalized = records.map(record => {
    if (!record || typeof record.route_code !== 'string' || !record.route_code.trim() || typeof record.vehplate !== 'string' || !record.vehplate.trim()) {
      throw new TypeError('Each bus must have a route code and vehicle plate');
    }
    const crowd = record.crowd_level ?? null;
    if (crowd !== null && !['low', 'medium', 'high'].includes(crowd)) throw new TypeError('Invalid crowd_level');
    return [
      timestamp, timeIso, timeStr, record.route_code.trim(), record.vehplate.trim(),
      numberOrNull(record.lat, 'lat', -90, 90),
      numberOrNull(record.lng, 'lng', -180, 180),
      numberOrNull(record.speed, 'speed'),
      numberOrNull(record.capacity, 'capacity', 1, Infinity, true),
      crowd,
      numberOrNull(record.occupancy, 'occupancy'),
      numberOrNull(record.ridership, 'ridership', 0, Infinity, true)
    ];
  });
  return { source, normalized };
}
