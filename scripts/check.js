import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
let checked = 0;
for (const directory of ['src', 'api', 'public', 'tests', 'scripts']) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, entry.name)], { stdio: 'inherit' });
    if (result.error || result.status !== 0) process.exit(result.status || 1);
    checked++;
  }
}
for (const file of ['package.json', 'vercel.json']) JSON.parse(readFileSync(path.join(root, file), 'utf8'));
for (const file of ['index.html', 'styles.css', 'app.js']) readFileSync(path.join(root, 'public', file));
console.log(`Checked ${checked} JavaScript files, configuration, and public assets.`);
