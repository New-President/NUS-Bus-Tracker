/**
 * Standalone JavaScript poller for uNivUS API.
 * Polls every 10 minutes without requiring any authentication.
 *
 * Usage:
 *   node scripts/poll.js           # Run continuously every 10 minutes
 *   node scripts/poll.js --once    # Run a single poll and exit
 *
 * If TRACKER_URL is set, it polls the unauthenticated /api/cron HTTP endpoint.
 * Otherwise, it directly collects and persists observations using BusCollector.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDatabase } from '../src/db.js';
import { BusCollector } from '../src/collector.js';
import { pollScheduled } from './poll_scheduled.js';

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function nowIso() {
  return new Date().toISOString();
}

export async function runPollOnce({ env = process.env } = {}) {
  if (env.TRACKER_URL?.trim()) {
    return pollScheduled({ env });
  }

  const db = getDatabase(env);
  const collector = new BusCollector(db, { env });
  const result = await collector.pollNow();
  if (!result.success) {
    throw new Error(result.error || 'Direct collection from uNivUS API failed.');
  }
  return {
    recordsCount: result.recordsCount ?? result.polledCount ?? 0,
    timestamp: new Date(result.timestamp).toISOString(),
    source: result.dataProvider || 'univus'
  };
}

export function startPoller({ env = process.env, intervalMs = INTERVAL_MS } = {}) {
  let timer = null;
  let running = true;
  let inFlight = false;

  console.log(`[${nowIso()}] [Poller] Starting JavaScript poller for uNivUS API.`);
  console.log(`[${nowIso()}] [Poller] Interval: ${intervalMs / 60000} minutes, authentication: none required.`);
  if (env.TRACKER_URL?.trim()) {
    console.log(`[${nowIso()}] [Poller] Target tracker: ${env.TRACKER_URL.trim()}`);
  } else {
    console.log(`[${nowIso()}] [Poller] Mode: Direct uNivUS API collection to database.`);
  }

  async function executePoll() {
    if (!running || inFlight) return;
    inFlight = true;
    try {
      console.log(`[${nowIso()}] [Poller] Polling uNivUS API...`);
      const result = await runPollOnce({ env });
      console.log(`[${nowIso()}] [Poller] Poll successful: ${result.recordsCount} vehicle readings recorded. Next poll in ${intervalMs / 60000} minutes.`);
    } catch (error) {
      console.error(`[${nowIso()}] [Poller] Poll failed: ${error.message}. Retrying in ${intervalMs / 60000} minutes.`);
    } finally {
      inFlight = false;
      if (running) {
        timer = setTimeout(executePoll, intervalMs);
      }
    }
  }

  void executePoll();

  return {
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      console.log(`[${nowIso()}] [Poller] JavaScript poller stopped.`);
    }
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const isOnce = process.argv.includes('--once');
  if (isOnce) {
    try {
      const result = await runPollOnce();
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(error.message || 'Poll failed.');
      process.exitCode = 1;
    }
  } else {
    const poller = startPoller();
    const shutdown = () => {
      poller.stop();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}
