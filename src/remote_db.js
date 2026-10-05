import pg from 'pg';
import {
  ACTIVE_WINDOW_MS, DAY_MS, BUCKET_MS, SNAPSHOT_SCHEMA, AGGREGATE_COLUMNS,
  queryRange, normalizePoll
} from './db_shared.js';

// Configure PostgreSQL type parsers so bigints and numerics return as JavaScript numbers
pg.types.setTypeParser(20, val => (val === null ? null : Number(val)));
pg.types.setTypeParser(1700, val => (val === null ? null : parseFloat(val)));

const SETTINGS_SCHEMA = 'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)';
const SCHEMA_VERSION = 4;
const VERSION_SCHEMA = `CREATE TABLE IF NOT EXISTS bus_schema_version (
  id INTEGER PRIMARY KEY, version INTEGER NOT NULL
)`;

const REQUIRED_COLUMNS = {
  settings: ['key', 'value'],
  poll_batches: ['id', 'timestamp', 'records_count', 'source_provider', 'data_coverage', 'monitored_stops'],
  snapshots: [
    'id', 'poll_batch_id', 'timestamp', 'time_iso', 'time_str', 'route_code', 'vehplate',
    'lat', 'lng', 'speed', 'capacity', 'crowd_level', 'occupancy', 'ridership'
  ]
};

const SET_SETTING_SQL = `INSERT INTO settings(key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`;

export function toPgSql(sql) {
  let index = 1;
  return sql.replace(/\?/g, () => `$${index++}`);
}

export function createClientFromPool(pool) {
  return {
    async execute(queryOrObject, maybeArgs = []) {
      const text = typeof queryOrObject === 'string' ? queryOrObject : (queryOrObject?.sql || '');
      const args = typeof queryOrObject === 'string' ? maybeArgs : (queryOrObject?.args || maybeArgs || []);
      const res = await pool.query(toPgSql(text), args);
      return {
        rows: res.rows || [],
        rowsAffected: res.rowCount ?? 0,
        lastInsertRowid: res.rows?.[0]?.id ?? null
      };
    },
    async batch(statements) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const results = [];
        for (const item of statements) {
          const sqlText = typeof item === 'string' ? item : item.sql;
          const args = typeof item === 'string' ? [] : (item.args || []);
          const res = await client.query(toPgSql(sqlText), args);
          results.push({
            rows: res.rows || [],
            rowsAffected: res.rowCount ?? 0,
            lastInsertRowid: res.rows?.[0]?.id ?? null
          });
        }
        await client.query('COMMIT');
        return results;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close() {
      return pool.end();
    }
  };
}

function remoteConfig(url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new TypeError('SUPABASE_DB_URL must be a valid postgresql:// or postgres:// URL');
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new TypeError('SUPABASE_DB_URL must be a valid postgresql:// or postgres:// URL');
  }
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new TypeError('SUPABASE_DB_URL must be a valid postgresql:// or postgres:// URL');
  }
  let connectionString = url.trim();
  const directMatch = parsed.hostname.match(/^db\.([a-z0-9_-]+)\.supabase\.co$/i);
  if (directMatch) {
    const projectRef = directMatch[1];
    const region = process.env.SUPABASE_REGION || 'ap-southeast-1';
    const poolerHost = `aws-0-${region}.pooler.supabase.com`;
    const username = (parsed.username && parsed.username !== 'postgres')
      ? parsed.username
      : `postgres.${projectRef}`;
    const password = parsed.password ? `:${parsed.password}` : '';
    const pathname = parsed.pathname || '/postgres';
    connectionString = `postgresql://${username}${password}@${poolerHost}:6543${pathname}`;
  }
  return {
    connectionString: url.trim(),
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000
  };
}

/** Durable, shared Supabase PostgreSQL storage. Every operation awaits lazy schema initialization. */
export class RemoteBusDatabase {
  constructor({ url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL, client, pool } = {}) {
    if (client) {
      this.client = client;
    } else {
      const poolConfig = pool ? null : remoteConfig(url);
      this.pool = pool || new pg.Pool(poolConfig);
      this.client = createClientFromPool(this.pool);
    }
    this.storage = { type: 'supabase', persistent: true };
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

  async ensureHelperFunctions() {
    const fns = [
      `CREATE OR REPLACE FUNCTION sg_time_str(ts BIGINT) RETURNS TEXT AS $$
        SELECT to_char(to_timestamp(ts / 1000.0) AT TIME ZONE 'Asia/Singapore', 'HH24:MI');
      $$ LANGUAGE SQL IMMUTABLE;`,
      `CREATE OR REPLACE FUNCTION sg_time_iso(ts BIGINT) RETURNS TEXT AS $$
        SELECT to_char(to_timestamp(ts / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      $$ LANGUAGE SQL IMMUTABLE;`,
      `CREATE OR REPLACE FUNCTION sg_date(ts BIGINT) RETURNS TEXT AS $$
        SELECT to_char(to_timestamp(ts / 1000.0) AT TIME ZONE 'Asia/Singapore', 'YYYY-MM-DD');
      $$ LANGUAGE SQL IMMUTABLE;`,
      `CREATE OR REPLACE FUNCTION sg_hour(ts BIGINT) RETURNS INTEGER AS $$
        SELECT CAST(to_char(to_timestamp(ts / 1000.0) AT TIME ZONE 'Asia/Singapore', 'HH24') AS INTEGER);
      $$ LANGUAGE SQL IMMUTABLE;`
    ];
    for (const sql of fns) {
      try {
        await this.client.execute({ sql, args: [] });
      } catch {
        // Functions may already exist or environment may not permit CREATE FUNCTION
      }
    }
  }

  async initSchema() {
    const tables = Object.keys(REQUIRED_COLUMNS);
    const columnQuery = await this.client.execute({
      sql: `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_name IN ('settings', 'poll_batches', 'snapshots', 'bus_schema_version')`,
      args: []
    });

    const existingCols = {};
    for (const row of columnQuery.rows) {
      const tbl = row.table_name.toLowerCase();
      const col = row.column_name.toLowerCase();
      if (!existingCols[tbl]) existingCols[tbl] = new Set();
      existingCols[tbl].add(col);
    }

    let version = 0;
    const hasVersionTable = Boolean(existingCols['bus_schema_version']?.size);
    if (hasVersionTable) {
      const cols = existingCols['bus_schema_version'];
      if (!cols.has('id') || !cols.has('version')) {
        throw new Error('Unsupported remote database schema for bus_schema_version');
      }
      const result = await this.client.execute({ sql: 'SELECT id, version FROM bus_schema_version', args: [] });
      if (result.rows.length !== 1 || result.rows[0].id !== 1 || !Number.isSafeInteger(result.rows[0].version)) {
        throw new Error('Unsupported remote database schema version metadata');
      }
      version = result.rows[0].version;
    }

    const existing = tables.some(t => Boolean(existingCols[t]?.size));
    if (version > SCHEMA_VERSION) {
      throw new Error('Database schema is newer than this application supports');
    }
    if ((existing && version !== SCHEMA_VERSION) || (!existing && (hasVersionTable || version !== 0))) {
      throw new Error('Unsupported remote database schema. Use a fresh Supabase database or import a compatible version 4 schema.');
    }
    if (existing) {
      for (const table of tables) {
        const tableCols = existingCols[table] || new Set();
        if (REQUIRED_COLUMNS[table].some(column => !tableCols.has(column)) || tableCols.has('is_mock')) {
          throw new Error(`Unsupported remote database schema for ${table}`);
        }
      }
      await this.ensureHelperFunctions();
      return;
    }

    await this.ensureHelperFunctions();

    await this.client.batch([
      VERSION_SCHEMA, SETTINGS_SCHEMA,
      ...SNAPSHOT_SCHEMA.split(';').map(sql => sql.trim()).filter(Boolean),
      'CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_snapshots_route_time ON snapshots(route_code, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_snapshots_vehicle_time ON snapshots(vehplate, timestamp DESC, id DESC)',
      'CREATE INDEX IF NOT EXISTS idx_snapshots_poll_batch ON snapshots(poll_batch_id)',
      'CREATE INDEX IF NOT EXISTS idx_poll_batches_time ON poll_batches(timestamp DESC, id DESC)',
      {
        sql: 'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
        args: ['last_polled_at', '0']
      },
      {
        sql: 'INSERT INTO bus_schema_version(id, version) VALUES (1, ?) ON CONFLICT(id) DO NOTHING',
        args: [SCHEMA_VERSION]
      }
    ]);
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

  async recordPoll(records, timestamp = Date.now(), metadata = {}) {
    const { source, normalized } = normalizePoll(records, timestamp, metadata);
    await this.ready();
    const results = await this.client.batch([
      {
        sql: `INSERT INTO poll_batches(timestamp, records_count, source_provider, data_coverage, monitored_stops)
          VALUES (?, ?, ?, ?, ?) RETURNING id`,
        args: [timestamp, records.length, source.dataProvider, source.coverage, source.monitoredStops]
      },
      ...normalized.map(record => ({
        sql: `INSERT INTO snapshots (
          poll_batch_id, timestamp, time_iso, time_str, route_code, vehplate,
          lat, lng, speed, capacity, crowd_level, occupancy, ridership
        ) VALUES ((SELECT MAX(id) FROM poll_batches), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: record
      })),
      {
        sql: `INSERT INTO settings(key, value)
          SELECT 'last_polled_at', CAST(MAX(timestamp) AS TEXT) FROM poll_batches WHERE true
          ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
        args: []
      }
    ]);
    this._invalidateCache();
    const batchId = results[0]?.lastInsertRowid ?? results[0]?.rows?.[0]?.id ?? null;
    return { batchId: Number(batchId), recordsCount: records.length, timestamp };
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
    const results = await this.client.batch([
      { sql: 'SELECT * FROM poll_batches WHERE timestamp <= ? ORDER BY timestamp DESC, id DESC LIMIT 1', args: [nowMs] },
      { sql: `SELECT DISTINCT ON (s.vehplate)
          s.*, p.source_provider, p.data_coverage, p.monitored_stops
        FROM snapshots s JOIN poll_batches p ON p.id = s.poll_batch_id
        WHERE s.timestamp >= ? AND s.timestamp <= ? AND p.timestamp <= ?
        ORDER BY s.vehplate, s.timestamp DESC, s.poll_batch_id DESC, s.id DESC`, args: [nowMs - 30 * DAY_MS, nowMs, nowMs] }
    ]);
    const latestBatch = results[0].rows[0];
    const fresh = latestBatch && latestBatch.timestamp >= nowMs - ACTIVE_WINDOW_MS;
    const records = results[1].rows.slice().sort((a, b) => {
      if (a.route_code !== b.route_code) return a.route_code.localeCompare(b.route_code);
      return a.vehplate.localeCompare(b.vehplate);
    });
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
    const count = Number((await this.rows('SELECT COUNT(*)::integer AS count FROM snapshots WHERE timestamp <= ?', [now]))[0]?.count ?? 0);
    this._cache.totalSnapshots = count;
    this._cache.totalSnapshotsTime = now;
    return count;
  }

  async getDataSources(startTimeMs, endTimeMs) {
    const range = queryRange(startTimeMs, endTimeMs, 7 * DAY_MS);
    return (await this.rows(`
      SELECT source_provider, data_coverage, monitored_stops,
        COUNT(*)::integer AS batch_count, SUM(records_count)::integer AS records_count,
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
      CAST(timestamp / ${BUCKET_MS} AS BIGINT) * ${BUCKET_MS} AS bucket_ts,
      ${AGGREGATE_COLUMNS},
      sg_time_str(CAST(timestamp / ${BUCKET_MS} AS BIGINT) * ${BUCKET_MS}) AS time_str,
      sg_time_iso(CAST(timestamp / ${BUCKET_MS} AS BIGINT) * ${BUCKET_MS}) AS time_iso
    `;
    const vehicleSelect = `
      CAST(timestamp / ${BUCKET_MS} AS BIGINT) * ${BUCKET_MS} AS bucket_ts,
      ROUND(AVG(ridership)::numeric, 1) AS avg_ridership,
      ROUND((AVG(occupancy) * 100)::numeric, 1) AS avg_occupancy_pct,
      COUNT(*)::integer AS sample_count,
      COUNT(occupancy)::integer AS occupancy_sample_count,
      COUNT(ridership)::integer AS ridership_sample_count,
      1::integer AS active_buses,
      sg_time_str(CAST(timestamp / ${BUCKET_MS} AS BIGINT) * ${BUCKET_MS}) AS time_str,
      sg_time_iso(CAST(timestamp / ${BUCKET_MS} AS BIGINT) * ${BUCKET_MS}) AS time_iso
    `;
    await this.ready();
    const [routeData, campusData, vehicleData] = await this.client.batch([
      { sql: `SELECT ${select}, route_code FROM snapshots
        WHERE timestamp >= ? AND timestamp <= ? GROUP BY bucket_ts, route_code ORDER BY bucket_ts, route_code`, args: [range.start, range.end] },
      { sql: `SELECT ${select} FROM snapshots
        WHERE timestamp >= ? AND timestamp <= ? GROUP BY bucket_ts ORDER BY bucket_ts`, args: [range.start, range.end] },
      { sql: `SELECT ${vehicleSelect}, vehplate, route_code FROM snapshots
        WHERE timestamp >= ? AND timestamp <= ? GROUP BY bucket_ts, vehplate, route_code ORDER BY bucket_ts, vehplate`, args: [range.start, range.end] }
    ]);
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
      SELECT DISTINCT sg_date(timestamp) AS date
      FROM poll_batches WHERE timestamp <= ? AND records_count > 0 ORDER BY date DESC
    `, [now])).map(row => row.date);
    const result = dates.length > 0 ? dates : (await this.rows(`
      SELECT DISTINCT sg_date(timestamp) AS date
      FROM snapshots WHERE timestamp <= ? ORDER BY date DESC
    `, [now])).map(row => row.date);
    this._cache.availableDates = result;
    this._cache.availableDatesTime = now;
    return result;
  }

  async getCommuteOptimizationAnalytics(startTimeMs, endTimeMs) {
    const range = queryRange(startTimeMs, endTimeMs, 7 * DAY_MS);
    const select = `
      sg_hour(timestamp) AS hour,
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
        WHERE timestamp >= ? AND timestamp <= ? GROUP BY sg_hour(timestamp), route_code ORDER BY hour, route_code`, args: [range.start, range.end] },
      { sql: `SELECT ${select} FROM snapshots
        WHERE timestamp >= ? AND timestamp <= ? GROUP BY sg_hour(timestamp) ORDER BY hour`, args: [range.start, range.end] }
    ]);
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
    ]);
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
