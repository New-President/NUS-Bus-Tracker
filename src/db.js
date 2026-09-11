import { RemoteBusDatabase } from './remote_db.js';

export class DatabaseConfigurationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'DatabaseConfigurationError';
  }
}

/** All application storage uses Turso, including when the HTTP server runs locally. */
export function createDatabase(env = process.env) {
  if (typeof env.TURSO_DATABASE_URL !== 'string' || !env.TURSO_DATABASE_URL.trim() ||
      typeof env.TURSO_AUTH_TOKEN !== 'string' || !env.TURSO_AUTH_TOKEN.trim()) {
    throw new DatabaseConfigurationError('Configure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to use the application.');
  }
  try {
    return new RemoteBusDatabase({
      url: env.TURSO_DATABASE_URL.trim(), authToken: env.TURSO_AUTH_TOKEN
    });
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
