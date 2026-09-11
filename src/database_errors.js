import { LibsqlError } from '@libsql/client/web';

// Return only fixed descriptions/codes. Driver messages can contain endpoints,
// SQL text, or credentials and must never be sent to the browser or logs.
export function databaseFailure(error) {
  if (!(error instanceof LibsqlError)) return null;
  const allowedCodes = new Set([
    'SQL_PARSE_ERROR', 'SQLITE_ERROR', 'SQLITE_AUTH', 'SQLITE_READONLY',
    'SERVER_ERROR', 'HRANA_CLOSED_ERROR', 'HRANA_PROTO_ERROR', 'UNKNOWN'
  ]);
  const databaseCode = allowedCodes.has(error.code) ? error.code : 'UNKNOWN';
  const status = error.cause?.status;
  if ([401, 403].includes(status) || ['SQLITE_AUTH', 'SQLITE_READONLY'].includes(databaseCode)) {
    return { statusCode: 503, code: 'database_access_failed', databaseCode,
      error: 'Turso denied database access. Check TURSO_DATABASE_URL and the read/write permissions of TURSO_AUTH_TOKEN.' };
  }
  if (['SQL_PARSE_ERROR', 'SQLITE_ERROR'].includes(databaseCode)) {
    return { statusCode: 503, code: 'database_query_failed', databaseCode,
      error: 'Turso rejected a database query. Check the database schema and application version.' };
  }
  return { statusCode: 503, code: 'database_unavailable', databaseCode,
    error: 'The Turso database request failed. Check database connectivity and access.' };
}
