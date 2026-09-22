import { createClient } from '@libsql/client/web';
import { ACTIVE_WINDOW_MS, DAY_MS, BUCKET_MS, SNAPSHOT_SCHEMA, AGGREGATE_COLUMNS, queryRange, normalizePoll } from './db_shared.js';

const SETTINGS_SCHEMA = 'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)';
const SCHEMA_VERSION = 4;
const VERSION_SCHEMA = `CREATE TABLE IF NOT EXISTS bus_schema_version (
  id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL
)`;
const REQUIRED_COLUMNS = {
  settings: ['key', 'value'],
  poll_batches: ['id', 'timestamp', 'records_count', 'source_provider', 'data_coverage', 'monitored_stops'],
  snapshots: ['id', 'poll_batch_id', 'timestamp', 'time_iso', 'time_str', 'route_code', 'vehplate',
    'lat', 'lng', 'speed', 'capacity', 'crowd_level', 'occupancy', 'ridership']
};
const SET_SETTING_SQL = `INSERT INTO settings(key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

function remoteConfig(url, authToken) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new TypeError('TURSO_DATABASE_URL must be a secure libsql:// or https:// URL'); }
  if (!['libsql:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password ||
      parsed.search || parsed.hash) {
    throw new TypeError('TURSO_DATABASE_URL must be a secure libsql:// or https:// URL without credentials or query parameters');
  }
  if (typeof authToken !== 'string' || !authToken.trim()) throw new TypeError('TURSO_AUTH_TOKEN is required with TURSO_DATABASE_URL');
  return { url: parsed.toString(), authToken: authToken.trim(), intMode: 'number' };
}

/** Durable, shared libSQL storage. Every operation awaits lazy schema initialization. */
export class RemoteBusDatabase {
  constructor({ url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN, client } = {}) {
    // Injection permits offline SQL tests without weakening production URL validation.
    this.client = client || createClient(remoteConfig(url, authToken));
    this.storage = { type: 'turso', persistent: true };
    this.initialization = null;
    this.closed = false;
    this._cache = {
      totalSnapshots: undefined,
      totalSnapshotsTime: 0,
      availableDates: null,
      availableDatesTime: 0,
      fleet: null,
      fleetTime: 0,
      fleetNowMs: 0
    };
  }

  _invalidateCache() {
    this._cache.totalSnapshots = undefined;
    this._cache.availableDates = null;
    this._cache.fleet = null;
  }

  async ready() {
    if (this.closed) throw new Error('Database is closed');
    if (!this.initialization) {
      this.initialization = this.initSchema().catch(error => {
        this.initialization = null;
        throw error;
      });
    }
    await this.initialization;
  }

  async initSchema() {
    const tables = Object.keys(REQUIRED_COLUMNS);
    const [legacyVersionResult, versionColumns, ...columnResults] = await this.client.batch([
      'PRAGMA user_version', 'PRAGMA table_info(bus_schema_version)',
      ...tables.map(table => `PRAGMA table_info(${table})`)
    ], 'read');
    // Turso Cloud exposes user_version as read-only. Retain its query only to
    // recognize existing version 4 imports; new databases use our own table.
    const legacyVersion = Number(legacyVersionResult.rows[0].user_version);
    let version = legacyVersion;
    const hasVersionTable = versionColumns.rows.length > 0;
    if (hasVersionTable) {
      const columns = new Set(versionColumns.rows.map(row => row.name));
      if (!columns.has('id') || !columns.has('version')) {
        throw new Error('Unsupported remote database schema for bus_schema_version');
      }
      const result = await this.client.execute('SELECT id, version FROM bus_schema_version');
      if (result.rows.length !== 1 || result.rows[0].id !== 1 || !Number.isSafeInteger(result.rows[0].version)) {
        throw new Error('Unsupported remote database schema version metadata');
      }
      version = result.rows[0].version;
    }
    const existing = columnResults.some(result => result.rows.length > 0);
    if (version > SCHEMA_VERSION || legacyVersion > SCHEMA_VERSION) {
      throw new Error('Database schema is newer than this application supports');
    }
    if ((existing && version !== SCHEMA_VERSION) || (!existing && (hasVersionTable || version !== 0))) {
      throw new Error('Unsupported remote database schema. Use a fresh Turso database or import a compatible version 4 schema.');
    }
    if (existing) {
      for (const [index, table] of tables.entries()) {
        const columns = new Set(columnResults[index].rows.map(row => row.name));
        if (REQUIRED_COLUMNS[table].some(column => !columns.has(column)) || columns.has('is_mock')) {
          throw new Error(`Unsupported remote database schema for ${table}`);
        }
      }
    }
    // One atomic, idempotent bootstrap allows simultaneous cold starts. Defaults
    // never overwrite settings already saved by another function instance.
    await this.client.batch([
      VERSION_SCHEMA, SETTINGS_SCHEMA, ...SNAPSHOT_SCHEMA.split(';').map(sql => sql.trim()).filter(Boolean),
      'CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_snapshots_route_time ON snapshots(route_code, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_snapshots_vehicle_time ON snapshots(vehplate, timestamp DESC, id DESC)',
      'CREATE INDEX IF NOT EXISTS idx_snapshots_poll_batch ON snapshots(poll_batch_id)',
      'CREATE INDEX IF NOT EXISTS idx_poll_batches_time ON poll_batches(timestamp DESC, id DESC)',
      ...Object.entries({ last_polled_at: '0' }).map(([key, value]) => ({
        sql: 'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', args: [key, value]
      })),
      {
        sql: 'INSERT INTO bus_schema_version(id, version) VALUES (1, ?) ON CONFLICT(id) DO NOTHING',
        args: [SCHEMA_VERSION]
      }
    ], 'write');
  }

  async rows(sql, args = []) {
    await this.ready();
    const result = await this.client.execute({ sql, args });
    return result.rows.map(row => ({ ...row }));
  }

  async getSetting(key) {
    return (await this.rows('SELECT value FROM settings WHERE key = ?', [key]))[0]?.value ?? null;
  }

  async getSettings(keys = []) {
    if (!Array.isArray(keys) || keys.length === 0) return {};
    const placeholders = keys.map(() => '?').join(', ');
    const rows = await this.rows(`SELECT key, value FROM settings WHERE key IN (${placeholders})`, keys);
    const result = {};
    for (const key of keys) result[key] = null;
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  async setSetting(key, value) {
    await this.ready();
    await this.client.execute({ sql: SET_SETTING_SQL, args: [key, String(value)] });
  }

  async deleteSetting(key) {
    await this.ready();
    return (await this.client.execute({ sql: 'DELETE FROM settings WHERE key = ?', args: [key] })).rowsAffected;
  }

  /** Persist an entire successful response, including empty fleets, in one transaction. */
  async recordPoll(records, timestamp = Date.now(), metadata = {}) {
    const { source, normalized } = normalizePoll(records, timestamp, metadata);
    await this.ready();
    const results = await this.client.batch([
      {
        sql: `INSERT INTO poll_batches(timestamp, records_count, source_provider, data_coverage, monitored_stops)
          VALUES (?, ?, ?, ?, ?)`,
        args: [timestamp, records.length, source.dataProvider, source.coverage, source.monitoredStops]
      },
      ...normalized.map(record => ({
        // Write transactions serialize writers. The newest parent ID remains
        // this batch's ID even after snapshot inserts change last_insert_rowid().
        sql: `INSERT INTO snapshots (
          poll_batch_id, timestamp, time_iso, time_str, route_code, vehplate,
          lat, lng, speed, capacity, crowd_level, occupancy, ridership
        ) VALUES ((SELECT MAX(id) FROM poll_batches), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: record
      })),
      {
        sql: `INSERT INTO settings(key, value)
          SELECT 'last_polled_at', CAST(MAX(timestamp) AS TEXT) FROM poll_batches WHERE true
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: []
      }
    ], 'write');
    this._invalidateCache();
    return { batchId: Number(results[0].lastInsertRowid), recordsCount: records.length, timestamp };
  }

  async getLatestPoll(nowMs = Date.now()) {
    return (await this.rows('SELECT * FROM poll_batches WHERE timestamp <= ? ORDER BY timestamp DESC, id DESC LIMIT 1', [nowMs]))[0] ?? null;
  }

  async getLatestLiveBuses(nowMs = Date.now()) {
    return this.rows(`
      SELECT s.*, p.source_provider, p.data_coverage, p.monitored_stops
      FROM snapshots s JOIN poll_batches p ON p.id = s.poll_batch_id
      WHERE p.id = (SELECT id FROM poll_batches WHERE timestamp <= ? ORDER BY timestamp DESC, id DESC LIMIT 1)
        AND p.timestamp >= ? AND s.timestamp <= ? ORDER BY s.route_code, s.vehplate
    `, [nowMs, nowMs - ACTIVE_WINDOW_MS, nowMs]);
  }

  async getAllFleetStatus(nowMs = Date.now()) {
    await this.ready();
    const cache = this._cache;
    const now = Date.now();
    if (cache.fleet && Math.abs(nowMs - cache.fleetNowMs) < 10000 && now - cache.fleetTime < 10000) {
      const latestBatch = cache.fleet.latestBatch;
      const fresh = latestBatch && latestBatch.timestamp >= nowMs - ACTIVE_WINDOW_MS;
      return cache.fleet.records.map(record => ({
        ...record,
        status: !fresh ? 'stale' : record.poll_batch_id === latestBatch?.id ? 'active' : 'inactive',
        last_seen_at: record.timestamp
      }));
    }
    // Read the latest batch and vehicle history from the same database snapshot;
    // a poll finishing in another function cannot mix two fleet generations.
    const results = await this.client.batch([
      { sql: 'SELECT * FROM poll_batches WHERE timestamp <= ? ORDER BY timestamp DESC, id DESC LIMIT 1', args: [nowMs] },
      { sql: `SELECT * FROM (
          SELECT s.*, p.source_provider, p.data_coverage, p.monitored_stops,
            ROW_NUMBER() OVER (PARTITION BY s.vehplate ORDER BY s.timestamp DESC, s.poll_batch_id DESC, s.id DESC) AS vehicle_rank
          FROM snapshots s JOIN poll_batches p ON p.id = s.poll_batch_id WHERE s.timestamp <= ? AND p.timestamp <= ?
        ) WHERE vehicle_rank = 1 ORDER BY route_code, vehplate`, args: [nowMs, nowMs] }
    ], 'read');
    const latestBatch = results[0].rows[0];
    const fresh = latestBatch && latestBatch.timestamp >= nowMs - ACTIVE_WINDOW_MS;
    const records = results[1].rows.map(({ vehicle_rank, ...record }) => record);
    cache.fleet = { latestBatch, records };
    cache.fleetTime = now;
    cache.fleetNowMs = nowMs;
    return records.map(record => ({
      ...record,
      status: !fresh ? 'stale' : record.poll_batch_id === latestBatch.id ? 'active' : 'inactive',
      last_seen_at: record.timestamp
    }));
  }

  async getTotalSnapshotsCount() {
    const now = Date.now();
    if (this._cache.totalSnapshots !== undefined && now - this._cache.totalSnapshotsTime < 30000) {
      return this._cache.totalSnapshots;
    }
    const count = (await this.rows('SELECT COUNT(*) AS count FROM snapshots WHERE timestamp <= ?', [now]))[0].count;
    this._cache.totalSnapshots = count;
    this._cache.totalSnapshotsTime = now;
    return count;
  }

  async getDataSources(startTimeMs, endTimeMs) {
    const range = queryRange(startTimeMs, endTimeMs, 7 * DAY_MS);
    return (await this.rows(`
      SELECT source_provider, data_coverage, monitored_stops,
        COUNT(*) AS batch_count, SUM(records_count) AS records_count,
        MIN(timestamp) AS first_observed_at, MAX(timestamp) AS last_observed_at
      FROM poll_batches WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY source_provider, data_coverage, monitored_stops
      ORDER BY source_provider, data_coverage, monitored_stops
    `, [range.start, range.end])).map(row => ({
      dataProvider: row.source_provider, coverage: row.data_coverage,
      monitoredStops: JSON.parse(row.monitored_stops), batchCount: row.batch_count,
      recordsCount: row.records_count, firstObservedAt: row.first_observed_at, lastObservedAt: row.last_observed_at
    }));
  }

  async get24HourHistory(startTimeMs, endTimeMs) {
    const range = queryRange(startTimeMs, endTimeMs, DAY_MS);
    const select = `
      CAST(timestamp / ${BUCKET_MS} AS INTEGER) * ${BUCKET_MS} AS bucket_ts,
      ${AGGREGATE_COLUMNS},
      strftime('%H:%M', CAST(timestamp / ${BUCKET_MS} AS INTEGER) * ${BUCKET_MS} / 1000, 'unixepoch', '+8 hours') AS time_str,
      strftime('%Y-%m-%dT%H:%M:%fZ', CAST(timestamp / ${BUCKET_MS} AS INTEGER) * ${BUCKET_MS} / 1000, 'unixepoch') AS time_iso
    `;
    await this.ready();
    const [routeData, campusData, vehicleData] = await this.client.batch([
      { sql: `SELECT ${select}, route_code FROM snapshots
        WHERE timestamp >= ? AND timestamp <= ? GROUP BY bucket_ts, route_code ORDER BY bucket_ts, route_code`, args: [range.start, range.end] },
      { sql: `SELECT ${select} FROM snapshots
        WHERE timestamp >= ? AND timestamp <= ? GROUP BY bucket_ts ORDER BY bucket_ts`, args: [range.start, range.end] },
      { sql: `SELECT ${select}, vehplate, route_code FROM snapshots
        WHERE timestamp >= ? AND timestamp <= ? GROUP BY bucket_ts, vehplate ORDER BY bucket_ts, vehplate`, args: [range.start, range.end] }
    ], 'read');
    return {
      routeData: routeData.rows.map(row => ({ ...row })),
      campusData: campusData.rows.map(row => ({ ...row })),
      vehicleData: vehicleData.rows.map(row => ({ ...row }))
    };
  }

  async getVehicleSnapshots(vehplate, limit = 200) {
    if (!vehplate || typeof vehplate !== 'string') return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    return (await this.rows(`
      SELECT vehplate, lat, lng, speed, capacity, crowd_level, occupancy, ridership, timestamp, time_str, time_iso
      FROM snapshots WHERE vehplate = ? ORDER BY timestamp DESC LIMIT ?
    `, [vehplate.trim(), safeLimit])).map(row => ({ ...row }));
  }

  async getAvailableDates() {
    const now = Date.now();
    if (this._cache.availableDates && now - this._cache.availableDatesTime < 60000) {
      return this._cache.availableDates;
    }
    const dates = (await this.rows(`
      SELECT DISTINCT date(timestamp / 1000, 'unixepoch', '+8 hours') AS date
      FROM poll_batches WHERE timestamp <= ? AND records_count > 0 ORDER BY date DESC
    `, [now])).map(row => row.date);
    const result = dates.length > 0 ? dates : (await this.rows(`
      SELECT DISTINCT date(timestamp / 1000, 'unixepoch', '+8 hours') AS date
      FROM snapshots WHERE timestamp <= ? ORDER BY date DESC
    `, [now])).map(row => row.date);
    this._cache.availableDates = result;
    this._cache.availableDatesTime = now;
    return result;
  }

  async getCommuteOptimizationAnalytics(startTimeMs, endTimeMs) {
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
    await this.ready();
    const results = await this.client.batch([
      { sql: `SELECT ${select}, route_code FROM snapshots
        WHERE timestamp >= ? AND timestamp <= ? GROUP BY hour, route_code ORDER BY hour, route_code`, args: [range.start, range.end] },
      { sql: `SELECT ${select} FROM snapshots
        WHERE timestamp >= ? AND timestamp <= ? GROUP BY hour ORDER BY hour`, args: [range.start, range.end] }
    ], 'read');
    const [hourlyData, campusHourly] = results.map(result => result.rows.map(row => ({ ...row })));
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

  async getHourlyAnalytics(startTimeMs, endTimeMs) {
    return this.getCommuteOptimizationAnalytics(startTimeMs, endTimeMs);
  }

  async getExportRows(limit = 10000) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new RangeError('Export limit must be between 1 and 100000');
    const now = Date.now();
    return this.rows(`
      SELECT s.timestamp, s.time_iso, s.time_str, s.route_code, s.vehplate, s.lat, s.lng, s.speed,
        s.capacity, s.crowd_level, s.occupancy, s.ridership, p.source_provider, p.data_coverage, p.monitored_stops
      FROM snapshots s JOIN poll_batches p ON p.id = s.poll_batch_id
      WHERE s.timestamp <= ? AND p.timestamp <= ? ORDER BY s.timestamp DESC, s.id DESC LIMIT ?
    `, [now, now, limit]);
  }

  async pruneRecordsOlderThan(cutoffMs, { batchLimit = 5000 } = {}) {
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) {
      throw new TypeError('Cutoff timestamp must be a non-negative integer');
    }
    const safeLimit = Math.max(1, Math.min(Number(batchLimit) || 5000, 50000));
    await this.ready();

    let totalSnapshotsDeleted = 0;
    let totalBatchesDeleted = 0;

    while (true) {
      const result = await this.client.execute({
        sql: `DELETE FROM snapshots WHERE id IN (
          SELECT id FROM snapshots WHERE timestamp < ? LIMIT ?
        )`,
        args: [cutoffMs, safeLimit]
      });
      const affected = Number(result.rowsAffected || 0);
      totalSnapshotsDeleted += affected;
      if (affected < safeLimit) break;
    }

    while (true) {
      const result = await this.client.execute({
        sql: `DELETE FROM poll_batches WHERE id IN (
          SELECT id FROM poll_batches WHERE timestamp < ? LIMIT ?
        )`,
        args: [cutoffMs, safeLimit]
      });
      const affected = Number(result.rowsAffected || 0);
      totalBatchesDeleted += affected;
      if (affected < safeLimit) break;
    }

    this._invalidateCache();
    return {
      deletedBatches: totalBatchesDeleted,
      deletedSnapshots: totalSnapshotsDeleted
    };
  }

  async clearAllSnapshots() {
    await this.ready();
    const results = await this.client.batch([
      'DELETE FROM snapshots', 'DELETE FROM poll_batches',
      { sql: SET_SETTING_SQL, args: ['last_polled_at', '0'] }
    ], 'write');
    this._invalidateCache();
    return results[0].rowsAffected;
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.client.close();
    }
  }
}
