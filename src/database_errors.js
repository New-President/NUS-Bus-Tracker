// Return only fixed descriptions/codes. Driver messages can contain endpoints,
// SQL text, or credentials and must never be sent to the browser or logs.
export function databaseFailure(error) {
  if (!error) return null;
  const isPgError = error.name === 'DatabaseError' ||
    (typeof error.code === 'string' && (
      error.code.startsWith('28') ||
      error.code.startsWith('42') ||
      error.code.startsWith('08') ||
      ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '23505', '23514'].includes(error.code)
    ));

  if (!isPgError) return null;

  const rawCode = String(error.code || 'UNKNOWN');
  const allowedCodes = new Set([
    '28P01', '28000', '42601', '42P01', '42703', '08001', '08006',
    'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'UNKNOWN'
  ]);
  const databaseCode = allowedCodes.has(rawCode) ? rawCode : rawCode.startsWith('42') ? '42601' : 'UNKNOWN';

  if (['28P01', '28000'].includes(rawCode) || rawCode.startsWith('28')) {
    return {
      statusCode: 503,
      code: 'database_access_failed',
      databaseCode,
      error: 'Supabase denied database access. Check SUPABASE_DB_URL and database credentials.'
    };
  }
  if (['42601', '42P01', '42703'].includes(rawCode) || rawCode.startsWith('42')) {
    return {
      statusCode: 503,
      code: 'database_query_failed',
      databaseCode,
      error: 'Supabase rejected a database query. Check the database schema and application version.'
    };
  }
  return {
    statusCode: 503,
    code: 'database_unavailable',
    databaseCode,
    error: 'The Supabase database request failed. Check database connectivity and access.'
  };
}
