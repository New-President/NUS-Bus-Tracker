import { RemoteBusDatabase } from './remote_db.js';

export class DatabaseConfigurationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'DatabaseConfigurationError';
  }
}

/** All application storage uses Supabase PostgreSQL, including when the HTTP server runs locally. */
export function createDatabase(env = process.env) {
  const url = (env.SUPABASE_DB_URL || env.DATABASE_URL || '').trim();
  if (!url) {
    throw new DatabaseConfigurationError('Configure SUPABASE_DB_URL to use the application.');
  }
  try {
    return new RemoteBusDatabase({ url });
  } catch (error) {
    if (error instanceof TypeError) throw new DatabaseConfigurationError(error.message);
    throw error;
  }
}

// Construct a client only when storage is requested. Importing a handler or
// injecting a database into it requires neither credentials nor network access.
const databases = new WeakMap();
export function getDatabase(env = process.env) {
  let database = databases.get(env);
  if (!database || database.closed) {
    database = createDatabase(env);
    databases.set(env, database);
  }
  return database;
}
