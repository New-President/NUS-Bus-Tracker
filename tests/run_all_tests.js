import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const suites = [
  'tests/test_suite.js',
  'tests/test_univus_auth.js',
  'tests/test_univus_client.js',
  'tests/test_public_feed.js',
  'tests/test_database.js',
  'tests/test_remote_database.js',
  'tests/test_server_endpoints.js',
  'tests/test_vercel_handler.js',
  'tests/test_frontend.js'
];

// Suites inject isolated SQL clients and never inherit cloud/provider
// credentials, so npm test cannot access application data.
const env = { ...process.env, FMS_ROUTES: 'A1,A2,D1,D2,E,K', TZ: 'UTC' };
for (const key of ['FMS_TOKEN', 'BUS_PROVIDER', 'BUS_STOPS', 'ADMIN_TOKEN', 'CRON_SECRET', 'VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']) {
  delete env[key];
}
const result = spawnSync(process.execPath, ['--test', ...suites], {
  cwd: root, env, stdio: 'inherit'
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
