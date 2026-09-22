/**
 * Standalone retention cleanup script.
 * Deletes observations and poll batches older than 1 month (or specified days).
 *
 * Usage:
 *   node scripts/cleanup.js              # Runs real cleanup (> 1 calendar month)
 *   node scripts/cleanup.js --dry-run    # Previews counts without deleting
 *   node scripts/cleanup.js --days=60    # Custom retention window (60 days)
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDatabase } from '../src/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Calculates retention cutoff epoch milliseconds.
 * Defaults to 1 calendar month prior to nowMs.
 *
 * @param {number|null} days - Optional custom retention days.
 * @param {number} [nowMs=Date.now()] - Reference timestamp.
 * @returns {number} Cutoff in epoch milliseconds.
 */
export function getCutoffTimestamp(days = null, nowMs = Date.now()) {
  if (days !== null && days !== undefined && Number.isFinite(days) && days > 0) {
    return nowMs - (days * DAY_MS);
  }
  const date = new Date(nowMs);
  date.setMonth(date.getMonth() - 1);
  return date.getTime();
}

/**
 * Runs the retention cleanup process against the database.
 *
 * @param {object} [options]
 * @param {object} [options.env=process.env] - Environment variables.
 * @param {number|null} [options.days=null] - Retention days (or 1 calendar month).
 * @param {boolean} [options.dryRun=false] - Preview counts without modifying data.
 * @param {number} [options.batchLimit=5000] - Chunks for deletion.
 * @returns {Promise<object>} Summary of the cleanup operation.
 */
export async function runCleanup({ env = process.env, days = null, dryRun = false, batchLimit = 5000, db: injectedDb = null } = {}) {
  const shouldClose = !injectedDb;
  const db = injectedDb || getDatabase(env);
  await db.ready();

  const cutoffMs = getCutoffTimestamp(days);
  const cutoffIso = new Date(cutoffMs).toISOString();

  console.log(`[Cleanup] Retention cutoff: ${cutoffIso} (records before this will be purged).`);

  try {
    if (dryRun) {
      const [batchRow] = await db.rows(
        'SELECT COUNT(*) AS count FROM poll_batches WHERE timestamp < ?',
        [cutoffMs]
      );
      const [snapshotRow] = await db.rows(
        'SELECT COUNT(*) AS count FROM snapshots WHERE timestamp < ?',
        [cutoffMs]
      );

      const batches = Number(batchRow?.count || 0);
      const snapshots = Number(snapshotRow?.count || 0);

      console.log(`[Cleanup] [DRY RUN] Would purge:`);
      console.log(`  - ${batches} poll batches`);
      console.log(`  - ${snapshots} snapshots`);

      return { dryRun: true, cutoffMs, cutoffIso, batches, snapshots };
    }

    const startTime = Date.now();
    const result = await db.pruneRecordsOlderThan(cutoffMs, { batchLimit });
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`[Cleanup] Purge completed in ${elapsedSec}s:`);
    console.log(`  - Purged ${result.deletedBatches} poll batches`);
    console.log(`  - Purged ${result.deletedSnapshots} snapshots`);

    return { dryRun: false, cutoffMs, cutoffIso, elapsedSec, ...result };
  } finally {
    if (shouldClose) {
      db.close();
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const isDryRun = process.argv.includes('--dry-run');
  const daysArg = process.argv.find(arg => arg.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : null;

  try {
    const summary = await runCleanup({ dryRun: isDryRun, days });
    if (summary.dryRun) {
      console.log(JSON.stringify(summary));
    }
  } catch (error) {
    console.error(`[Cleanup] Failed: ${error.message}`);
    process.exitCode = 1;
  }
}
