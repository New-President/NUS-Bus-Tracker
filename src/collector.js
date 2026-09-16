import { fetchAllLiveBuses, ProviderError } from './api_client.js';
import { GuestTokenProvider } from './univus_auth.js';
import { UnivusClient } from './univus_client.js';
import { fetchPublicObservations } from './public_feed.js';
import { getProviderConfig } from './provider_config.js';
import { databaseFailure } from './database_errors.js';

export class BusCollector {
  constructor(db, {
    fetchBuses = fetchAllLiveBuses, fetchPublic = fetchPublicObservations,
    now = Date.now, env = process.env, tokenProvider, univusClient
  } = {}) {
    if (!db) throw new TypeError('BusCollector requires a database.');
    this.db = db;
    this.fetchBuses = fetchBuses;
    this.fetchPublic = fetchPublic;
    this.now = now;
    this.env = env;
    this.tokenProvider = tokenProvider || new GuestTokenProvider({ now, env });
    this.univusClient = univusClient || new UnivusClient({ now });
    // Resolve stored credentials only within a request or collection, since
    // shared databases may need asynchronous network access.
    this.currentSource = null;
    this.intervalMs = (Number(this.env?.POLL_INTERVAL_MS) || (this.env?.POLL_INTERVAL_SEC ? Number(this.env.POLL_INTERVAL_SEC) * 1000 : null)) || 1 * 60 * 1000;
    this.timer = null;
    this.running = false;
    this.pendingPoll = null;
  }

  get isPolling() { return this.pendingPoll !== null; }
  async getToken() { return ''; }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      let remaining = this.intervalMs;
      try {
        const lastAttempt = Number(await this.db.getSetting('last_attempt_at') || 0);
        if (!this.running) return;
        if (this.now() - lastAttempt >= this.intervalMs) await this.pollNow();
        remaining = this.intervalMs - (this.now() - Number(await this.db.getSetting('last_attempt_at') || 0));
      } catch {
        console.error('[Collector] Unable to access collection state; retrying at the next interval.');
      }
      if (this.running) this.timer = setTimeout(tick, Math.max(1000, remaining));
    };
    void tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  pollNow() {
    if (this.pendingPoll) return this.pendingPoll;
    this.pendingPoll = this.collect().finally(() => { this.pendingPoll = null; });
    return this.pendingPoll;
  }

  async collect() {
    const timestamp = this.now();
    let source = this.currentSource;
    try {
      source = getProviderConfig(this.env);
      await this.db.setSetting('last_attempt_at', timestamp);
      let records;
      if (source.dataProvider === 'univus') {
        try { records = await this.univusClient.fetchBuses(); }
        catch (error) {
          const automatic = (this.env.BUS_PROVIDER?.trim() || 'auto') === 'auto';
          if (!automatic || !(error instanceof ProviderError)) throw error;
          source = getProviderConfig(this.env, true);
        }
      } else if (source.dataProvider === 'connectx') {
        let token = await this.tokenProvider.getToken();
        try { records = await this.fetchBuses(token); }
        catch (error) {
          if (![401, 403].includes(error.httpStatus)) throw error;
          this.tokenProvider.invalidate();
          token = await this.tokenProvider.getToken();
          records = await this.fetchBuses(token);
        }
      }
      if (source.dataProvider === 'community') {
        records = await this.fetchPublic({ now: this.now, stops: source.monitoredStops });
      }
      await this.db.recordPoll(records, timestamp, source);
      await this.db.deleteSetting('last_error');
      return { success: true, source: 'live', ...source, recordsCount: records.length, polledCount: records.length, timestamp };
    } catch (error) {
      const failure = databaseFailure(error);
      let message = failure?.error || (error instanceof ProviderError ? error.message : 'Live collection failed. Check provider connectivity and database availability.');
      if (failure) console.error(`[Database] ${failure.databaseCode}: ${failure.error}`);
      try { await this.db.setSetting('last_error', message); } catch { /* Storage may be unavailable. */ }
      return { success: false, source: 'live', ...source, statusCode: failure?.statusCode || 502,
        ...(failure ? { code: failure.code, databaseCode: failure.databaseCode } : {}), error: message, timestamp };
    } finally { this.currentSource = source; }
  }

  async getStatus() {
    const now = this.now();
    const [lastPolled, lastAttempt, latest, lastError, totalSnapshots] = await Promise.all([
      this.db.getSetting('last_polled_at'), this.db.getSetting('last_attempt_at'),
      this.db.getLatestPoll(now), this.db.getSetting('last_error'), this.db.getTotalSnapshotsCount()
    ]);
    const lastPolledAt = Number(lastPolled || 0);
    const lastAttemptAt = Number(lastAttempt || 0);
    const configured = getProviderConfig(this.env);
    // Attribute stored observations independently of the next provider request.
    const observed = latest ? getProviderConfig({
      ...this.env, BUS_PROVIDER: latest.source_provider,
      BUS_STOPS: JSON.parse(latest.monitored_stops).join(',')
    }) : this.currentSource || configured;
    const source = { ...observed, authMode: configured.authMode,
      providerWarning: configured.authMode === 'guest' ? this.currentSource?.providerWarning || null : null };
    const univus = configured.dataProvider === 'univus';
    const publicOnly = configured.authMode === 'public';
    const guestStatus = univus ? this.univusClient.getStatus() : this.tokenProvider.getStatus();
    const hasToken = !publicOnly && (univus ? Boolean(guestStatus.hasSession) :
      Boolean(guestStatus.tokenExpiresAt && Date.parse(guestStatus.tokenExpiresAt) > now));
    return {
      active: this.running, collectionMode: this.running ? 'scheduled' : 'on-demand',
      source: 'live', ...source, configuredProvider: configured.dataProvider,
      hasToken, requiresToken: false, canPoll: true,
      tokenSource: publicOnly ? 'none' : 'guest',
      tokenExpiresAt: publicOnly ? null : guestStatus.tokenExpiresAt,
      sessionRenewAt: univus ? guestStatus.sessionRenewAt : null,
      connectionState: lastError ? 'error' : lastPolledAt && lastAttemptAt ? 'healthy' : 'pending',
      lastError, isPolling: this.isPolling, isStale: !lastPolledAt || now - lastPolledAt > Math.max(90 * 1000, this.intervalMs * 1.5),
      pollingIntervalSec: this.intervalMs / 1000, lastPolledAt, lastAttemptAt,
      lastPolledIso: lastPolledAt ? new Date(lastPolledAt).toISOString() : null,
      nextPollInSec: this.running ? Math.max(0, Math.ceil((this.intervalMs - (now - lastAttemptAt)) / 1000)) : null,
      totalSnapshots
    };
  }
}
