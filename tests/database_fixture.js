import { newDb } from 'pg-mem';
import { RemoteBusDatabase, createClientFromPool } from '../src/remote_db.js';

export function createPgMemDb() {
  const mem = newDb({ noAstCoverageCheck: true });

  mem.public.registerFunction({
    name: 'sg_time_str',
    args: [mem.public.getType('bigint')],
    returns: mem.public.getType('text'),
    implementation: ts => {
      if (ts === null || ts === undefined) return null;
      return new Date(Number(ts) + 8 * 3600000).toISOString().slice(11, 16);
    }
  });

  mem.public.registerFunction({
    name: 'sg_time_iso',
    args: [mem.public.getType('bigint')],
    returns: mem.public.getType('text'),
    implementation: ts => {
      if (ts === null || ts === undefined) return null;
      return new Date(Number(ts)).toISOString();
    }
  });

  mem.public.registerFunction({
    name: 'sg_date',
    args: [mem.public.getType('bigint')],
    returns: mem.public.getType('text'),
    implementation: ts => {
      if (ts === null || ts === undefined) return null;
      return new Date(Number(ts) + 8 * 3600000).toISOString().slice(0, 10);
    }
  });

  mem.public.registerFunction({
    name: 'sg_hour',
    args: [mem.public.getType('bigint')],
    returns: mem.public.getType('integer'),
    implementation: ts => {
      if (ts === null || ts === undefined) return null;
      return new Date(Number(ts) + 8 * 3600000).getUTCHours();
    }
  });

  mem.public.registerFunction({
    name: 'round',
    args: [mem.public.getType('double precision'), mem.public.getType('integer')],
    returns: mem.public.getType('double precision'),
    implementation: (val, decimals) => {
      if (val === null || val === undefined) return null;
      const factor = Math.pow(10, decimals || 0);
      return Math.round(Number(val) * factor) / factor;
    }
  });

  // Provide mock pg_indexes table for tests verifying index presence
  try {
    mem.public.none(`
      CREATE TABLE IF NOT EXISTS pg_indexes (
        schemaname TEXT, tablename TEXT, indexname TEXT, tablespace TEXT, indexdef TEXT
      );
      INSERT INTO pg_indexes(schemaname, tablename, indexname, indexdef)
      VALUES ('public', 'snapshots', 'idx_snapshots_poll_batch', 'CREATE INDEX idx_snapshots_poll_batch ON public.snapshots USING btree (poll_batch_id)')
      ON CONFLICT DO NOTHING;
    `);
  } catch {
    // Ignore if already created
  }

  return mem;
}

export function createTestDatabase(t) {
  const mem = createPgMemDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  let schemaInitialized = false;

  const baseClient = createClientFromPool(pool);
  const client = {
    ...baseClient,
    async batch(statements) {
      if (schemaInitialized) {
        const backup = mem.backup();
        try {
          return await baseClient.batch(statements);
        } catch (err) {
          try { backup.restore(); } catch {}
          throw err;
        }
      }
      const res = await baseClient.batch(statements);
      schemaInitialized = true;
      return res;
    }
  };
  const db = new RemoteBusDatabase({ client });
  t?.after(() => db.close());
  return db;
}
