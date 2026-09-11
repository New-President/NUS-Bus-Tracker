import { createClient } from '@libsql/client';
import { RemoteBusDatabase } from '../src/remote_db.js';

// Isolated SQL storage for tests; production always uses the Turso HTTP client.
export function createTestDatabase(t) {
  const db = new RemoteBusDatabase({ client: createClient({ url: 'file::memory:' }) });
  t?.after(() => db.close());
  return db;
}
