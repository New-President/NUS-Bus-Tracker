import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_SERVERLESS = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const DEFAULT_DB_PATH = path.join(IS_SERVERLESS ? os.tmpdir() : path.join(PROJECT_DIR, 'data'), 'bus_tracker.db');
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 10 * 60 * 1000;

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

const SNAPSHOT_SCHEMA = `
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

const AGGREGATE_COLUMNS = `
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

function queryRange(startTimeMs, endTimeMs, defaultDuration) {
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

export class BusDatabase {
  constructor(dbPath = process.env.BUS_DB_PATH || DEFAULT_DB_PATH) {
    this.dbPath = dbPath === ':memory:' ? dbPath : path.resolve(PROJECT_DIR, dbPath);
    this.storage = {
      type: this.dbPath === ':memory:' ? 'memory' : IS_SERVERLESS ? 'ephemeral' : 'persistent',
      persistent: this.dbPath !== ':memory:' && !IS_SERVERLESS
    };
    if (this.dbPath !== ':memory:') fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA journal_mode = WAL;');
      this.initSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  initSchema() {
    if (this.db.prepare('PRAGMA user_version').get().user_version > 4) throw new Error('Database schema is newer than this application supports');
    this.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    const columns = this.db.prepare('PRAGMA table_info(snapshots)').all();
    // The retired source column is consulted only for this one-time data migration.
    if (columns.some(column => column.name === 'is_mock')) {
      this.migrateLegacySnapshots();
    } else {
      this.db.exec(SNAPSHOT_SCHEMA);
    }
    this.migrateBatchProvenance();
    this.migrateDirectSources();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_snapshots_route_time ON snapshots(route_code, timestamp);
      CREATE INDEX IF NOT EXISTS idx_snapshots_vehicle_time ON snapshots(vehplate, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_poll_batches_time ON poll_batches(timestamp DESC, id DESC);
    `);
    this.deleteSetting('mode');
    for (const [key, value] of Object.entries({ polling_interval_ms: '600000', last_polled_at: '0', fms_token: '' })) {
      if (this.getSetting(key) === null) this.setSetting(key, value);
    }
  }

  migrateBatchProvenance() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 3) return;
    const columns = new Set(this.db.prepare('PRAGMA table_info(poll_batches)').all().map(column => column.name));
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (!columns.has('source_provider')) {
        this.db.exec("ALTER TABLE poll_batches ADD COLUMN source_provider TEXT NOT NULL DEFAULT 'connectx' CHECK(source_provider IN ('connectx', 'community'));");
      }
      if (!columns.has('data_coverage')) {
        this.db.exec(`ALTER TABLE poll_batches ADD COLUMN data_coverage TEXT NOT NULL DEFAULT 'route-fleet' CHECK(
          (source_provider = 'connectx' AND data_coverage = 'route-fleet') OR
          (source_provider = 'community' AND data_coverage = 'stop-arrivals')
        );`);
      }
      if (!columns.has('monitored_stops')) {
        this.db.exec("ALTER TABLE poll_batches ADD COLUMN monitored_stops TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(monitored_stops) AND json_type(monitored_stops) = 'array');");
      }
      this.db.exec('PRAGMA user_version = 3; COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  migrateDirectSources() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 4) return;
    const foreignKeys = this.db.prepare('PRAGMA foreign_keys').get().foreign_keys;
    // SQLite cannot widen an existing CHECK constraint. Rebuild the parent
    // table with enforcement temporarily disabled so retained snapshots do not
    // cascade-delete; validate all references before committing the replacement.
    this.db.exec('PRAGMA foreign_keys = OFF;');
    let transaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE;');
      transaction = true;
      const dependentSchema = this.db.prepare(`
        SELECT sql FROM sqlite_schema
        WHERE tbl_name = 'poll_batches' AND type IN ('index', 'trigger') AND sql IS NOT NULL
        ORDER BY type, name
      `).all();
      const sequence = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'poll_batches'").get();
      this.db.exec(`
        CREATE TABLE poll_batches_v4 (${POLL_BATCH_COLUMNS});
        INSERT INTO poll_batches_v4(id, timestamp, records_count, source_provider, data_coverage, monitored_stops)
          SELECT id, timestamp, records_count, source_provider, data_coverage, monitored_stops FROM poll_batches;
        DROP TABLE poll_batches;
        ALTER TABLE poll_batches_v4 RENAME TO poll_batches;
      `);
      for (const entry of dependentSchema) this.db.exec(entry.sql);
      if (sequence) {
        this.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'poll_batches'").run();
        this.db.prepare('INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)').run('poll_batches', sequence.seq);
      }
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error('Cannot migrate poll sources while foreign key references are invalid');
      }
      this.db.exec('PRAGMA user_version = 4; COMMIT;');
      transaction = false;
    } catch (error) {
      if (transaction) this.db.exec('ROLLBACK;');
      throw error;
    } finally {
      this.db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'};`);
    }
  }

  // Only the former source flag proves that a legacy row came from the provider.
  migrateLegacySnapshots() {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.exec(`ALTER TABLE snapshots RENAME TO legacy_snapshots; ${SNAPSHOT_SCHEMA}`);
      const validRows = `
        is_mock = 0 AND timestamp >= 0 AND timestamp <= ?
        AND TRIM(route_code) <> '' AND TRIM(vehplate) <> '' AND vehplate <> 'PC-UNKNOWN'
      `;
      this.db.prepare(`
        INSERT INTO poll_batches(timestamp, records_count)
        SELECT timestamp, COUNT(DISTINCT vehplate) FROM legacy_snapshots
        WHERE ${validRows} GROUP BY timestamp ORDER BY timestamp
      `).run(now);
      // Former defaults are ambiguous; preserve positive measurements without inventing missing load.
      this.db.prepare(`
        INSERT INTO snapshots (
          id, poll_batch_id, timestamp, time_iso, time_str, route_code, vehplate,
          lat, lng, speed, capacity, crowd_level, occupancy, ridership
        )
        SELECT s.id, p.id, s.timestamp,
          strftime('%Y-%m-%dT%H:%M:%fZ', s.timestamp / 1000.0, 'unixepoch'),
          strftime('%H:%M', s.timestamp / 1000.0, 'unixepoch', '+8 hours'),
          s.route_code, s.vehplate,
          CASE WHEN s.lat BETWEEN -90 AND 90 THEN s.lat END,
          CASE WHEN s.lng BETWEEN -180 AND 180 THEN s.lng END,
          CASE WHEN s.speed > 0 THEN s.speed END,
          CASE WHEN s.capacity > 0 AND s.capacity <> 70 THEN s.capacity END,
          CASE WHEN s.occupancy > 0 THEN
            CASE WHEN s.occupancy >= 0.75 THEN 'high' WHEN s.occupancy >= 0.35 THEN 'medium' ELSE 'low' END
          END,
          CASE WHEN s.occupancy > 0 THEN s.occupancy END,
          CASE WHEN s.ridership > 0 AND s.ridership <> ROUND(s.occupancy * s.capacity) THEN s.ridership END
        FROM legacy_snapshots s
        JOIN poll_batches p ON p.timestamp = s.timestamp
        WHERE s.id IN (
          SELECT MAX(id) FROM legacy_snapshots WHERE ${validRows} GROUP BY timestamp, vehplate
        )
      `).run(now);
      this.db.exec('DROP TABLE legacy_snapshots; DELETE FROM settings WHERE key NOT IN (\'fms_token\', \'polling_interval_ms\');');
      const latest = this.db.prepare('SELECT MAX(timestamp) AS timestamp FROM poll_batches').get();
      this.setSetting('last_polled_at', latest.timestamp ?? 0);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    // Reclaim obsolete pages after migration, including their former row contents.
    this.db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  deleteSetting(key) {
    return this.db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes;
  }

  /** Persist a complete, successful provider response, including an empty fleet. */
  recordPoll(records, timestamp = Date.now(), metadata = {}) {
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
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = this.db.prepare(`
        INSERT INTO poll_batches(timestamp, records_count, source_provider, data_coverage, monitored_stops)
        VALUES (?, ?, ?, ?, ?)
      `).run(timestamp, records.length, source.dataProvider, source.coverage, source.monitoredStops);
      const batchId = Number(result.lastInsertRowid);
      const statement = this.db.prepare(`
        INSERT INTO snapshots (
          poll_batch_id, timestamp, time_iso, time_str, route_code, vehplate,
          lat, lng, speed, capacity, crowd_level, occupancy, ridership
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const record of normalized) statement.run(batchId, ...record);
      const latest = this.db.prepare('SELECT MAX(timestamp) AS timestamp FROM poll_batches').get();
      this.setSetting('last_polled_at', latest.timestamp);
      this.db.exec('COMMIT;');
      return { batchId, recordsCount: records.length, timestamp };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  getLatestPoll(nowMs = Date.now()) {
    return this.db.prepare('SELECT * FROM poll_batches WHERE timestamp <= ? ORDER BY timestamp DESC, id DESC LIMIT 1').get(nowMs) ?? null;
  }

  getLatestLiveBuses(nowMs = Date.now()) {
    const batch = this.getLatestPoll(nowMs);
    if (!batch || batch.timestamp < nowMs - ACTIVE_WINDOW_MS) return [];
    return this.db.prepare(`
      SELECT s.*, p.source_provider, p.data_coverage, p.monitored_stops
      FROM snapshots s JOIN poll_batches p ON p.id = s.poll_batch_id
      WHERE s.poll_batch_id = ? AND s.timestamp <= ? ORDER BY s.route_code, s.vehplate
    `).all(batch.id, nowMs);
  }

  /** Observed vehicles with their last known values; freshness never invents a location. */
  getAllFleetStatus(nowMs = Date.now()) {
    const latestBatch = this.getLatestPoll(nowMs);
    const fresh = latestBatch && latestBatch.timestamp >= nowMs - ACTIVE_WINDOW_MS;
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT s.*, p.source_provider, p.data_coverage, p.monitored_stops,
          ROW_NUMBER() OVER (PARTITION BY s.vehplate ORDER BY s.timestamp DESC, s.poll_batch_id DESC, s.id DESC) AS vehicle_rank
        FROM snapshots s JOIN poll_batches p ON p.id = s.poll_batch_id WHERE s.timestamp <= ? AND p.timestamp <= ?
      ) WHERE vehicle_rank = 1 ORDER BY route_code, vehplate
    `).all(nowMs, nowMs);
    return rows.map(({ vehicle_rank, ...record }) => ({
      ...record,
      status: !fresh ? 'stale' : record.poll_batch_id === latestBatch.id ? 'active' : 'inactive',
      last_seen_at: record.timestamp
    }));
  }

  getTotalSnapshotsCount() {
    return this.db.prepare('SELECT COUNT(*) AS count FROM snapshots WHERE timestamp <= ?').get(Date.now()).count;
  }

  /** Successful collection coverage, including batches that reported no buses. */
  getDataSources(startTimeMs, endTimeMs) {
    const range = queryRange(startTimeMs, endTimeMs, 7 * DAY_MS);
    return this.db.prepare(`
      SELECT source_provider, data_coverage, monitored_stops,
        COUNT(*) AS batch_count, SUM(records_count) AS records_count,
        MIN(timestamp) AS first_observed_at, MAX(timestamp) AS last_observed_at
      FROM poll_batches WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY source_provider, data_coverage, monitored_stops
      ORDER BY source_provider, data_coverage, monitored_stops
    `).all(range.start, range.end).map(row => ({
      dataProvider: row.source_provider, coverage: row.data_coverage,
      monitoredStops: JSON.parse(row.monitored_stops), batchCount: row.batch_count,
      recordsCount: row.records_count, firstObservedAt: row.first_observed_at, lastObservedAt: row.last_observed_at
    }));
  }

  get24HourHistory(startTimeMs, endTimeMs) {
    const range = queryRange(startTimeMs, endTimeMs, DAY_MS);
    const select = `
      CAST(timestamp / ${BUCKET_MS} AS INTEGER) * ${BUCKET_MS} AS bucket_ts,
      ${AGGREGATE_COLUMNS},
      strftime('%H:%M', CAST(timestamp / ${BUCKET_MS} AS INTEGER) * ${BUCKET_MS} / 1000, 'unixepoch', '+8 hours') AS time_str,
      strftime('%Y-%m-%dT%H:%M:%fZ', CAST(timestamp / ${BUCKET_MS} AS INTEGER) * ${BUCKET_MS} / 1000, 'unixepoch') AS time_iso
    `;
    const routeData = this.db.prepare(`
      SELECT ${select}, route_code FROM snapshots
      WHERE timestamp >= ? AND timestamp <= ? GROUP BY bucket_ts, route_code ORDER BY bucket_ts, route_code
    `).all(range.start, range.end);
    const campusData = this.db.prepare(`
      SELECT ${select} FROM snapshots
      WHERE timestamp >= ? AND timestamp <= ? GROUP BY bucket_ts ORDER BY bucket_ts
    `).all(range.start, range.end);
    return { routeData, campusData };
  }

  getAvailableDates() {
    return this.db.prepare(`
      SELECT DISTINCT date(timestamp / 1000, 'unixepoch', '+8 hours') AS date
      FROM snapshots WHERE timestamp <= ? ORDER BY date DESC
    `).all(Date.now()).map(row => row.date);
  }

  getCommuteOptimizationAnalytics(startTimeMs, endTimeMs) {
    const range = queryRange(startTimeMs, endTimeMs, 7 * DAY_MS);
    const select = `
      CAST(strftime('%H', timestamp / 1000, 'unixepoch', '+8 hours') AS INTEGER) AS hour,
      ${AGGREGATE_COLUMNS},
      CASE
        WHEN AVG(occupancy) IS NULL THEN NULL
        WHEN AVG(occupancy) < 0.35 THEN 'low'
        WHEN AVG(occupancy) < 0.75 THEN 'medium'
        ELSE 'high'
      END AS crowd_level
    `;
    const hourlyData = this.db.prepare(`
      SELECT ${select}, route_code FROM snapshots
      WHERE timestamp >= ? AND timestamp <= ? GROUP BY hour, route_code ORDER BY hour, route_code
    `).all(range.start, range.end);
    const campusHourly = this.db.prepare(`
      SELECT ${select} FROM snapshots
      WHERE timestamp >= ? AND timestamp <= ? GROUP BY hour ORDER BY hour
    `).all(range.start, range.end);
    const measuredHours = campusHourly.filter(row => row.occupancy_sample_count > 0);
    return {
      hourlyData,
      campusHourly,
      busiestHours: [...measuredHours].sort((a, b) => b.avg_occupancy_pct - a.avg_occupancy_pct || a.hour - b.hour).slice(0, 3),
      bestWindows: [...measuredHours].sort((a, b) => a.avg_occupancy_pct - b.avg_occupancy_pct || a.hour - b.hour).slice(0, 3),
      queryRange: range,
      timezone: 'Asia/Singapore'
    };
  }

  getHourlyAnalytics(startTimeMs, endTimeMs) {
    return this.getCommuteOptimizationAnalytics(startTimeMs, endTimeMs);
  }

  getExportRows(limit = 10000) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new RangeError('Export limit must be between 1 and 100000');
    const now = Date.now();
    return this.db.prepare(`
      SELECT s.timestamp, s.time_iso, s.time_str, s.route_code, s.vehplate, s.lat, s.lng, s.speed,
        s.capacity, s.crowd_level, s.occupancy, s.ridership, p.source_provider, p.data_coverage, p.monitored_stops
      FROM snapshots s JOIN poll_batches p ON p.id = s.poll_batch_id
      WHERE s.timestamp <= ? AND p.timestamp <= ? ORDER BY s.timestamp DESC, s.id DESC LIMIT ?
    `).all(now, now, limit);
  }

  clearAllSnapshots() {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const { changes } = this.db.prepare('DELETE FROM snapshots').run();
      this.db.exec('DELETE FROM poll_batches;');
      this.setSetting('last_polled_at', 0);
      this.db.exec('COMMIT;');
      return changes;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const dbInstance = new BusDatabase();
