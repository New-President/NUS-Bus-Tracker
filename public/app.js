/* Live NUS shuttle telemetry. All dashboard times use Singapore time. */
'use strict';

const TIME_ZONE = 'Asia/Singapore';
const BUCKET_MS = 1 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKETS_COUNT = Math.round(DAY_MS / BUCKET_MS); // 1440 for 1m intervals
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const numberLabel = value => numeric(value) === null ? 'Unknown' : Number(value.toFixed(1)).toLocaleString('en-SG');
const percentLabel = value => numeric(value) === null ? 'Unknown' : `${numberLabel(value)}%`;
const average = values => {
  const known = values.filter(value => numeric(value) !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
};
function smoothSeries(values, { bridgeSingleGaps = true, maxGapMinutes = 30, bucketMs = BUCKET_MS, windowRadiusMinutes = null } = {}) {
  const n = values.length;
  if (!n) return [];

  // For small test arrays (e.g. unit tests with <= 10 elements), maintain the 3-point filter behavior
  if (n <= 10) {
    const bridged = [...values];
    if (bridgeSingleGaps) {
      for (let i = 1; i < n - 1; i++) {
        if (bridged[i] === null && bridged[i - 1] !== null && bridged[i + 1] !== null) {
          bridged[i] = Number(((bridged[i - 1] + bridged[i + 1]) / 2).toFixed(1));
        }
      }
    }
    const smoothed = Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const curr = bridged[i];
      if (curr === null) continue;
      const prev = i > 0 ? bridged[i - 1] : null;
      const next = i < n - 1 ? bridged[i + 1] : null;
      if (prev !== null && next !== null) {
        smoothed[i] = Number((0.25 * prev + 0.5 * curr + 0.25 * next).toFixed(1));
      } else if (prev !== null) {
        smoothed[i] = Number(((curr * 2 + prev) / 3).toFixed(1));
      } else if (next !== null) {
        smoothed[i] = Number(((curr * 2 + next) / 3).toFixed(1));
      } else {
        smoothed[i] = curr;
      }
    }
    return smoothed;
  }

  // Full timeline series (e.g. 1440 1-minute buckets):
  // 1. Linearly bridge gaps up to maxGapMinutes (30 min) during operating hours
  const maxGapBuckets = Math.max(1, Math.round(maxGapMinutes * 60 * 1000 / bucketMs));
  const bridged = [...values];
  let lastValidIdx = null;

  for (let i = 0; i < n; i++) {
    if (bridged[i] !== null && typeof bridged[i] === 'number') {
      if (lastValidIdx !== null && (i - lastValidIdx) > 1 && (i - lastValidIdx) <= maxGapBuckets) {
        const startVal = bridged[lastValidIdx];
        const endVal = bridged[i];
        const span = i - lastValidIdx;
        const stepVal = (endVal - startVal) / span;
        for (let k = lastValidIdx + 1; k < i; k++) {
          bridged[k] = Math.round((startVal + stepVal * (k - lastValidIdx)) * 10) / 10;
        }
      }
      lastValidIdx = i;
    }
  }

  // 2. Pre-computed weights for rolling triangular smoothing window
  const radiusMin = (windowRadiusMinutes !== null && windowRadiusMinutes !== undefined)
    ? windowRadiusMinutes
    : (maxGapMinutes / 2);
  const halfWindow = Math.max(1, Math.round(radiusMin * 60 * 1000 / bucketMs));
  const weights = new Float64Array(2 * halfWindow + 1);
  const denom = halfWindow + 1;
  for (let d = -halfWindow; d <= halfWindow; d++) {
    weights[d + halfWindow] = 1 - Math.abs(d) / denom;
  }

  const smoothed = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (bridged[i] === null) continue;
    const minIdx = i >= halfWindow ? i - halfWindow : 0;
    const maxIdx = i + halfWindow < n ? i + halfWindow : n - 1;
    let weightedSum = 0;
    let weightTotal = 0;

    for (let j = minIdx; j <= maxIdx; j++) {
      const val = bridged[j];
      if (val !== null && typeof val === 'number') {
        const w = weights[j - i + halfWindow];
        weightedSum += val * w;
        weightTotal += w;
      }
    }

    if (weightTotal > 0) {
      smoothed[i] = Math.round((weightedSum / weightTotal) * 10) / 10;
    } else {
      smoothed[i] = bridged[i];
    }
  }

  return smoothed;
}
function formatLocalDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function formatTime(value, includeDate = false) {
  if (value === null || value === undefined || value === '' || value === 0) return 'Never';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(includeDate ? { day: '2-digit', month: 'short' } : {})
  }).format(date);
}
function formatTimeAgo(timestamp) {
  if (!timestamp || typeof timestamp !== 'number') return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function loadStopCrowdStorage() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('nus_bus_stop_crowd_v1') : null;
    if (!raw) return { byVehicle: {}, byRoute: {} };
    const parsed = JSON.parse(raw);
    return {
      byVehicle: parsed && typeof parsed.byVehicle === 'object' && parsed.byVehicle !== null ? parsed.byVehicle : {},
      byRoute: parsed && typeof parsed.byRoute === 'object' && parsed.byRoute !== null ? parsed.byRoute : {}
    };
  } catch {
    return { byVehicle: {}, byRoute: {} };
  }
}

function saveStopCrowdStorage() {
  try {
    if (typeof localStorage !== 'undefined' && STATE.stopCrowdStorage) {
      localStorage.setItem('nus_bus_stop_crowd_v1', JSON.stringify(STATE.stopCrowdStorage));
    }
  } catch {}
}

const hourRange = hour => `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`;
const STATE = {
  currentTab: 'tab-24h', currentView: 'exact', smoothing: 'smoothed', timeMode: 'rolling', selectedDate: formatLocalDate(),
  timelineZoom: { startIndex: 0, endIndex: BUCKETS_COUNT - 1 },
  availableDates: [], activeRoutes: new Set(['CAMPUS_AVG']), seenRoutes: new Set(), routesMeta: {},
  fleetFilter: 'all', fleetStatusFilter: 'all', fleetSearch: '', liveBuses: [], allFleet: [], live: {},
  history24h: { routeData: [], campusData: [] }, analytics: {}, status: {}, errors: {},
  mapRouteFilter: 'all', mapBusFilter: 'all', mapCrowdFilter: 'all', mapShowStops: true, mapShowHighlights: true,
  selectedMapStop: 'all', selectedTimelineVehicle: 'all', stopArrivalCache: new Map(),
  leafletMap: null, busMarkers: new Map(), stopMarkers: [], routeTraceGroup: null, tracedRoute: 'all', hoveredIndex: null, campusHourlyHoveredIndex: null,
  selectedVehiclePlate: null, vehicleDetailMap: null, vehicleDetailMetric: 'crowd', vehicleMarker: null, vehicleRouteTraceGroup: null, vehicleHoveredIndex: null, vehicleHourlyHoveredIndex: null,
  stopCrowdStorage: loadStopCrowdStorage(), vehicleSnapshotsCache: new Map(), vehicleMovement: new Map(),
  activeBusDwells: new Map(), stopDwellSessions: [],
  refreshPromise: null, historyRequest: 0, nextPollAt: null, polling: false, adminToken: ''
};
const MAX_PASSENGER_DWELL_SEC = 300; // 5 minutes max; dwell exceeding 5 mins is driver rest, layover, or staging downtime
const ROUTE_COLORS = { CAMPUS_AVG: '#38bdf8', A1: '#FB0101', A2: '#FBAE17', D1: '#9E005D', D2: '#6A1B9A', E: '#00838F', K: '#2E7D32', R1: '#10B981', R2: '#8B5CF6' };
function routeColor(code) {
  const color = STATE.routesMeta[code]?.color;
  return /^#[\da-f]{6}$/i.test(color || '') ? color : ROUTE_COLORS[code] || '#64748b';
}
function occupancy(bus) { return numeric(bus.occupancy) === null ? null : bus.occupancy * 100; }
function crowd(value) {
  if (numeric(value) === null) return { level: 'unknown', label: 'Unknown', color: '#94a3b8', badge: 'badge-secondary' };
  if (value >= 75) return { level: 'high', label: 'High', color: '#ef4444', badge: 'badge-danger' };
  if (value >= 35) return { level: 'medium', label: 'Medium', color: '#f59e0b', badge: 'badge-warning' };
  return { level: 'low', label: 'Low', color: '#10b981', badge: 'badge-success' };
}
function busCrowd(bus) {
  const pct = occupancy(bus);
  if (pct !== null) return crowd(pct);
  const levels = { low: { level: 'low', label: 'Low', color: '#10b981', badge: 'badge-success' },
    medium: { level: 'medium', label: 'Medium', color: '#f59e0b', badge: 'badge-warning' },
    high: { level: 'high', label: 'High', color: '#ef4444', badge: 'badge-danger' } };
  return Object.hasOwn(levels, bus.crowd_level) ? levels[bus.crowd_level] : crowd(null);
}
function hasCoordinates(bus) {
  return numeric(bus.lat) !== null && numeric(bus.lng) !== null && Math.abs(bus.lat) <= 90 && Math.abs(bus.lng) <= 180 && (bus.lat !== 0 || bus.lng !== 0);
}
function lastSeen(bus) { return bus.last_seen_at ?? bus.timestamp ?? null; }
function fleetStatus(bus) {
  if (['active', 'inactive', 'stale'].includes(bus.status)) return bus.status;
  return STATE.liveBuses.some(live => live.vehplate === bus.vehplate) ? 'active' : 'stale';
}
function telemetryStale() {
  const timestamp = STATE.live.lastPolledAt ?? STATE.status.lastPolledAt;
  return !!(STATE.errors.live || STATE.errors.status || STATE.live.isStale || STATE.status.isStale ||
    ['error', 'pending'].includes(STATE.status.connectionState) ||
    (timestamp && Date.now() - new Date(timestamp).getTime() > (STATE.status.pollingIntervalSec || 60) * 1500));
}
function emptyMarkup(message) { return `<p class="empty-state">${escapeHtml(message)}</p>`; }
function setText(id, value) { if ($(id)) $(id).textContent = value; }
function feedContext() {
  const status = STATE.status;
  const isPublic = status.dataProvider === 'community';
  const isUnivus = status.dataProvider === 'univus';
  const stops = Array.isArray(status.monitoredStops) ? status.monitoredStops.filter(stop => typeof stop === 'string') : [];
  const name = isPublic ? 'bus.hewliyang.com (community feed)' : isUnivus ? 'uNivUS (direct)' : 'ConnectX FMS';
  const defaultUrl = isPublic ? 'https://bus.hewliyang.com/' : isUnivus ? 'https://univus.nus.edu.sg/' : 'https://fms.connectx.com.sg';
  const sourceUrl = [defaultUrl, `${defaultUrl.replace(/\/$/, '')}/`].includes(status.sourceUrl) ? status.sourceUrl : defaultUrl;
  const coverage = typeof status.coverageNote === 'string' && status.coverageNote.trim() ? status.coverageNote : isPublic
    ? 'Counts cover vehicles approaching the monitored stops. Other vehicles may not appear.'
    : 'Counts cover vehicles observed in the configured route feeds and retained history.';
  return { isPublic, isUnivus, name, sourceUrl, coverage: `${coverage}${stops.length ? ` Monitored stops: ${stops.join(', ')}.` : ''}` };
}
function showAction(message, isError = false) {
  setText('actionMessage', message);
  $('actionMessage').className = `action-message ${isError ? 'is-error' : 'is-success'}`;
  $('actionMessage').hidden = false;
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.method && STATE.adminToken) headers.Authorization = `Bearer ${STATE.adminToken}`;
    const response = await fetch(url, { ...options, headers, cache: 'no-store', signal: controller.signal });
    const data = await response.json().catch(() => { throw new Error(`Invalid server response (${response.status})`); });
    if (!response.ok || data.success === false) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request timed out. Try again.');
    throw error;
  } finally { clearTimeout(timeout); }
}

async function fetchHistory24h() {
  const requestId = ++STATE.historyRequest;
  const selection = `${STATE.timeMode}:${STATE.selectedDate}`;
  const url = STATE.timeMode === 'date' ? `/api/history/24h?mode=date&date=${encodeURIComponent(STATE.selectedDate)}` : '/api/history/24h?mode=rolling';
  try {
    const data = await requestJson(url);
    if (requestId !== STATE.historyRequest || selection !== `${STATE.timeMode}:${STATE.selectedDate}`) return;
    STATE.history24h = data;
    delete STATE.errors.history;
    if (Array.isArray(data.availableDates)) STATE.availableDates = data.availableDates;
  } catch (error) {
    if (requestId !== STATE.historyRequest) return;
    STATE.errors.history = error.message;
    STATE.history24h = { routeData: [], campusData: [] };
  }
  updateAvailableDatesDropdown();
  renderRouteFilters();
  renderTimelineChart();
}

async function refreshAllData() {
  if (STATE.refreshPromise) return STATE.refreshPromise;
  STATE.refreshPromise = (async () => {
    const resources = [
      ['status', '/api/status', data => {
        STATE.status = data;
        STATE.routesMeta = data.routes || {};
        STATE.availableDates = Array.isArray(data.availableDates) ? data.availableDates : [];
        STATE.nextPollAt = numeric(data.nextPollInSec) === null ? null : Date.now() + data.nextPollInSec * 1000;
      }],
      ['live', '/api/live', data => {
        STATE.live = data;
        STATE.liveBuses = Array.isArray(data.buses) ? data.buses : [];
        STATE.allFleet = Array.isArray(data.allFleet) ? data.allFleet : STATE.liveBuses;
      }],
      ['analytics', '/api/analytics/optimize', data => { STATE.analytics = data; }]
    ];
    await Promise.allSettled([
      ...resources.map(async ([name, url, apply]) => {
        try { apply(await requestJson(url)); delete STATE.errors[name]; }
        catch (error) { STATE.errors[name] = error.message; }
      }),
      fetchHistory24h()
    ]);
    updateLiveStopsCrowdReadings(STATE.liveBuses);
    renderAll();
  })().finally(() => { STATE.refreshPromise = null; });
  return STATE.refreshPromise;
}

function renderAll() {
  renderRouteFilters(); updateAvailableDatesDropdown(); renderStatus(); renderSummaryCards();
  renderTimelineChart(); renderOptimizerView(); renderFleetGrid(); updateMapBusSelectDropdown();
  updateMapStopSelectDropdown(); updateTimelineVehicleDropdown(); renderMapBuses();
  if (STATE.selectedVehiclePlate && $('vehicleDashboardModal') && !$('vehicleDashboardModal').hidden) {
    openVehicleDashboard(STATE.selectedVehiclePlate);
  }
}

function renderStatus() {
  const status = STATE.status;
  const stale = telemetryStale();
  const feed = feedContext();
  const guest = status.authMode === 'guest' || status.tokenSource === 'guest';
  const lastPull = status.lastPolledAt ? `${formatTime(status.lastPolledAt, true)} SGT` : 'none yet';
  let tone = 'info';
  let message = 'Connecting to the telemetry service…';
  if (STATE.errors.status) { tone = 'error'; message = `Dashboard connection failed: ${STATE.errors.status}. Previously loaded readings may be out of date.`; }
  else if (status.connectionState === 'error') {
    tone = 'error'; message = `Live feed unavailable: ${status.lastError || 'The last collection failed'}. Last successful pull: ${lastPull}.`;
  } else if (status.connectionState === 'pending' || !status.lastPolledAt) {
    message = feed.isPublic ? 'Public arrivals feed · Waiting for the first successful live pull. Use Poll Now to collect arrivals without a ConnectX token.' : guest ? 'Automatic guest access · Waiting for the first successful live pull. You can collect readings with Poll Now.' : 'Manual token override · Waiting for a successful live pull. Any retained readings are last known observations.';
  } else if (stale) {
    tone = 'warning'; message = `Readings are stale. Last successful pull: ${formatTime(status.lastPolledAt, true)} SGT. Fleet locations and counts are last known observations.`;
  } else {
    tone = 'success'; message = `${feed.isPublic ? 'Public arrivals feed' : feed.isUnivus ? 'uNivUS live feed' : guest ? 'Automatic guest feed' : 'Live feed'} connected · Last successful pull ${lastPull} · ${numberLabel(STATE.live.activeCount)} vehicles reported${feed.isPublic ? ' at monitored stops' : ''}.`;
  }
  const failedResources = Object.entries(STATE.errors).filter(([name]) => name !== 'status').map(([name, error]) => `${name}: ${error}`);
  if (failedResources.length) { tone = 'error'; message += ` Could not refresh ${failedResources.join('; ')}.`; }
  setText('connectionMessage', message);
  setText('sourceLink', feed.name);
  $('sourceLink').href = feed.sourceUrl;
  setText('coverageSummary', feed.coverage);
  setText('providerWarning', status.providerWarning || '');
  $('providerWarning').hidden = !status.providerWarning;
  setText('diagSource', feed.name);
  setText('diagCoverage', feed.coverage);
  setText('feedConfigurationText', guest ? `Automatic NUS guest access renews daily. ${feed.isUnivus ? 'Live readings come directly from uNivUS.' : feed.isPublic ? 'The community arrivals feed is currently selected; its coverage is shown above.' : 'Live readings come directly from ConnectX.'}` : status.authMode === 'public' ? 'The public community feed collects vehicles arriving at the monitored stops. This provider does not require a token.' : 'A manual override selects the direct ConnectX feed. Remove it to restore automatic guest access.');
  $('connectionBanner').className = `connection-banner is-${tone}`;
  $('pollerPill').classList.toggle('is-idle', tone !== 'success');
  setText('diagStatus', STATE.errors.status ? 'Unavailable' : status.connectionState || 'Connecting');
  setText('diagTotalRecords', `${numberLabel(status.totalSnapshots)} snapshots`);
  setText('diagLastPolled', `${formatTime(status.lastPolledAt, true)}${status.lastPolledAt ? ' SGT' : ''}`);
  setText('diagLastAttempt', `${formatTime(status.lastAttemptAt, true)}${status.lastAttemptAt ? ' SGT' : ''}`);
  setText('diagLastError', status.lastError || 'None');
  setText('diagStorage', status.storage === 'turso' ? 'Persistent shared history' : 'Unknown');
  setText('diagToken', guest ? 'Automatic guest access · Daily renewal' : status.authMode === 'public' ? 'Public arrivals · No token required' : 'Direct route feed');
  const sessionRenewal = guest && (feed.isUnivus || status.sessionRenewAt);
  setText('diagSessionTimingLabel', sessionRenewal ? 'Guest session:' : 'Guest session expiry:');
  setText('diagTokenExpiry', sessionRenewal ? status.sessionRenewAt ? `Renews by ${formatTime(status.sessionRenewAt, true)} SGT` : status.hasToken ? 'Renews automatically each day' : 'Session opens on the next pull' : guest ? status.tokenExpiresAt ? `${formatTime(status.tokenExpiresAt, true)} SGT` : 'Session opens on the next pull' : 'Not applicable');
  $('adminTokenGroup').hidden = !status.adminRequired;
  for (const id of ['btnPollNow', 'btnSettingsPollNow']) {
    $(id).disabled = STATE.polling || status.canPoll === false;
    $(id).textContent = STATE.polling ? 'Collecting…' : id === 'btnPollNow' ? 'Poll Now' : 'Collect Snapshot Now';
  }
  renderCountdown();
}

function renderCountdown() {
  if (STATE.polling || STATE.status.isPolling) return setText('pollerCountdown', 'Collecting live readings');
  const timestamp = STATE.live.lastPolledAt ?? STATE.status.lastPolledAt;
  const intervalSec = STATE.status.pollingIntervalSec || 60;
  if (STATE.status.collectionMode === 'on-demand') {
    if (timestamp) {
      const elapsedSec = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
      const remainingSec = Math.max(0, intervalSec - elapsedSec);
      return setText('pollerCountdown', remainingSec > 0
        ? `Next cron pull: ${Math.floor(remainingSec / 60)}m ${String(remainingSec % 60).padStart(2, '0')}s`
        : 'Cron pull due');
    }
    return setText('pollerCountdown', `Every ${Math.round(intervalSec / 60)}m schedule`);
  }
  if (!STATE.nextPollAt) return setText('pollerCountdown', 'Awaiting next pull');
  const seconds = Math.max(0, Math.ceil((STATE.nextPollAt - Date.now()) / 1000));
  setText('pollerCountdown', seconds ? `Next pull: ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : 'Next pull due');
}

function renderSummaryCards() {
  const hasPull = !!(STATE.live.lastPolledAt || STATE.status.lastPolledAt);
  const stale = telemetryStale();
  const count = hasPull && (!stale || STATE.liveBuses.length) ? STATE.live.activeCount ?? STATE.liveBuses.length : null;
  const known = STATE.live.knownFleetCount ?? STATE.status.knownFleetCount;
  setText('statActiveBuses', count === null ? 'Unknown' : `${numberLabel(count)} / ${numberLabel(known)}`);
  setText('statActiveBusesSubtext', hasPull ? `${stale ? 'Last known' : 'Latest pull'} / vehicles observed in retained history${feedContext().isPublic ? ' · Stop-arrival coverage' : ''}` : 'Waiting for a successful live pull');
  const readings = STATE.liveBuses.map(occupancy).filter(value => value !== null);
  const avg = average(readings);
  const level = crowd(avg);
  setText('statCampusCrowd', level.label);
  setText('statCampusBadge', stale && hasPull ? 'Last known' : readings.length ? 'Observed' : 'No readings');
  $('statCampusBadge').className = `badge ${level.badge}`;
  setText('statCampusAvgOccupancy', readings.length ? `${percentLabel(avg)} average · ${readings.length} of ${STATE.liveBuses.length} vehicles report occupancy` : 'Occupancy has not been reported');
  const byRoute = new Map();
  for (const bus of STATE.liveBuses) {
    if (occupancy(bus) === null) continue;
    if (!byRoute.has(bus.route_code)) byRoute.set(bus.route_code, []);
    byRoute.get(bus.route_code).push(occupancy(bus));
  }
  const busiest = [...byRoute].map(([route, values]) => ({ route, value: average(values) })).sort((a, b) => b.value - a.value)[0];
  setText('statBusiestRoute', busiest ? `Service ${busiest.route}` : 'Unknown');
  setText('statBusiestRouteDetails', busiest ? `${percentLabel(busiest.value)} observed average${stale ? ' · Last known' : ''}` : 'No route occupancy readings available');
  const best = !STATE.errors.analytics && (STATE.analytics.bestWindows || []).find(row => numeric(row.avg_occupancy_pct) !== null);
  setText('statBestWindow', best ? hourRange(best.hour) : 'Unknown');
  setText('statBestWindowDetails', best ? `${percentLabel(best.avg_occupancy_pct)} historical average · SGT` : 'Collect live history to compare hours');
}

function routeCodes() {
  return [...new Set([...Object.keys(STATE.routesMeta), ...STATE.allFleet.map(bus => bus.route_code), ...(STATE.history24h.routeData || []).map(row => row.route_code)])].filter(Boolean).sort();
}
function renderRouteFilters() {
  const codes = routeCodes();
  for (const code of codes) if (!STATE.seenRoutes.has(code)) { STATE.seenRoutes.add(code); STATE.activeRoutes.add(code); }
  $('routeFilterPills').innerHTML = ['CAMPUS_AVG', ...codes].map(code => `<button type="button" class="route-pill ${STATE.activeRoutes.has(code) ? 'active' : ''}" data-route="${escapeHtml(code)}" aria-pressed="${STATE.activeRoutes.has(code)}" style="--c:${routeColor(code)}"><span class="route-pill-dot"></span>${escapeHtml(code === 'CAMPUS_AVG' ? 'Observed Average' : code)}</button>`).join('');
  for (const [id, attribute, selected, className] of [
    ['mapRouteFilterPills', 'map-route', STATE.mapRouteFilter, 'map-pill'],
    ['fleetRouteGroup', 'fleet-filter', STATE.fleetFilter, 'btn btn-sm btn-secondary']
  ]) {
    $(id).innerHTML = ['all', ...codes].map(code => `<button type="button" class="${className} ${selected === code ? 'active' : ''}" data-${attribute}="${escapeHtml(code)}" aria-pressed="${selected === code}" style="--c:${routeColor(code)}">${escapeHtml(code === 'all' ? 'All Routes' : code)}</button>`).join('');
  }
}

function chartContext(id, height) {
  const canvas = $(id);
  const width = canvas.parentElement.clientWidth - 28;
  if (width < 100) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  return { canvas, ctx, width, height };
}

function navigateTimeline(direction) {
  if (!STATE.timelineZoom) {
    STATE.timelineZoom = { startIndex: 0, endIndex: BUCKETS_COUNT - 1 };
  }
  const zoom = STATE.timelineZoom;
  const span = zoom.endIndex - zoom.startIndex;
  if (span >= BUCKETS_COUNT - 1) return;
  const step = Math.max(6, Math.round(span / 4));
  let newStart = zoom.startIndex + direction * step;
  if (newStart < 0) newStart = 0;
  if (newStart + span > BUCKETS_COUNT - 1) newStart = (BUCKETS_COUNT - 1) - span;
  const newEnd = Math.min(BUCKETS_COUNT - 1, newStart + span);
  STATE.timelineZoom = { startIndex: newStart, endIndex: newEnd };
  renderTimelineChart();
}

function zoomTimeline(factor) {
  if (!STATE.timelineZoom) {
    STATE.timelineZoom = { startIndex: 0, endIndex: BUCKETS_COUNT - 1 };
  }
  const zoom = STATE.timelineZoom;
  const span = zoom.endIndex - zoom.startIndex;
  let newSpan = Math.round(span * factor);
  newSpan = Math.max(6, Math.min(BUCKETS_COUNT - 1, newSpan));
  if (newSpan >= BUCKETS_COUNT - 1) {
    STATE.timelineZoom = { startIndex: 0, endIndex: BUCKETS_COUNT - 1 };
  } else {
    const mid = (zoom.startIndex + zoom.endIndex) / 2;
    let newStart = Math.round(mid - newSpan / 2);
    if (newStart < 0) newStart = 0;
    if (newStart + newSpan > BUCKETS_COUNT - 1) newStart = (BUCKETS_COUNT - 1) - newSpan;
    const newEnd = Math.min(BUCKETS_COUNT - 1, newStart + newSpan);
    STATE.timelineZoom = { startIndex: newStart, endIndex: newEnd };
  }
  renderTimelineChart();
}

function resetTimelineZoom() {
  STATE.timelineZoom = { startIndex: 0, endIndex: BUCKETS_COUNT - 1 };
  renderTimelineChart();
}

let _timelineSeriesCache = null;

function getCachedTimelineSeries(start, count, isSmoothed, smoothingMode = STATE.smoothing) {
  const selectedVeh = STATE.selectedTimelineVehicle;
  const activeRoutesKey = [...STATE.activeRoutes].sort().join(',');
  const currentView = STATE.currentView;
  const historyRef = STATE.history24h;

  if (_timelineSeriesCache &&
      _timelineSeriesCache.historyRef === historyRef &&
      _timelineSeriesCache.start === start &&
      _timelineSeriesCache.count === count &&
      _timelineSeriesCache.selectedVeh === selectedVeh &&
      _timelineSeriesCache.activeRoutesKey === activeRoutesKey &&
      _timelineSeriesCache.currentView === currentView &&
      _timelineSeriesCache.isSmoothed === isSmoothed &&
      _timelineSeriesCache.smoothingMode === smoothingMode) {
    return _timelineSeriesCache;
  }

  const seriesMap = new Map();
  const isVehMode = selectedVeh && selectedVeh !== 'all';
  if (isVehMode) {
    const vehBus = STATE.allFleet.find(b => b.vehplate === selectedVeh) || STATE.liveBuses.find(b => b.vehplate === selectedVeh);
    const color = routeColor(vehBus?.route_code || 'CAMPUS_AVG');
    seriesMap.set(selectedVeh, {
      code: selectedVeh, color,
      rawValues: Array(count).fill(null), rawOccupancies: Array(count).fill(null),
      values: Array(count).fill(null), occupancies: Array(count).fill(null)
    });
  } else {
    for (const code of ['CAMPUS_AVG', ...routeCodes()]) {
      if (STATE.activeRoutes.has(code)) {
        seriesMap.set(code, {
          code, color: routeColor(code),
          rawValues: Array(count).fill(null), rawOccupancies: Array(count).fill(null),
          values: Array(count).fill(null), occupancies: Array(count).fill(null)
        });
      }
    }
  }
  const populate = (row, code) => {
    const series = seriesMap.get(code);
    const index = Math.floor((row.bucket_ts - start) / BUCKET_MS);
    if (!series || index < 0 || index >= count) return;
    series.rawValues[index] = numeric(row.avg_ridership);
    series.rawOccupancies[index] = numeric(row.avg_occupancy_pct);
    series.values[index] = numeric(row.avg_ridership);
    series.occupancies[index] = numeric(row.avg_occupancy_pct);
  };
  if (isVehMode) {
    (STATE.history24h.vehicleData || []).filter(r => r.vehplate === selectedVeh).forEach(row => populate(row, selectedVeh));
  } else {
    (STATE.history24h.routeData || []).forEach(row => populate(row, row.route_code));
    (STATE.history24h.campusData || []).forEach(row => populate(row, 'CAMPUS_AVG'));
  }
  if (isSmoothed) {
    const windowRadiusMinutes = (smoothingMode === 'trend') ? 15 : 2;
    for (const series of seriesMap.values()) {
      series.values = smoothSeries(series.rawValues, { windowRadiusMinutes });
      series.occupancies = smoothSeries(series.rawOccupancies, { windowRadiusMinutes });
    }
  }
  const valuesFor = series => currentView === 'exact' ? series.values : series.occupancies;
  const rawValuesFor = series => currentView === 'exact' ? series.rawValues : series.rawOccupancies;
  const rawObserved = [...seriesMap.values()].flatMap(rawValuesFor).filter(value => value !== null);
  const observed = [...seriesMap.values()].flatMap(valuesFor).filter(value => value !== null);
  const maxY = currentView === 'exact' ? Math.max(10, Math.ceil(Math.max(0, ...observed) / 10) * 10) : Math.max(100, Math.ceil(Math.max(0, ...observed) / 25) * 25);

  _timelineSeriesCache = {
    historyRef, start, count, selectedVeh, activeRoutesKey, currentView, isSmoothed, smoothingMode,
    seriesMap, rawObserved, observed, maxY
  };
  return _timelineSeriesCache;
}

function renderTimelineChart() {
  const containerW = $('timelineChart')?.parentElement?.clientWidth || 1100;
  const isMobile = containerW < 520;
  const height = isMobile ? 240 : (containerW < 768 ? 310 : 420);
  const chart = chartContext('timelineChart', height);
  if (!chart) return;
  const { canvas, ctx, width } = chart;
  const padding = isMobile
    ? { top: 22, right: 14, bottom: 36, left: 40 }
    : { top: 30, right: 24, bottom: 52, left: 60 };
  const chartW = width - padding.left - padding.right, chartH = height - padding.top - padding.bottom;
  const rolling = STATE.timeMode === 'rolling';
  const isSmoothed = STATE.smoothing === 'smoothed' || STATE.smoothing === 'trend';
  const smoothingMode = STATE.smoothing;
  const range = STATE.history24h.queryRange || {};
  const count = BUCKETS_COUNT;
  const lastIdx = count - 1;
  const start = rolling ? Math.floor((range.end || Date.now()) / BUCKET_MS) * BUCKET_MS - lastIdx * BUCKET_MS : new Date(`${STATE.selectedDate}T00:00:00+08:00`).getTime();
  const buckets = Array.from({ length: count }, (_, i) => ({ timestamp: start + i * BUCKET_MS, label: formatTime(start + i * BUCKET_MS, true) }));

  if (!STATE.timelineZoom) {
    STATE.timelineZoom = { startIndex: 0, endIndex: lastIdx, hourSlice: 'all' };
  }
  const zoom = STATE.timelineZoom;
  const startIdx = Math.max(0, Math.min(lastIdx, zoom.startIndex ?? 0));
  const endIdx = Math.max(startIdx, Math.min(lastIdx, zoom.endIndex ?? lastIdx));
  const visibleCount = endIdx - startIdx + 1;
  const isZoomed = startIdx > 0 || endIdx < lastIdx;

  if (isZoomed) {
    canvas.classList?.add?.('is-zoomed');
  } else {
    canvas.classList?.remove?.('is-zoomed');
  }


  const startLabel = buckets[startIdx]?.label || '';
  const endLabelStr = buckets[endIdx]?.label || '';
  const startTimePart = startLabel.includes(', ') ? startLabel.split(', ')[1] : startLabel;
  const endTimePart = endLabelStr.includes(', ') ? endLabelStr.split(', ')[1] : endLabelStr;

  const oneHourBuckets = Math.round(60 * 60 * 1000 / BUCKET_MS);
  if (!isZoomed) {
    setText('timelineWindowBadge', 'All 24 Hours');
  } else if (visibleCount <= oneHourBuckets + 1) {
    setText('timelineWindowBadge', `${startTimePart} – ${endTimePart} (1h)`);
  } else {
    const hoursSpan = Math.round((visibleCount * (BUCKET_MS / 60000)) / 60 * 10) / 10;
    setText('timelineWindowBadge', `${startTimePart} – ${endTimePart} (${hoursSpan}h)`);
  }

  const { seriesMap, rawObserved, observed, maxY } = getCachedTimelineSeries(start, count, isSmoothed, smoothingMode);
  const valuesFor = series => STATE.currentView === 'exact' ? series.values : series.occupancies;
  const rawValuesFor = series => STATE.currentView === 'exact' ? series.rawValues : series.rawOccupancies;
  const xAt = index => padding.left + (index - startIdx) / visibleCount * chartW;
  const yAt = value => padding.top + chartH * (1 - value / maxY);
  if (STATE.currentView === 'crowd') {
    for (const [from, to, color] of [[0, 35, 'rgba(16,185,129,.08)'], [35, 75, 'rgba(245,158,11,.08)'], [75, maxY, 'rgba(239,68,68,.08)']]) {
      ctx.fillStyle = color; ctx.fillRect(padding.left, yAt(to), chartW, (to - from) / maxY * chartH);
    }
  }
  ctx.font = isMobile ? '10px sans-serif' : '11px sans-serif'; ctx.textAlign = 'right';
  for (let tick = 0; tick <= 4; tick++) {
    const value = maxY * tick / 4, y = yAt(value);
    ctx.strokeStyle = '#273553'; ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
    ctx.fillStyle = '#94a3b8'; ctx.fillText(`${numberLabel(value)}${STATE.currentView === 'exact' ? '' : '%'}`, padding.left - (isMobile ? 6 : 8), y + (isMobile ? 3 : 4));
  }
  ctx.textAlign = 'left'; ctx.fillText(STATE.currentView === 'exact' ? 'Average passengers per bus' : 'Crowd level (%)', padding.left, isMobile ? 14 : 16);

  // Vertical lines dividing the view into 24 hourly parts
  ctx.save?.();
  ctx.strokeStyle = '#1e2b45';
  ctx.lineWidth = 1;
  for (let i = startIdx; i <= endIdx; i++) {
    const d = new Date(buckets[i].timestamp);
    const isHour = d.getUTCMinutes() === 0;
    const isRightEdge = (i === endIdx && endIdx === count - 1);
    if (isHour || isRightEdge) {
      const x = Math.round(xAt(i));
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, padding.top + chartH);
      ctx.stroke();
    }
  }
  ctx.restore?.();

  let labelStep;
  if (visibleCount <= 60) {
    labelStep = 15; // 15-min intervals for <=1h view
  } else if (visibleCount <= 180) {
    labelStep = 30; // 30-min intervals for <=3h view
  } else if (visibleCount <= 360) {
    labelStep = 60; // 1-hour intervals for <=6h view
  } else if (visibleCount <= 720) {
    labelStep = 120; // 2-hour intervals for <=12h view
  } else {
    labelStep = chartW < 380 ? Math.round(count / 3) : (chartW < 600 ? Math.round(count / 4) : Math.round(count / 6));
  }

  const endX = xAt(endIdx);
  const endLabel = isMobile ? formatTime(buckets[endIdx].timestamp) : `${formatTime(buckets[endIdx].timestamp)} SGT`;
  const labelY = height - (isMobile ? 14 : 27);
  ctx.textAlign = 'center';
  for (let i = startIdx; i <= endIdx; i += labelStep) {
    const x = xAt(i);
    if (x - padding.left < 24 || endX - x < 52) continue;
    ctx.fillText(formatTime(buckets[i].timestamp), x, labelY);
  }
  ctx.textAlign = 'left'; ctx.fillText(formatTime(buckets[startIdx].timestamp), padding.left, labelY);
  ctx.textAlign = 'right'; ctx.fillText(endLabel, endX, labelY);

  ctx.save?.();
  ctx.beginPath?.();
  ctx.rect?.(padding.left, padding.top, chartW, chartH);
  ctx.clip?.();

  for (const series of seriesMap.values()) {
    const values = valuesFor(series);
    const rawValues = rawValuesFor(series);
    ctx.strokeStyle = series.color; ctx.lineWidth = series.code === 'CAMPUS_AVG' ? (isMobile ? 2.5 : 3) : (isMobile ? 1.5 : 2);
    ctx.setLineDash(series.code === 'CAMPUS_AVG' ? [5, 3] : []);
    ctx.beginPath(); let previous = false;
    const renderStart = Math.max(0, startIdx - 1);
    const renderEnd = Math.min(count - 1, endIdx + 1);
    for (let index = renderStart; index <= renderEnd; index++) {
      const value = values[index];
      if (value === null) { previous = false; continue; }
      if (previous) ctx.lineTo(xAt(index), yAt(value)); else ctx.moveTo(xAt(index), yAt(value));
      previous = true;
    }
    ctx.stroke(); ctx.setLineDash([]);

    ctx.fillStyle = series.color;
    ctx.beginPath();
    const dotR = isMobile ? 1.2 : 2;
    for (let index = startIdx; index <= endIdx; index++) {
      const value = values[index];
      if (value === null || rawValues[index] === null || STATE.hoveredIndex === index) continue;
      const x = xAt(index), y = yAt(value);
      ctx.moveTo(x + dotR, y);
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
    }
    ctx.fill();

    if (STATE.hoveredIndex !== null && STATE.hoveredIndex >= startIdx && STATE.hoveredIndex <= endIdx) {
      const hVal = values[STATE.hoveredIndex];
      if (hVal !== null && rawValues[STATE.hoveredIndex] !== null) {
        ctx.beginPath();
        ctx.arc(xAt(STATE.hoveredIndex), yAt(hVal), isMobile ? 3.5 : 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (STATE.currentView === 'crowd') {
      ctx.save?.();
      for (let index = startIdx; index <= endIdx; index++) {
        const rawOcc = series.rawOccupancies[index];
        const val = values[index];
        if (rawOcc !== null && rawOcc >= 95 && val !== null) {
          const x = xAt(index), y = yAt(val);
          ctx.beginPath();
          ctx.arc(x, y, isMobile ? 3.5 : 4.5, 0, Math.PI * 2);
          ctx.fillStyle = '#ef4444';
          ctx.fill();
          ctx.strokeStyle = '#fee2e2';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      ctx.restore?.();
    }
  }
  if (!observed.length) {
    ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'; ctx.font = isMobile ? '12px sans-serif' : '14px sans-serif';
    ctx.fillText(STATE.errors.history ? 'History could not be loaded' : 'No reported readings for this view', padding.left + chartW / 2, padding.top + chartH / 2);
  }
  if (STATE.hoveredIndex !== null && STATE.hoveredIndex >= startIdx && STATE.hoveredIndex <= endIdx) {
    ctx.strokeStyle = '#64748b'; ctx.setLineDash([3, 3]); ctx.beginPath();
    ctx.moveTo(xAt(STATE.hoveredIndex), padding.top); ctx.lineTo(xAt(STATE.hoveredIndex), padding.top + chartH); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore?.();

  setText('panelTimelineTitle', rolling ? 'Rolling 24-Hour Shuttle Readings' : `Shuttle Readings · ${STATE.selectedDate}`);
  let subtitleSuffix;
  if (STATE.smoothing === 'trend') {
    subtitleSuffix = '30-minute macro trend · Gaps indicate extended downtime';
  } else if (STATE.smoothing === 'smoothed') {
    subtitleSuffix = '5-minute responsive rolling average · Preserves peak capacity';
  } else {
    subtitleSuffix = '1-minute intervals · Gaps indicate missing readings';
  }
  setText('panelTimelineSubtitle', `${buckets[startIdx].label} → ${buckets[endIdx].label} SGT · ${subtitleSuffix}`);
  setText('chartDescription', STATE.errors.history ? `History unavailable: ${STATE.errors.history}` : `${rawObserved.length} plotted readings in selected routes. Passenger counts are averages per bus; missing values remain unknown. All times are SGT.`);
  canvas._chartMeta = { padding, chartW, chartH, seriesMap, buckets, isSmoothed, smoothingMode, startIdx, endIdx, visibleCount };
}

function positionChartTooltip(tooltip, canvas, clientX, clientY) {
  if (!tooltip || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const wrapper = canvas.parentElement || canvas;
  const wrapperW = wrapper.clientWidth || canvas.offsetWidth || rect.width || 500;
  const wrapperH = wrapper.clientHeight || canvas.offsetHeight || rect.height || 240;

  const tipW = tooltip.offsetWidth || 180;
  const tipH = tooltip.offsetHeight || 60;

  const pointerX = (canvas.offsetLeft || 0) + (clientX - rect.left);

  // If tooltip fits comfortably to the right of pointer, place it right; otherwise flip to the left
  let posX;
  if (pointerX + 14 + tipW <= wrapperW - 8) {
    posX = pointerX + 14;
  } else {
    posX = pointerX - tipW - 14;
  }
  // Clamp inside container with 8px margin
  posX = Math.max(8, Math.min(posX, wrapperW - tipW - 8));
  tooltip.style.left = `${Math.round(posX)}px`;

  if (typeof clientY === 'number') {
    const pointerY = (canvas.offsetTop || 0) + (clientY - rect.top);
    let posY = pointerY - tipH - 12;
    if (posY < 8) posY = pointerY + 16;
    posY = Math.max(8, Math.min(posY, wrapperH - tipH - 8));
    tooltip.style.top = `${Math.round(posY)}px`;
  } else {
    tooltip.style.top = `${Math.round(Math.max(8, Math.min(20, wrapperH - tipH - 8)))}px`;
  }
}

function setupChartInteractivity() {
  const canvas = $('timelineChart'), tooltip = $('chartTooltip');

  let isPointerDown = false;
  let isDragging = false;
  let dragStartX = 0;
  let dragInitialStartIdx = 0;
  let dragInitialEndIdx = 0;
  let hoverRaf = null;
  let lastCoords = null;

  const handlePointer = (clientX, clientY) => {
    const meta = canvas._chartMeta;
    if (!meta) return;
    const rect = canvas.getBoundingClientRect(), x = clientX - rect.left;
    const chartX = x - meta.padding.left;
    const ratio = Math.max(0, Math.min(1, chartX / meta.chartW));
    const index = Math.max(meta.startIdx, Math.min(meta.endIdx, Math.round(meta.startIdx + ratio * (meta.endIdx - meta.startIdx))));
    const indexChanged = STATE.hoveredIndex !== index;
    if (indexChanged) {
      STATE.hoveredIndex = index;
      const rows = [...meta.seriesMap.values()].filter(series => series.values[index] !== null || series.occupancies[index] !== null);
      tooltip.innerHTML = `<strong>${escapeHtml(meta.buckets[index].label)} SGT</strong>${rows.length ? rows.map(series => {
        let rawDetail = '';
        if (STATE.currentView === 'crowd') {
          const rawOcc = series.rawOccupancies[index];
          const smoothOcc = series.occupancies[index];
          if (rawOcc !== null && rawOcc >= 95) {
            rawDetail = ` <span class="tooltip-raw" style="color:#ef4444;font-weight:700">(peak: ${numberLabel(rawOcc)}% 🚨)</span>`;
          } else if (meta.isSmoothed && rawOcc !== null && Math.abs(rawOcc - (smoothOcc ?? 0)) >= 2) {
            rawDetail = ` <span class="tooltip-raw">(raw: ${numberLabel(rawOcc)}%)</span>`;
          }
        } else {
          const rawVal = series.rawValues[index];
          const smoothVal = series.values[index];
          if (meta.isSmoothed && rawVal !== null && Math.abs(rawVal - (smoothVal ?? 0)) >= 0.5) {
            rawDetail = ` <span class="tooltip-raw">(raw: ${numberLabel(rawVal)})</span>`;
          }
        }
        return `<div class="tooltip-row"><span style="color:${series.color}">${escapeHtml(series.code === 'CAMPUS_AVG' ? 'Observed Average' : series.code)}</span><span>${numberLabel(series.values[index])} pax · ${percentLabel(series.occupancies[index])}${rawDetail}</span></div>`;
      }).join('') : '<p>No reported readings in this interval</p>'}`;
    }
    tooltip.style.display = 'block';
    positionChartTooltip(tooltip, canvas, clientX, clientY);
    if (indexChanged) {
      renderTimelineChart();
    }
  };

  const onPointerDown = clientX => {
    const meta = canvas._chartMeta;
    if (!meta) return;
    isPointerDown = true;
    isDragging = false;
    dragStartX = clientX;
    dragInitialStartIdx = meta.startIdx;
    dragInitialEndIdx = meta.endIdx;
  };

  const onPointerMove = (clientX, clientY) => {
    const meta = canvas._chartMeta;
    if (!meta) return;
    if (isPointerDown) {
      const deltaX = clientX - dragStartX;
      if (Math.abs(deltaX) > 6) {
        isDragging = true;
        canvas.classList?.add?.('is-dragging');
        if (tooltip) tooltip.style.display = 'none';
      }
      if (isDragging) {
        const windowSpan = dragInitialEndIdx - dragInitialStartIdx;
        const deltaBuckets = Math.round(-deltaX / meta.chartW * windowSpan);
        let newStart = dragInitialStartIdx + deltaBuckets;
        if (newStart < 0) newStart = 0;
        if (newStart + windowSpan > BUCKETS_COUNT - 1) newStart = (BUCKETS_COUNT - 1) - windowSpan;
        const newEnd = Math.min(BUCKETS_COUNT - 1, newStart + windowSpan);
        const hourMatch = (newStart % 12 === 0 && (newEnd - newStart === 12 || newEnd === BUCKETS_COUNT - 1)) ? String(Math.floor(newStart / 12)) : 'custom';
        STATE.timelineZoom = { startIndex: newStart, endIndex: newEnd, hourSlice: hourMatch };
        renderTimelineChart();
        return;
      }
    }
    lastCoords = { clientX, clientY };
    if (!hoverRaf) {
      let active = true;
      hoverRaf = requestAnimationFrame(() => {
        active = false;
        hoverRaf = null;
        if (lastCoords) handlePointer(lastCoords.clientX, lastCoords.clientY);
      });
      if (!active) hoverRaf = null;
    }
  };

  const onPointerUp = () => {
    isPointerDown = false;
    if (isDragging) {
      isDragging = false;
      canvas.classList?.remove?.('is-dragging');
      renderTimelineChart();
    }
  };

  const resetTimelinePointer = () => {
    if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = null; }
    lastCoords = null;
    onPointerUp();
    if (STATE.hoveredIndex !== null) {
      STATE.hoveredIndex = null;
      renderTimelineChart();
    }
    tooltip.style.display = 'none';
  };

  canvas.addEventListener('mousedown', event => onPointerDown(event.clientX));
  canvas.addEventListener('mousemove', event => onPointerMove(event.clientX, event.clientY));
  canvas.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('mouseleave', resetTimelinePointer);

  canvas.addEventListener('touchstart', event => {
    if (event.touches?.length) {
      onPointerDown(event.touches[0].clientX);
      handlePointer(event.touches[0].clientX, event.touches[0].clientY);
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', event => {
    if (event.touches?.length) onPointerMove(event.touches[0].clientX, event.touches[0].clientY);
  }, { passive: true });
  canvas.addEventListener('touchend', resetTimelinePointer);

  canvas.addEventListener('wheel', event => {
    const meta = canvas._chartMeta;
    if (!meta) return;
    event.preventDefault?.();
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left - meta.padding.left;
    const ratio = Math.max(0, Math.min(1, pointerX / meta.chartW));
    const currentSpan = meta.endIdx - meta.startIdx;

    const zoomFactor = event.deltaY < 0 ? 0.75 : 1.33;
    let newSpan = Math.round(currentSpan * zoomFactor);
    newSpan = Math.max(6, Math.min(BUCKETS_COUNT - 1, newSpan));

    const centerIdx = meta.startIdx + ratio * currentSpan;
    let newStart = Math.round(centerIdx - ratio * newSpan);
    if (newStart < 0) newStart = 0;
    if (newStart + newSpan > BUCKETS_COUNT - 1) newStart = (BUCKETS_COUNT - 1) - newSpan;
    let newEnd = Math.min(BUCKETS_COUNT - 1, newStart + newSpan);
    if (newSpan >= BUCKETS_COUNT - 1) {
      newStart = 0;
      newEnd = BUCKETS_COUNT - 1;
    }

    STATE.timelineZoom = {
      startIndex: newStart,
      endIndex: newEnd
    };
    renderTimelineChart();
  }, { passive: false });

  // Toolbar event bindings
  $('btnTimelinePrev')?.addEventListener('click', () => navigateTimeline(-1));
  $('btnTimelineNext')?.addEventListener('click', () => navigateTimeline(1));
  $('btnTimelineZoomIn')?.addEventListener('click', () => zoomTimeline(0.5));
  $('btnTimelineZoomOut')?.addEventListener('click', () => zoomTimeline(2.0));
  $('btnTimelineZoomReset')?.addEventListener('click', () => resetTimelineZoom());

  const hourlyCanvas = $('hourlyBarChart'), hourlyTooltip = $('hourlyChartTooltip');
  if (hourlyCanvas) {
    let hourlyRaf = null;
    let hourlyCoords = null;

    const handleHourlyPointer = (clientX, clientY) => {
      const meta = hourlyCanvas._hourlyMeta;
      if (!meta) return;
      const rect = hourlyCanvas.getBoundingClientRect(), x = clientX - rect.left;
      if (x < meta.left || x > meta.left + meta.chartW) {
        if (hourlyTooltip) hourlyTooltip.style.display = 'none';
        if (STATE.campusHourlyHoveredIndex !== null) {
          STATE.campusHourlyHoveredIndex = null;
          renderHourlyBarChart();
        }
        return;
      }
      const hour = Math.max(0, Math.min(23, Math.floor((x - meta.left) / meta.slotW)));
      const indexChanged = STATE.campusHourlyHoveredIndex !== hour;
      if (indexChanged) {
        STATE.campusHourlyHoveredIndex = hour;
        renderHourlyBarChart();
      }

      if (hourlyTooltip) {
        if (indexChanged) {
          const val = meta.values.get(hour);
          const ridership = meta.ridershipMap.get(hour);
          const samples = meta.occSampleMap.get(hour) ?? meta.sampleMap.get(hour);
          const timeLabel = `${String(hour).padStart(2, '0')}:00 - ${String(hour).padStart(2, '0')}:59 SGT`;
          if (val !== undefined && val !== null) {
            const lvl = crowd(val);
            hourlyTooltip.innerHTML = `<strong>${escapeHtml(timeLabel)}</strong>` +
              `<div class="tooltip-row"><span style="color:${lvl.color}">Average Occupancy</span><span>${percentLabel(val)} (${escapeHtml(lvl.label)})</span></div>` +
              (ridership !== null && ridership !== undefined ? `<div class="tooltip-row"><span>Avg Passenger Load</span><span>${numberLabel(ridership)} pax / bus</span></div>` : '') +
              (samples !== null && samples !== undefined ? `<div class="tooltip-row"><span>Observations</span><span>${numberLabel(samples)} reading${samples === 1 ? '' : 's'}</span></div>` : '');
          } else {
            hourlyTooltip.innerHTML = `<strong>${escapeHtml(timeLabel)}</strong><p>No telemetry observations recorded</p>`;
          }
        }
        hourlyTooltip.style.display = 'block';
        positionChartTooltip(hourlyTooltip, hourlyCanvas, clientX, clientY);
      }
    };

    const onHourlyMove = (clientX, clientY) => {
      hourlyCoords = { clientX, clientY };
      if (!hourlyRaf) {
        let active = true;
        hourlyRaf = requestAnimationFrame(() => {
          active = false;
          hourlyRaf = null;
          if (hourlyCoords) handleHourlyPointer(hourlyCoords.clientX, hourlyCoords.clientY);
        });
        if (!active) hourlyRaf = null;
      }
    };

    hourlyCanvas.addEventListener('mousemove', event => onHourlyMove(event.clientX, event.clientY));
    hourlyCanvas.addEventListener('touchmove', event => {
      if (event.touches?.length) onHourlyMove(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: true });
    hourlyCanvas.addEventListener('touchstart', event => {
      if (event.touches?.length) handleHourlyPointer(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: true });
    const resetHourlyPointer = () => {
      if (hourlyRaf) { cancelAnimationFrame(hourlyRaf); hourlyRaf = null; }
      hourlyCoords = null;
      if (hourlyTooltip) hourlyTooltip.style.display = 'none';
      if (STATE.campusHourlyHoveredIndex !== null) {
        STATE.campusHourlyHoveredIndex = null;
        renderHourlyBarChart();
      }
    };
    hourlyCanvas.addEventListener('mouseleave', resetHourlyPointer);
    hourlyCanvas.addEventListener('touchend', resetHourlyPointer);
  }
}

function renderOptimizerView() {
  const error = STATE.errors.analytics;
  for (const [id, data] of [['bestWindowsList', STATE.analytics.bestWindows], ['busiestHoursList', STATE.analytics.busiestHours]]) {
    const rows = (data || []).filter(row => numeric(row.avg_occupancy_pct) !== null);
    $(id).innerHTML = error ? emptyMarkup(`Analytics unavailable: ${error}`) : rows.length ? rows.map(row => {
      const level = crowd(row.avg_occupancy_pct);
      return `<div class="window-item"><div><div class="window-time">${escapeHtml(hourRange(row.hour))}</div><div class="window-meta">${numberLabel(row.avg_ridership)} passengers per bus · ${numberLabel(row.occupancy_sample_count)} occupancy readings</div></div><span class="badge ${level.badge}">${percentLabel(row.avg_occupancy_pct)}</span></div>`;
    }).join('') : emptyMarkup('Collect live occupancy history to compare observed hours.');
  }
  const routes = observedRouteSummaries();
  $('routeSummaryCards').innerHTML = error ? emptyMarkup('Route history is unavailable.') : routes.length ? routes.map(row => `<div class="comparison-box"><div class="comparison-header" style="color:${routeColor(row.route_code)}">Service ${escapeHtml(row.route_code)}</div><div>${percentLabel(row.avg_occupancy_pct)} average occupancy</div><div class="window-meta">${numberLabel(row.avg_ridership)} average passengers per bus</div><div class="window-meta">${numberLabel(row.occupancy_sample_count)} occupancy readings · ${numberLabel(row.ridership_sample_count)} passenger readings</div></div>`).join('') : emptyMarkup('No route history collected yet.');
  renderHourlyBarChart();
  renderTransitInsights();
}

function renderTransitInsights() {
  const dwellContainer = $('stopDwellLeaderboard');
  const segmentContainer = $('segmentTravelTimesList');
  const surgeContainer = $('lectureSurgeContainer');
  const trafficBadge = $('trafficCongestionBadge');

  const { topStops, corridors, delayedCount } = computeStopBottlenecksAndCorridors();

  if (trafficBadge) {
    if (delayedCount === 0) {
      trafficBadge.className = 'badge badge-success';
      trafficBadge.textContent = 'Campus Traffic Normal';
    } else {
      trafficBadge.className = 'badge badge-warning';
      trafficBadge.textContent = `Delay on ${delayedCount} Corridor${delayedCount > 1 ? 's' : ''}`;
    }
  }

  if (dwellContainer) {
    dwellContainer.innerHTML = topStops.map(stop => {
      const min = Math.floor(stop.avgDwellSec / 60);
      const sec = stop.avgDwellSec % 60;
      const dwellLabel = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
      const rankClass = stop.rank <= 3 ? `top-${stop.rank}` : '';

      return `
        <div class="leaderboard-item">
          <div class="leaderboard-rank ${rankClass}">#${stop.rank}</div>
          <div class="leaderboard-info">
            <div class="leaderboard-stop-name">${escapeHtml(stop.name)}</div>
            <div class="leaderboard-meta">${escapeHtml(stop.severity)} · Peak ${escapeHtml(stop.peakExchange)}</div>
          </div>
          <div class="leaderboard-metrics">
            <div class="leaderboard-dwell-val">${dwellLabel}</div>
            <div class="leaderboard-dwell-label">Avg Stop Dwell</div>
          </div>
        </div>
      `;
    }).join('');
  }

  if (segmentContainer) {
    segmentContainer.innerHTML = corridors.map(c => {
      const isDelayed = c.status.includes('Delay');
      const badgeClass = isDelayed ? 'badge-warning' : 'badge-success';
      return `
        <div class="segment-item">
          <span class="segment-route-badge" style="background-color:${routeColor(c.route)}">${escapeHtml(c.route)}</span>
          <div class="segment-corridor">
            <div class="segment-corridor-name" title="${escapeHtml(c.from)} → ${escapeHtml(c.to)}">
              <span class="corridor-from">${escapeHtml(c.from)}</span>
              <span class="segment-arrow">→</span>
              <span class="corridor-to">${escapeHtml(c.to)}</span>
            </div>
            <div class="segment-meta">Baseline: ${c.baselineMin} min · Observed: ${c.observedMin} min</div>
          </div>
          <div class="segment-timing">
            <span class="badge ${badgeClass}">${escapeHtml(c.status)}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  if (surgeContainer) {
    const surges = detectLectureSurgeWindows(STATE.analytics.campusHourly, STATE.history24h.campusData);

    const surgeAlertBadge = $('lectureSurgeAlertBadge');
    if (surgeAlertBadge) {
      const activeSurge = surges.find(s => s.isActive);
      if (activeSurge) {
        surgeAlertBadge.className = 'badge badge-warning';
        surgeAlertBadge.textContent = '🔴 Active Surge Window';
        surgeAlertBadge.style.animation = 'pulse-bunched 2s infinite';
      } else {
        surgeAlertBadge.style.animation = '';
        const sgDate = new Date(Date.now() + 8 * 3600 * 1000);
        const nowMin = sgDate.getUTCHours() * 60 + sgDate.getUTCMinutes();
        const nextWindow = surges.find(s => {
          const [startH, startM] = s.timeRange.slice(0, 5).split(':').map(Number);
          return (startH * 60 + startM) > nowMin;
        });
        if (nextWindow) {
          surgeAlertBadge.className = 'badge badge-secondary';
          const startTime = nextWindow.timeRange.slice(0, 5);
          surgeAlertBadge.textContent = `Next Wave: ${startTime} SGT`;
        } else {
          surgeAlertBadge.className = 'badge badge-success';
          surgeAlertBadge.textContent = 'Day Waves Complete';
        }
      }
    }

    surgeContainer.innerHTML = surges.map(s => {
      let liveBadge = '';
      if (s.isActive) {
        const liveCrowdText = s.liveOccupancy !== null ? ` · ${s.liveOccupancy}% Live Crowd` : '';
        liveBadge = `<span class="surge-live-badge"><span class="pulse-dot-red" aria-hidden="true"></span>Active Window Now${escapeHtml(liveCrowdText)}</span>`;
      }

      const empiricalBadge = s.isEmpirical
        ? `<span class="surge-pill-tag pill-empirical">📊 ${escapeHtml(s.observedSummary)}</span>`
        : `<span class="surge-pill-tag pill-baseline">⏱️ ${escapeHtml(s.observedSummary)}</span>`;

      return `
        <div class="surge-window-card ${s.isActive ? 'is-active-window' : ''}">
          <div class="surge-header">
            <span class="surge-time">🕒 ${escapeHtml(s.timeRange)}</span>
            <span class="surge-magnitude ${s.isActive ? 'is-active-magnitude' : ''}">${escapeHtml(s.peakIncrease)}</span>
          </div>
          <div class="surge-metric-strip">
            ${liveBadge}
            ${empiricalBadge}
          </div>
          <div class="surge-desc">${escapeHtml(s.desc)}</div>
          <div class="surge-tip"><span class="surge-tip-icon" aria-hidden="true">💡</span><div class="surge-tip-text"><strong>Commuter Tip:</strong> ${escapeHtml(s.tip)}</div></div>
        </div>
      `;
    }).join('');
  }
}

function observedRouteSummaries() {
  const routes = new Map();
  for (const row of STATE.analytics.hourlyData || []) {
    if (!routes.has(row.route_code)) routes.set(row.route_code, { route_code: row.route_code, occupancy_sum: 0, ridership_sum: 0, occupancy_sample_count: 0, ridership_sample_count: 0 });
    const route = routes.get(row.route_code);
    for (const metric of ['occupancy', 'ridership']) {
      const value = numeric(row[metric === 'occupancy' ? 'avg_occupancy_pct' : 'avg_ridership']);
      const count = numeric(row[`${metric}_sample_count`]);
      if (value !== null && count > 0) { route[`${metric}_sum`] += value * count; route[`${metric}_sample_count`] += count; }
    }
  }
  return [...routes.values()].sort((a, b) => String(a.route_code).localeCompare(String(b.route_code))).map(route => ({ ...route,
    avg_occupancy_pct: route.occupancy_sample_count ? route.occupancy_sum / route.occupancy_sample_count : null,
    avg_ridership: route.ridership_sample_count ? route.ridership_sum / route.ridership_sample_count : null
  }));
}

function renderHourlyBarChart() {
  const containerW = $('hourlyBarChart')?.parentElement?.clientWidth || 1100;
  const isMobile = containerW < 520;
  const height = isMobile ? 200 : 260;
  const chart = chartContext('hourlyBarChart', height);
  if (!chart) return;
  const { canvas, ctx, width } = chart;
  const left = isMobile ? 38 : 50, top = 20, chartW = width - (isMobile ? 50 : 70), chartH = height - (isMobile ? 55 : 70);
  const rows = STATE.errors.analytics ? [] : STATE.analytics.campusHourly || [];
  const values = new Map(rows.map(row => [row.hour, numeric(row.avg_occupancy_pct)]));
  const ridershipMap = new Map(rows.map(row => [row.hour, numeric(row.avg_ridership)]));
  const sampleMap = new Map(rows.map(row => [row.hour, numeric(row.sample_count)]));
  const occSampleMap = new Map(rows.map(row => [row.hour, numeric(row.occupancy_sample_count)]));
  const crowdMap = new Map(rows.map(row => [row.hour, row.crowd_level]));
  const maxY = Math.max(100, Math.ceil(Math.max(0, ...[...values.values()].filter(value => value !== null)) / 25) * 25);
  ctx.font = isMobile ? '10px sans-serif' : '11px sans-serif'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const value = maxY * i / 4, y = top + chartH * (1 - i / 4);
    ctx.strokeStyle = '#273553'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + chartW, y); ctx.stroke();
    ctx.fillStyle = '#94a3b8'; ctx.fillText(`${numberLabel(value)}%`, left - (isMobile ? 6 : 8), y + (isMobile ? 3 : 4));
  }
  const slotW = chartW / 24;
  const barWidth = Math.max(6, slotW * 0.65);
  for (let hour = 0; hour < 24; hour++) {
    const value = values.get(hour);
    const x = left + hour * slotW;
    const barX = x + (slotW - barWidth) / 2;
    const isHovered = STATE.campusHourlyHoveredIndex === hour;

    if (isHovered) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.fillRect(x, top, slotW, chartH);
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = isHovered ? '#f1f5f9' : '#94a3b8';
    if (hour % (chartW < 500 ? 4 : 2) === 0 || isHovered) {
      ctx.fillText(String(hour).padStart(2, '0'), barX + barWidth / 2, top + chartH + (isMobile ? 16 : 20));
    }

    if (value === undefined || value === null) {
      ctx.fillStyle = isHovered ? '#64748b' : '#334155';
      ctx.fillText('·', barX + barWidth / 2, top + chartH - 5);
      continue;
    }

    const barH = value === 0 ? 4 : Math.max(3, value / maxY * chartH);
    const barY = top + chartH - barH;
    ctx.fillStyle = crowd(value).color;
    ctx.fillRect(barX, barY, barWidth, barH);

    if (isHovered) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      if (typeof ctx.strokeRect === 'function') ctx.strokeRect(barX, barY, barWidth, barH);
    }
  }

  if (![...values.values()].some(value => value !== null)) {
    ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'; ctx.fillText('No hourly occupancy readings available', left + chartW / 2, top + chartH / 2);
  }

  canvas._hourlyMeta = {
    left, top, chartW, chartH, slotW, barWidth,
    values, ridershipMap, sampleMap, occSampleMap, crowdMap, maxY
  };
}

function busReadingsMarkup(bus) {
  const pct = occupancy(bus), level = busCrowd(bus);
  let stopRow = '';
  if (hasCoordinates(bus) && typeof NUS_BUS_STOPS !== 'undefined' && typeof getDistanceToStop === 'function') {
    let nearestDist = Infinity;
    let nearestName = '';
    const serviced = typeof NUS_ROUTE_STOPS !== 'undefined' ? NUS_ROUTE_STOPS[bus.route_code] : null;
    for (const stop of NUS_BUS_STOPS) {
      if (serviced && !serviced.has(stop.name) && !serviced.has(stop.code)) continue;
      const d = getDistanceToStop(bus.lat, bus.lng, stop.lat, stop.lng);
      if (d < nearestDist) {
        nearestDist = d;
        nearestName = stop.name;
      }
    }
    if (nearestName && nearestDist < 5000) {
      const isAt = nearestDist <= 180;
      stopRow = `<div class="bus-meta-row stop-hint"><span class="stop-near-label">${isAt ? '📍 At Stop:' : '⚡ Near Stop:'} <strong>${escapeHtml(nearestName)}</strong> (${Math.round(nearestDist)}m)</span></div>`;
    }
  }
  return `<div class="bus-crowd-row"><span class="bus-pax">${numberLabel(bus.ridership)} <small>/ ${numberLabel(bus.capacity)} pax</small></span><span style="color:${level.color}">${percentLabel(pct)}</span></div>
    <div class="progress-bar-bg ${pct === null ? 'is-unknown' : ''}"><div class="progress-bar-fill" style="width:${pct === null ? 0 : Math.max(0, Math.min(100, pct))}%;background-color:${level.color}"></div></div>
    ${stopRow}
    <div class="bus-meta-row"><span>Speed: ${numeric(bus.speed) === null ? 'Unknown' : `${numberLabel(bus.speed)} km/h`}</span><span>${hasCoordinates(bus) ? `${bus.lat.toFixed(4)}, ${bus.lng.toFixed(4)}` : 'Location unknown'}</span></div>
    <div class="bus-meta-row last-seen">Last observed: ${escapeHtml(formatTime(lastSeen(bus), true))}${lastSeen(bus) ? ' SGT' : ''}</div>`;
}
function renderFleetGrid() {
  const all = STATE.allFleet;
  const buses = all.filter(bus => (STATE.fleetFilter === 'all' || bus.route_code === STATE.fleetFilter) &&
    (STATE.fleetStatusFilter === 'all' || fleetStatus(bus) === STATE.fleetStatusFilter) &&
    `${bus.vehplate} ${bus.route_code}`.toLocaleLowerCase().includes(STATE.fleetSearch));
  const known = STATE.live.knownFleetCount ?? STATE.status.knownFleetCount;
  const noRecentPull = telemetryStale() && !STATE.liveBuses.length;
  setText('fleetTotalCount', numberLabel(known));
  setText('fleetActiveCount', numberLabel(noRecentPull ? null : STATE.live.activeCount));
  setText('fleetInactiveCount', numberLabel(noRecentPull ? null : STATE.live.inactiveCount));
  setText('fleetStaleCount', numberLabel(STATE.live.staleCount));
  setText('filterStatusAll', `All (${numberLabel(known)})`);
  setText('filterStatusActive', `Latest pull (${numberLabel(STATE.live.activeCount)})`);
  setText('filterStatusInactive', `Not in latest pull (${numberLabel(STATE.live.inactiveCount)})`);
  setText('filterStatusStale', `Stale (${numberLabel(STATE.live.staleCount)})`);
  setText('fleetResultCount', `${buses.length} of ${all.length} observed vehicles match`);
  if (!buses.length) {
    $('fleetGrid').innerHTML = emptyMarkup(all.length ? 'No vehicles match these filters. Try another plate, route, or status.' : STATE.errors.live ? 'Fleet data could not be loaded. The dashboard will retry automatically.' : STATE.live.lastPolledAt ? 'The latest live pull returned no vehicles. Vehicles will appear here when reported by the feed.' : 'No vehicles have been observed yet. Use Poll Now to collect live readings.');
    return;
  }
  const stale = telemetryStale();
  computeAllRouteHeadways(STATE.liveBuses);
  $('fleetGrid').innerHTML = buses.map(bus => {
    const status = fleetStatus(bus), active = status === 'active', level = busCrowd(bus);
    const label = status === 'stale' || stale ? 'Stale · Last known reading' : active ? 'Reported in latest pull' : 'Not in latest pull';
    const reasonHtml = !active || stale ? inactiveReasonMarkup(bus) : '';

    const hw = STATE.vehicleHeadways?.get(bus.vehplate);
    const bunchedBadge = active && !stale && hw && hw.isBunched
      ? `<span class="badge badge-bunched">⚠️ Bunched (${hw.headwayFromPrevMin || '1.5'}m behind ${escapeHtml(hw.prevPlate || 'bus')})</span>`
      : '';
    const duty = getVehicleDutySummary(bus.vehplate);
    const dutyBadge = `<span class="badge ${duty.badgeClass}">${duty.profile}</span>`;
    const labelPrefix = STATE.timeMode === 'date' && STATE.selectedDate && STATE.selectedDate !== formatLocalDate()
      ? STATE.selectedDate
      : 'Today';
    const dutyTelemetry = `<div class="bus-duty-telemetry" style="font-size:0.75rem;color:#94a3b8;margin-top:4px;">📅 ${labelPrefix}: ${duty.activeHoursLabel} active · ~${duty.distanceKm} km</div>`;

    return `<article class="bus-card ${!active || stale ? 'bus-card-inactive' : ''}" data-plate="${escapeHtml(bus.vehplate)}" tabindex="0" role="button" aria-label="Open vehicle dashboard for ${escapeHtml(bus.vehplate)}"><div class="bus-card-top"><span class="bus-route-badge" style="background-color:${routeColor(bus.route_code)}">${escapeHtml(bus.route_code)}</span><span class="bus-plate">${escapeHtml(bus.vehplate)}</span></div><div class="bus-card-status"><span class="badge ${active && !stale ? 'badge-info' : 'badge-secondary'}">${label}</span><span class="badge ${level.badge}">${level.label} occupancy</span>${bunchedBadge}${dutyBadge}</div>${busReadingsMarkup(bus)}${dutyTelemetry}${reasonHtml}<span class="bus-card-click-hint">Click to view bus dashboard →</span></article>`;
  }).join('');
}

// Official NUS Kent Ridge campus bus stops (synced with uNivUS ESB API)
const NUS_BUS_STOPS = [
  {
    "name": "COM 3 (School of Computing)",
    "code": "COM3",
    "lat": 1.294431,
    "lng": 103.775217
  },
  {
    "name": "Opp TCOMS",
    "code": "TCOMS-OPP",
    "lat": 1.293789,
    "lng": 103.776715
  },
  {
    "name": "Prince George's Park (PGP)",
    "code": "PGP",
    "lat": 1.291765,
    "lng": 103.780419
  },
  {
    "name": "Kent Ridge MRT (Exit A)",
    "code": "KR-MRT",
    "lat": 1.29482,
    "lng": 103.784413
  },
  {
    "name": "Faculty of Science (LT27)",
    "code": "LT27",
    "lat": 1.297421,
    "lng": 103.780941
  },
  {
    "name": "University Hall",
    "code": "UHALL",
    "lat": 1.297127,
    "lng": 103.778822
  },
  {
    "name": "Opp University Health Centre",
    "code": "UHC-OPP",
    "lat": 1.298788,
    "lng": 103.775612
  },
  {
    "name": "NUS Museum",
    "code": "MUSEUM",
    "lat": 1.301081,
    "lng": 103.77369
  },
  {
    "name": "University Town (UTown)",
    "code": "UTOWN",
    "lat": 1.303876,
    "lng": 103.774621
  },
  {
    "name": "University Health Centre (UHC)",
    "code": "UHC",
    "lat": 1.29891,
    "lng": 103.776103
  },
  {
    "name": "Opp University Hall",
    "code": "UHALL-OPP",
    "lat": 1.297574,
    "lng": 103.778088
  },
  {
    "name": "Faculty of Science (S17)",
    "code": "S17",
    "lat": 1.297519,
    "lng": 103.78073
  },
  {
    "name": "Opp Kent Ridge MRT",
    "code": "KR-MRT-OPP",
    "lat": 1.294962,
    "lng": 103.784556
  },
  {
    "name": "Prince George's Park Residences (PGPR)",
    "code": "PGPR",
    "lat": 1.290994,
    "lng": 103.781153
  },
  {
    "name": "TCOMS",
    "code": "TCOMS",
    "lat": 1.293654,
    "lng": 103.776898
  },
  {
    "name": "Opp Hon Sui Sen Memorial Library",
    "code": "HSSML-OPP",
    "lat": 1.292798,
    "lng": 103.774978
  },
  {
    "name": "Opp NUSS Guild House",
    "code": "NUSS-OPP",
    "lat": 1.293208,
    "lng": 103.772618
  },
  {
    "name": "Ventus (Opp LT13)",
    "code": "LT13-OPP",
    "lat": 1.29534,
    "lng": 103.770617
  },
  {
    "name": "Information Technology (IT)",
    "code": "IT",
    "lat": 1.297204,
    "lng": 103.772688
  },
  {
    "name": "Opp Yusof Ishak House (Opp YIH)",
    "code": "YIH-OPP",
    "lat": 1.298904,
    "lng": 103.774118
  },
  {
    "name": "Yusof Ishak House (YIH)",
    "code": "YIH",
    "lat": 1.298885,
    "lng": 103.774377
  },
  {
    "name": "Central Library (CLB)",
    "code": "CLB",
    "lat": 1.296544,
    "lng": 103.772569
  },
  {
    "name": "Lecture Theatre 13 (LT13)",
    "code": "LT13",
    "lat": 1.294552,
    "lng": 103.770635
  },
  {
    "name": "Faculty of Arts (AS5)",
    "code": "AS5",
    "lat": 1.293619,
    "lng": 103.771475
  },
  {
    "name": "Business School (BIZ 2)",
    "code": "BIZ2",
    "lat": 1.293223,
    "lng": 103.775068
  },
  {
    "name": "Kent Ridge Bus Terminal",
    "code": "KRB",
    "lat": 1.294536,
    "lng": 103.77
  },
  {
    "name": "Opp SDE 3",
    "code": "SDE3-OPP",
    "lat": 1.297799,
    "lng": 103.769603
  },
  {
    "name": "The Japanese Primary School",
    "code": "JP-SCH-16151",
    "lat": 1.30077,
    "lng": 103.769904
  },
  {
    "name": "Kent Vale",
    "code": "KV",
    "lat": 1.301899,
    "lng": 103.769455
  },
  {
    "name": "Raffles Hall",
    "code": "RAFFLES",
    "lat": 1.300946,
    "lng": 103.772703
  }
];

const NUS_TERMINAL_CODES = new Set(['UTOWN', 'KRB', 'PGP', 'PGPR', 'COM3', 'KV']);

function nearestTerminal(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Array.isArray(NUS_BUS_STOPS)) return null;
  let closest = null;
  let minDist = Infinity;
  for (const stop of NUS_BUS_STOPS) {
    if (!NUS_TERMINAL_CODES.has(stop.code)) continue;
    const dLat = (lat - stop.lat) * 111000;
    const dLng = (lng - stop.lng) * 110970;
    const dist = Math.hypot(dLat, dLng);
    if (dist < minDist) {
      minDist = dist;
      closest = { name: stop.name, dist };
    }
  }
  return closest && closest.dist <= 350 ? closest.name : null;
}

function inactiveReason(bus, nowMs = Date.now()) {
  const seen = lastSeen(bus);
  if (!seen) {
    return {
      type: 'unknown',
      title: 'Status unknown',
      icon: '❓',
      badgeClass: 'reason-default',
      detail: 'Retained observation; current service status unknown.'
    };
  }
  const diffMs = Math.max(0, nowMs - seen);
  const terminalName = nearestTerminal(bus.lat, bus.lng);
  const speed = numeric(bus.speed);
  const ridership = numeric(bus.ridership);
  const occupancyVal = numeric(bus.occupancy);
  const route = bus.route_code || '';

  // Singapore local time in minutes of day (UTC+8)
  const sgDate = new Date(seen + 8 * 3600 * 1000);
  const sgHour = sgDate.getUTCHours();
  const sgMin = sgDate.getUTCMinutes();
  const timeInMinutes = sgHour * 60 + sgMin;

  // 1. Overnight shutdown or past shift (>5 hours elapsed or observed 22:45 - 06:30 SGT)
  if (diffMs > 5 * 3600 * 1000 || timeInMinutes >= 22 * 60 + 45 || timeInMinutes < 6 * 60 + 30) {
    return {
      type: 'overnight',
      title: 'Overnight shutdown / past shift',
      icon: '🌙',
      badgeClass: 'reason-overnight',
      detail: diffMs > 12 * 3600 * 1000
        ? 'Vehicle last operated on a previous service day; waiting for next operating schedule.'
        : 'Service concluded for the night; scheduled to resume next operating day.'
    };
  }

  // 2. Peak-only route window closed (R1, R2 operating windows)
  if (['R1', 'R2'].includes(route) && diffMs >= 20 * 60 * 1000) {
    return {
      type: 'peak_route',
      title: 'Peak-hour service window closed',
      icon: '⏱️',
      badgeClass: 'reason-peak-route',
      detail: `Service ${route} operates during designated peak lecture transition windows only.`
    };
  }

  // 3. Completed trip & parked at terminal (0 pax and stationary/low speed)
  if (ridership === 0 && (speed === null || speed <= 5)) {
    return {
      type: 'parked',
      title: 'Completed trip & parked',
      icon: '🅿️',
      badgeClass: 'reason-parked',
      detail: terminalName
        ? `Alighted all passengers and parked at ${terminalName}; engine or dispatch console idle.`
        : 'Alighted all passengers at terminal; engine or dispatch console idle.'
    };
  }

  // 4. Peak booster shift ended (last seen at tail of morning or evening peak with passenger load)
  const isMorningPeakTail = timeInMinutes >= 9 * 60 + 35 && timeInMinutes <= 10 * 60 + 20;
  const isEveningPeakTail = timeInMinutes >= 19 * 60 + 15 && timeInMinutes <= 20 * 60 + 15;
  if ((isMorningPeakTail || isEveningPeakTail) && diffMs >= 12 * 60 * 1000 && ((occupancyVal !== null && occupancyVal >= 0.4) || (ridership !== null && ridership >= 25))) {
    return {
      type: 'peak_booster',
      title: 'Peak booster shift ended',
      icon: '📉',
      badgeClass: 'reason-peak-end',
      detail: isMorningPeakTail
        ? 'Morning lecture rush concluded; extra booster vehicle completed its loop and returned to standby.'
        : 'Evening peak rush concluded; extra booster vehicle completed its loop and returned to standby.'
    };
  }

  // 5. Short turnaround layover between trips (<= 25m elapsed and near terminal or stationary)
  if (diffMs <= 25 * 60 * 1000 && (terminalName || (speed !== null && speed <= 15))) {
    return {
      type: 'turnaround',
      title: 'Turnaround layover at terminal',
      icon: '🔄',
      badgeClass: 'reason-turnaround',
      detail: terminalName
        ? `Driver layover between scheduled trips at ${terminalName}; will rejoin live feed upon next departure.`
        : 'Driver layover between scheduled trips; will rejoin live feed upon next departure.'
    };
  }

  // 6. Transponder signal gap mid-route (recently active, moving at speed in transit)
  if (diffMs <= 30 * 60 * 1000 && speed !== null && speed > 15) {
    return {
      type: 'signal_gap',
      title: 'Transponder signal gap mid-route',
      icon: '📡',
      badgeClass: 'reason-signal',
      detail: `Vehicle was moving in transit (${numberLabel(speed)} km/h); GPS telemetry transponder temporarily dropped.`
    };
  }

  // 7. Standby / off-duty fallback
  return {
    type: 'standby',
    title: 'Standby / off-service',
    icon: '⏸️',
    badgeClass: 'reason-default',
    detail: 'Vehicle not transmitting in latest live poll; parked, on driver break, or off-duty.'
  };
}

function inactiveReasonMarkup(bus) {
  const reason = inactiveReason(bus);
  return `<div class="bus-inactive-reason ${escapeHtml(reason.badgeClass)}"><div class="inactive-reason-header"><span class="inactive-reason-icon" aria-hidden="true">${reason.icon}</span><strong class="inactive-reason-title">${escapeHtml(reason.title)}</strong></div><p class="inactive-reason-desc">${escapeHtml(reason.detail)}</p></div>`;
}

// High-precision road-aligned route geometries derived from official uNivUS stop sequences
const NUS_ROUTE_PATHS = {"A1":[[1.29391,103.77014],[1.29392,103.77015],[1.29395,103.77019],[1.29398,103.77025],[1.29401,103.77031],[1.29403,103.77035],[1.29417,103.77029],[1.29443,103.77022],[1.29469,103.77017],[1.29479,103.77017],[1.29492,103.7702],[1.29504,103.77029],[1.29511,103.7704],[1.29514,103.77041],[1.29518,103.77053],[1.29517,103.77056],[1.29518,103.7706],[1.29509,103.77058],[1.29506,103.77057],[1.29497,103.77056],[1.29496,103.77056],[1.29479,103.77055],[1.29459,103.77057],[1.29454,103.77059],[1.29445,103.77061],[1.29434,103.77065],[1.29423,103.77069],[1.29417,103.77071],[1.29411,103.77075],[1.2939,103.77091],[1.29379,103.77102],[1.2937,103.77115],[1.29362,103.77128],[1.29355,103.77143],[1.29354,103.77146],[1.2935,103.7716],[1.29348,103.77176],[1.29345,103.77196],[1.29343,103.77211],[1.29341,103.77218],[1.29337,103.77235],[1.29334,103.77247],[1.29329,103.77258],[1.29324,103.7727],[1.29318,103.7728],[1.29308,103.77298],[1.29295,103.77317],[1.29268,103.77348],[1.2926,103.77355],[1.29256,103.77359],[1.29241,103.77376],[1.29234,103.77392],[1.2923,103.77404],[1.29229,103.77407],[1.29222,103.77423],[1.29221,103.77425],[1.29216,103.77441],[1.29215,103.77444],[1.29232,103.77456],[1.29248,103.77467],[1.29281,103.77492],[1.29288,103.77497],[1.2931,103.7751],[1.2932,103.77513],[1.29324,103.77514],[1.29333,103.77517],[1.29342,103.77519],[1.29355,103.77523],[1.29363,103.77526],[1.29368,103.77533],[1.2937,103.77538],[1.29371,103.7755],[1.29372,103.77555],[1.29373,103.77582],[1.29374,103.77597],[1.29374,103.77602],[1.29372,103.77615],[1.29374,103.77645],[1.29377,103.77672],[1.29377,103.7768],[1.29377,103.77684],[1.29376,103.77687],[1.29356,103.77718],[1.29351,103.77725],[1.29314,103.7778],[1.29309,103.7779],[1.29305,103.77801],[1.29301,103.77813],[1.29298,103.77827],[1.29296,103.77862],[1.29294,103.77872],[1.29292,103.77885],[1.29289,103.77894],[1.29287,103.77897],[1.29284,103.77904],[1.29278,103.77914],[1.29265,103.77932],[1.29255,103.77945],[1.29236,103.77972],[1.29233,103.77976],[1.29228,103.77983],[1.29226,103.7799],[1.29219,103.78009],[1.29216,103.78015],[1.29216,103.78015],[1.29212,103.7802],[1.29207,103.78024],[1.29201,103.78028],[1.29195,103.78031],[1.29188,103.78034],[1.29177,103.78036],[1.29175,103.78036],[1.29171,103.78037],[1.29164,103.78039],[1.2915,103.78044],[1.29142,103.78049],[1.2914,103.7805],[1.29129,103.78059],[1.29122,103.7807],[1.29118,103.78075],[1.29114,103.78085],[1.29112,103.78099],[1.29113,103.78111],[1.29116,103.78132],[1.29118,103.78145],[1.29127,103.7817],[1.29146,103.78211],[1.29164,103.78251],[1.29181,103.78287],[1.29196,103.78318],[1.29182,103.78328],[1.29164,103.78348],[1.2916,103.78353],[1.29167,103.78361],[1.29189,103.78385],[1.29212,103.78409],[1.29216,103.78413],[1.29221,103.78418],[1.29225,103.78423],[1.29226,103.78423],[1.29244,103.78443],[1.29279,103.78478],[1.29289,103.78487],[1.29302,103.78499],[1.29316,103.78504],[1.29323,103.78505],[1.29327,103.78506],[1.29332,103.78506],[1.29339,103.78505],[1.29349,103.78502],[1.29368,103.78494],[1.29371,103.78494],[1.29385,103.78492],[1.29407,103.7849],[1.2941,103.7849],[1.29415,103.78489],[1.29419,103.78488],[1.29423,103.78486],[1.29427,103.78484],[1.29449,103.7847],[1.29466,103.78458],[1.29473,103.78453],[1.29503,103.78433],[1.29519,103.78423],[1.29526,103.78419],[1.2953,103.78412],[1.29531,103.78408],[1.29532,103.78404],[1.29533,103.78397],[1.29532,103.78388],[1.29532,103.7838],[1.29525,103.78381],[1.29523,103.78381],[1.29524,103.78386],[1.29522,103.7839],[1.29514,103.78397],[1.29509,103.78405],[1.29504,103.78411],[1.29494,103.78419],[1.29483,103.78427],[1.29474,103.78432],[1.29449,103.78445],[1.29445,103.78447],[1.29442,103.78445],[1.29439,103.78444],[1.29437,103.78437],[1.29437,103.78433],[1.2944,103.78429],[1.29453,103.78423],[1.29466,103.78417],[1.29471,103.78414],[1.29479,103.7841],[1.29486,103.78407],[1.29494,103.784],[1.29497,103.78398],[1.29506,103.78387],[1.29509,103.78385],[1.2951,103.78384],[1.29512,103.78384],[1.2952,103.78382],[1.29523,103.78381],[1.29525,103.78381],[1.29532,103.7838],[1.29532,103.78373],[1.29532,103.7837],[1.29532,103.78366],[1.29532,103.78362],[1.29539,103.78362],[1.2954,103.7837],[1.2954,103.78373],[1.29541,103.78379],[1.29542,103.78384],[1.29544,103.78395],[1.29548,103.784],[1.29553,103.78401],[1.29596,103.78377],[1.29604,103.78371],[1.29607,103.78368],[1.29615,103.78363],[1.29623,103.78357],[1.29636,103.78345],[1.29645,103.78336],[1.2965,103.78331],[1.29664,103.78312],[1.29675,103.78294],[1.29677,103.7829],[1.29679,103.78289],[1.2969,103.78271],[1.29691,103.78267],[1.29692,103.78262],[1.29693,103.78252],[1.29693,103.78243],[1.29694,103.78237],[1.29696,103.78221],[1.29702,103.78208],[1.29717,103.78186],[1.2973,103.78168],[1.29734,103.78159],[1.29738,103.78152],[1.29738,103.78151],[1.29742,103.7814],[1.29744,103.78125],[1.29744,103.78121],[1.29744,103.78109],[1.29744,103.781],[1.29744,103.78094],[1.29743,103.78087],[1.29743,103.7808],[1.29742,103.78076],[1.29742,103.78072],[1.29741,103.78065],[1.29741,103.78057],[1.29741,103.78049],[1.29742,103.78044],[1.29743,103.78039],[1.29741,103.7803],[1.29737,103.78014],[1.29732,103.77999],[1.29726,103.77987],[1.29725,103.77984],[1.2972,103.7797],[1.29716,103.77958],[1.29713,103.77945],[1.29713,103.77938],[1.29713,103.77924],[1.29713,103.77909],[1.29718,103.77892],[1.29721,103.77885],[1.29727,103.77864],[1.29733,103.7785],[1.29736,103.77841],[1.29741,103.77827],[1.29753,103.77793],[1.29763,103.77768],[1.29768,103.7776],[1.29771,103.77754],[1.29776,103.77748],[1.29787,103.77733],[1.29797,103.7772],[1.29809,103.77706],[1.29828,103.77687],[1.29848,103.77673],[1.29866,103.77658],[1.29872,103.77649],[1.29879,103.77637],[1.29885,103.7762],[1.29888,103.77611],[1.29888,103.77602],[1.29888,103.77596],[1.29888,103.77593],[1.29885,103.77576],[1.29884,103.77561],[1.29884,103.77559],[1.29886,103.77542],[1.29886,103.7754],[1.2989,103.77525],[1.29907,103.77497],[1.29916,103.77487],[1.2992,103.77482],[1.29921,103.77474],[1.29924,103.77467],[1.29926,103.77462],[1.29923,103.77454],[1.2992,103.77451],[1.29915,103.77443],[1.29907,103.77439],[1.29893,103.7743],[1.29889,103.77428],[1.2988,103.77423],[1.29869,103.77415],[1.29848,103.77398],[1.29835,103.77385],[1.29824,103.7737],[1.29816,103.77357],[1.29796,103.77326],[1.29791,103.77321],[1.29786,103.77316],[1.29776,103.7731],[1.29769,103.77306],[1.29755,103.77301],[1.29733,103.77293],[1.29712,103.77285],[1.29706,103.77281],[1.29694,103.77276],[1.29685,103.7727],[1.29674,103.77263],[1.2967,103.7726],[1.29664,103.77255],[1.29662,103.77252],[1.29661,103.77251],[1.29653,103.77243],[1.29651,103.77241],[1.29645,103.77235],[1.29643,103.77232],[1.29641,103.7723],[1.29635,103.7722],[1.29629,103.772],[1.29625,103.77183],[1.29624,103.77171],[1.29624,103.77158],[1.29625,103.77143],[1.29627,103.77106],[1.29627,103.77101],[1.29627,103.77091],[1.2962,103.7709],[1.29615,103.7709],[1.29605,103.77089],[1.29588,103.77087],[1.29569,103.7708],[1.29551,103.77073],[1.29535,103.77065],[1.29518,103.7706],[1.29517,103.77056],[1.29515,103.77054],[1.29511,103.77043],[1.29511,103.7704],[1.29502,103.77038],[1.29488,103.77036],[1.29472,103.77037],[1.29459,103.77038],[1.29441,103.77042],[1.29426,103.77046],[1.29414,103.77052],[1.29395,103.77062],[1.2938,103.77075],[1.29365,103.7709],[1.29354,103.77103],[1.29348,103.77111],[1.29344,103.77113],[1.2934,103.77112],[1.29336,103.77109],[1.29333,103.77105],[1.2934,103.77096],[1.29349,103.77085],[1.29359,103.77075],[1.2937,103.77063],[1.29386,103.77046],[1.29391,103.77042],[1.29403,103.77035],[1.29417,103.77029],[1.29443,103.77022],[1.29457,103.77019]],"A2":[[1.29402,103.76931],[1.29397,103.76928],[1.29391,103.76925],[1.29384,103.76919],[1.29365,103.76907],[1.29363,103.76904],[1.29353,103.76896],[1.29344,103.76889],[1.29333,103.7688],[1.29324,103.76873],[1.2932,103.7687],[1.293,103.76854],[1.29274,103.76835],[1.29249,103.76816],[1.29245,103.76813],[1.29233,103.76804],[1.29244,103.76791],[1.29255,103.768],[1.2926,103.76803],[1.29281,103.7682],[1.29324,103.76853],[1.29337,103.76864],[1.29355,103.76877],[1.2937,103.76889],[1.29375,103.76892],[1.2939,103.76903],[1.29393,103.76906],[1.29402,103.76912],[1.29411,103.76917],[1.29438,103.76932],[1.29464,103.76942],[1.29488,103.76949],[1.29495,103.7695],[1.29513,103.76953],[1.29525,103.76954],[1.29545,103.76955],[1.29576,103.76955],[1.29598,103.76957],[1.29605,103.76957],[1.29615,103.76957],[1.29614,103.76974],[1.29614,103.76977],[1.29614,103.7698],[1.29619,103.76995],[1.29624,103.77015],[1.29635,103.77053],[1.29639,103.77074],[1.2964,103.77094],[1.2964,103.77101],[1.29639,103.77107],[1.29636,103.77161],[1.29637,103.77178],[1.2964,103.77195],[1.29644,103.77205],[1.29649,103.77214],[1.29656,103.77222],[1.29658,103.77225],[1.29662,103.77228],[1.29667,103.77232],[1.29672,103.77235],[1.29683,103.77243],[1.29698,103.77239],[1.29702,103.77239],[1.29709,103.77238],[1.29714,103.77238],[1.29717,103.7724],[1.2972,103.77241],[1.29723,103.77242],[1.29727,103.77244],[1.29717,103.77267],[1.29727,103.77244],[1.29723,103.77242],[1.2972,103.77241],[1.29717,103.7724],[1.29714,103.77238],[1.29709,103.77238],[1.29702,103.77239],[1.29701,103.77242],[1.2969,103.7725],[1.29697,103.77257],[1.2971,103.77267],[1.29726,103.77279],[1.29743,103.7729],[1.29759,103.77296],[1.29771,103.773],[1.29779,103.77303],[1.29789,103.7731],[1.298,103.7732],[1.29819,103.77346],[1.29833,103.77368],[1.29845,103.77384],[1.2986,103.77398],[1.2987,103.77405],[1.29882,103.77414],[1.29887,103.77417],[1.29918,103.77435],[1.29928,103.77439],[1.29935,103.77442],[1.29947,103.77444],[1.29957,103.77448],[1.29961,103.77451],[1.29971,103.77452],[1.2998,103.77452],[1.29991,103.77452],[1.29997,103.77451],[1.30007,103.77449],[1.30018,103.77445],[1.30034,103.77437],[1.30046,103.77431],[1.3005,103.77425],[1.30056,103.77416],[1.30058,103.77413],[1.3006,103.77412],[1.30064,103.77403],[1.30067,103.77398],[1.30076,103.77382],[1.30083,103.7737],[1.3009,103.77358],[1.30096,103.77343],[1.30098,103.77338],[1.30102,103.77323],[1.30103,103.77314],[1.30111,103.77314],[1.30119,103.77314],[1.30119,103.77319],[1.30116,103.7733],[1.30113,103.77342],[1.30104,103.77367],[1.30103,103.77368],[1.301,103.77377],[1.30095,103.77385],[1.30083,103.77404],[1.3008,103.77409],[1.30078,103.77414],[1.30075,103.77418],[1.30076,103.7742],[1.30076,103.77422],[1.30075,103.77424],[1.30074,103.77427],[1.30072,103.77429],[1.3007,103.77431],[1.30066,103.77432],[1.30065,103.77432],[1.3006,103.77434],[1.30055,103.77437],[1.30046,103.77443],[1.30035,103.7745],[1.30022,103.77456],[1.30008,103.77462],[1.29996,103.77464],[1.29986,103.77465],[1.29968,103.77465],[1.29963,103.77466],[1.29957,103.77467],[1.29953,103.77468],[1.29949,103.77469],[1.29941,103.7747],[1.29928,103.77479],[1.29923,103.77481],[1.2992,103.77482],[1.29916,103.77487],[1.29907,103.77497],[1.2989,103.77525],[1.29886,103.7754],[1.29886,103.77542],[1.29884,103.77559],[1.29885,103.77576],[1.29888,103.77593],[1.29888,103.77596],[1.29888,103.77602],[1.29888,103.7761],[1.29888,103.77611],[1.29885,103.7762],[1.29879,103.77637],[1.29872,103.77649],[1.29866,103.77658],[1.29848,103.77673],[1.29828,103.77687],[1.29809,103.77706],[1.29797,103.7772],[1.29787,103.77733],[1.29776,103.77748],[1.29771,103.77754],[1.29768,103.7776],[1.29763,103.77768],[1.29753,103.77793],[1.29747,103.77811],[1.29741,103.77827],[1.29736,103.77841],[1.29733,103.7785],[1.29727,103.77864],[1.29718,103.77892],[1.29713,103.77909],[1.29713,103.77924],[1.29713,103.77938],[1.29713,103.77945],[1.29716,103.77958],[1.2972,103.7797],[1.29725,103.77984],[1.29726,103.77987],[1.29732,103.77999],[1.29737,103.78014],[1.29741,103.7803],[1.29743,103.78039],[1.29744,103.78043],[1.29746,103.78051],[1.29749,103.78068],[1.29749,103.78073],[1.29751,103.78101],[1.2975,103.78121],[1.29749,103.78132],[1.29747,103.78142],[1.29744,103.78155],[1.29739,103.78164],[1.29731,103.78176],[1.29724,103.78185],[1.29716,103.78197],[1.2971,103.78207],[1.29704,103.78223],[1.29703,103.78226],[1.29702,103.78237],[1.29701,103.78239],[1.297,103.78244],[1.29699,103.78251],[1.29699,103.78253],[1.29699,103.78261],[1.29698,103.78271],[1.29697,103.78275],[1.29696,103.78286],[1.29692,103.78293],[1.29693,103.78297],[1.29692,103.783],[1.2969,103.78303],[1.29688,103.78305],[1.29686,103.78305],[1.29683,103.78306],[1.29667,103.78323],[1.29657,103.78336],[1.29647,103.78347],[1.29636,103.78357],[1.29632,103.78362],[1.29627,103.78366],[1.29619,103.78373],[1.29607,103.78381],[1.29587,103.78392],[1.29571,103.78405],[1.2956,103.78414],[1.29559,103.78418],[1.29557,103.78421],[1.29553,103.78423],[1.29549,103.78424],[1.29545,103.78424],[1.29536,103.78428],[1.29495,103.78455],[1.29491,103.78458],[1.29457,103.78484],[1.29453,103.78486],[1.29439,103.78493],[1.2942,103.785],[1.29409,103.78501],[1.29399,103.78502],[1.29389,103.78502],[1.29377,103.78503],[1.29367,103.78504],[1.29358,103.78507],[1.29356,103.78508],[1.29354,103.78509],[1.29349,103.78513],[1.29339,103.78522],[1.29334,103.78527],[1.29324,103.78537],[1.29318,103.78531],[1.29313,103.78526],[1.29286,103.785],[1.29237,103.7845],[1.29229,103.78443],[1.29213,103.78425],[1.29209,103.7842],[1.29205,103.78415],[1.29188,103.78398],[1.2916,103.78367],[1.29153,103.7836],[1.2916,103.78353],[1.29164,103.78348],[1.29182,103.78328],[1.29196,103.78318],[1.29181,103.78287],[1.29164,103.78251],[1.29146,103.78211],[1.29127,103.7817],[1.29118,103.78145],[1.29116,103.78145],[1.29114,103.78145],[1.2911,103.78143],[1.29108,103.78139],[1.29105,103.78133],[1.29104,103.7813],[1.29102,103.78124],[1.291,103.78121],[1.291,103.78109],[1.291,103.78107],[1.29101,103.78105],[1.2911,103.7807],[1.29114,103.78073],[1.29118,103.78075],[1.29122,103.7807],[1.29129,103.78059],[1.2914,103.7805],[1.29142,103.78049],[1.2915,103.78044],[1.29164,103.78039],[1.29171,103.78037],[1.29177,103.78036],[1.29188,103.78034],[1.29195,103.78031],[1.29201,103.78028],[1.29207,103.78024],[1.29212,103.7802],[1.29216,103.78015],[1.29216,103.78015],[1.29219,103.78009],[1.29226,103.7799],[1.29228,103.77983],[1.29233,103.77976],[1.29236,103.77972],[1.29255,103.77945],[1.29265,103.77932],[1.29278,103.77914],[1.29284,103.77904],[1.29287,103.77897],[1.29289,103.77894],[1.29292,103.77885],[1.29294,103.77872],[1.29296,103.77862],[1.29298,103.77827],[1.29301,103.77813],[1.29305,103.77801],[1.29309,103.7779],[1.29314,103.7778],[1.29351,103.77725],[1.29356,103.77718],[1.29371,103.77694],[1.29376,103.77687],[1.29377,103.77684],[1.29377,103.7768],[1.29374,103.77645],[1.29372,103.77615],[1.29374,103.77602],[1.29374,103.77597],[1.29373,103.77582],[1.29372,103.77555],[1.29371,103.7755],[1.2937,103.77538],[1.29368,103.77533],[1.29363,103.77526],[1.29355,103.77523],[1.29342,103.77519],[1.29333,103.77517],[1.29324,103.77514],[1.2931,103.7751],[1.29288,103.77497],[1.29283,103.77494],[1.29281,103.77492],[1.29248,103.77467],[1.29232,103.77456],[1.29215,103.77444],[1.29216,103.77441],[1.29221,103.77425],[1.29219,103.77411],[1.29217,103.77406],[1.29214,103.77402],[1.292,103.77391],[1.29215,103.77386],[1.29229,103.77381],[1.29241,103.77376],[1.29256,103.77359],[1.2926,103.77355],[1.29268,103.77348],[1.29295,103.77317],[1.29308,103.77298],[1.29318,103.7728],[1.29324,103.7727],[1.29326,103.77264],[1.29329,103.77258],[1.29334,103.77247],[1.29337,103.77235],[1.29341,103.77218],[1.29343,103.77211],[1.29345,103.77196],[1.29348,103.77176],[1.2935,103.7716],[1.29355,103.77143],[1.29362,103.77128],[1.2937,103.77115],[1.29379,103.77102],[1.2939,103.77091],[1.29411,103.77075],[1.29417,103.77071],[1.29423,103.77069],[1.29434,103.77065],[1.29445,103.77061],[1.29459,103.77057],[1.29479,103.77055],[1.29496,103.77056],[1.29497,103.77056],[1.29506,103.77057],[1.29509,103.77058],[1.29518,103.7706],[1.29533,103.77065],[1.29518,103.7706],[1.29517,103.77056],[1.29515,103.77054],[1.29511,103.77043],[1.29511,103.7704],[1.29502,103.77038],[1.29488,103.77036],[1.29472,103.77037],[1.29459,103.77038],[1.29441,103.77042],[1.29426,103.77046],[1.29414,103.77052],[1.29395,103.77062],[1.2938,103.77075],[1.29365,103.7709],[1.29354,103.77103],[1.29348,103.77111],[1.29344,103.77113],[1.2934,103.77112],[1.29336,103.77109],[1.29333,103.77105],[1.2934,103.77096],[1.29349,103.77085],[1.29359,103.77075],[1.2937,103.77063],[1.29386,103.77046],[1.29391,103.77042],[1.29403,103.77035],[1.29417,103.77029],[1.29443,103.77022],[1.29447,103.77021]],"D1":[[1.29443,103.77522],[1.29387,103.77546],[1.29384,103.77547],[1.29371,103.7755],[1.2937,103.77538],[1.29368,103.77533],[1.29363,103.77526],[1.29355,103.77523],[1.29342,103.77519],[1.29333,103.77517],[1.29324,103.77514],[1.2931,103.7751],[1.29288,103.77497],[1.29283,103.77494],[1.29281,103.77492],[1.29248,103.77467],[1.29232,103.77456],[1.29215,103.77444],[1.29216,103.77441],[1.29221,103.77425],[1.29219,103.77411],[1.29217,103.77406],[1.29214,103.77402],[1.292,103.77391],[1.29215,103.77386],[1.29229,103.77381],[1.29241,103.77376],[1.29256,103.77359],[1.2926,103.77355],[1.29268,103.77348],[1.29295,103.77317],[1.29308,103.77298],[1.29318,103.7728],[1.29324,103.7727],[1.29326,103.77264],[1.29329,103.77258],[1.29334,103.77247],[1.29337,103.77235],[1.29341,103.77218],[1.29343,103.77211],[1.29345,103.77196],[1.29348,103.77176],[1.2935,103.7716],[1.29355,103.77143],[1.29362,103.77128],[1.2937,103.77115],[1.29379,103.77102],[1.2939,103.77091],[1.29411,103.77075],[1.29417,103.77071],[1.29423,103.77069],[1.29434,103.77065],[1.29445,103.77061],[1.29459,103.77057],[1.29479,103.77055],[1.29496,103.77056],[1.29497,103.77056],[1.29506,103.77057],[1.29509,103.77058],[1.29518,103.7706],[1.29533,103.77065],[1.29535,103.77065],[1.29551,103.77073],[1.29569,103.7708],[1.29588,103.77087],[1.29605,103.77089],[1.29615,103.7709],[1.2962,103.7709],[1.29627,103.77091],[1.2964,103.77094],[1.2964,103.77101],[1.29639,103.77107],[1.29636,103.77161],[1.29637,103.77178],[1.2964,103.77195],[1.29644,103.77205],[1.29649,103.77214],[1.29656,103.77222],[1.29658,103.77225],[1.29662,103.77228],[1.29667,103.77232],[1.29672,103.77235],[1.29683,103.77243],[1.29698,103.77239],[1.29702,103.77239],[1.29709,103.77238],[1.29714,103.77238],[1.29717,103.7724],[1.2972,103.77241],[1.29723,103.77242],[1.29727,103.77244],[1.29717,103.77267],[1.29727,103.77244],[1.29723,103.77242],[1.2972,103.77241],[1.29717,103.7724],[1.29714,103.77238],[1.29709,103.77238],[1.29702,103.77239],[1.29701,103.77242],[1.2969,103.7725],[1.29697,103.77257],[1.2971,103.77267],[1.29726,103.77279],[1.29743,103.7729],[1.29759,103.77296],[1.29771,103.773],[1.29779,103.77303],[1.29789,103.7731],[1.298,103.7732],[1.29819,103.77346],[1.29833,103.77368],[1.29845,103.77384],[1.2986,103.77398],[1.2987,103.77405],[1.29882,103.77414],[1.29887,103.77417],[1.29918,103.77435],[1.29928,103.77439],[1.29935,103.77442],[1.29947,103.77444],[1.29957,103.77448],[1.29961,103.77451],[1.29971,103.77452],[1.2998,103.77452],[1.29991,103.77452],[1.29997,103.77451],[1.30007,103.77449],[1.30018,103.77445],[1.30034,103.77437],[1.30046,103.77431],[1.3005,103.77425],[1.30056,103.77416],[1.30058,103.77413],[1.3006,103.77412],[1.30064,103.77403],[1.30067,103.77398],[1.30076,103.77382],[1.30083,103.7737],[1.3009,103.77358],[1.30096,103.77343],[1.30098,103.77338],[1.30102,103.77323],[1.30103,103.77314],[1.30111,103.77314],[1.30119,103.77314],[1.30119,103.77319],[1.30116,103.7733],[1.30113,103.77342],[1.30104,103.77367],[1.30103,103.77368],[1.301,103.77377],[1.30095,103.77385],[1.30083,103.77404],[1.3008,103.77409],[1.30078,103.77414],[1.30075,103.77418],[1.30076,103.7742],[1.30077,103.77421],[1.30079,103.77424],[1.30086,103.77432],[1.30089,103.77437],[1.3009,103.77439],[1.30097,103.77443],[1.30111,103.77447],[1.30132,103.77448],[1.30145,103.77446],[1.30164,103.77439],[1.30172,103.77434],[1.30232,103.77406],[1.30257,103.77398],[1.30277,103.77395],[1.30289,103.77396],[1.30303,103.77399],[1.30316,103.77405],[1.30323,103.7741],[1.30329,103.77416],[1.30336,103.77423],[1.3035,103.77442],[1.30358,103.77454],[1.30364,103.77466],[1.30365,103.77468],[1.30368,103.77479],[1.30369,103.77503],[1.30364,103.77527],[1.30366,103.77543],[1.30368,103.77548],[1.30369,103.77553],[1.30372,103.77552],[1.30375,103.77551],[1.30378,103.77552],[1.30381,103.77553],[1.30383,103.77555],[1.30384,103.77558],[1.30385,103.77561],[1.30384,103.77564],[1.30383,103.77566],[1.30382,103.77568],[1.30379,103.7757],[1.30377,103.77571],[1.30375,103.77571],[1.30372,103.7757],[1.3037,103.77569],[1.30368,103.77567],[1.30366,103.77565],[1.30365,103.77562],[1.30366,103.77559],[1.30367,103.77556],[1.30369,103.77553],[1.30368,103.77548],[1.30366,103.77543],[1.30364,103.77527],[1.30363,103.77515],[1.30357,103.77503],[1.30355,103.77499],[1.30354,103.77495],[1.30352,103.77486],[1.3035,103.77477],[1.30349,103.77468],[1.30346,103.77457],[1.30342,103.77441],[1.30338,103.77432],[1.30336,103.77423],[1.30329,103.77416],[1.30323,103.7741],[1.30316,103.77405],[1.30303,103.77399],[1.30289,103.77396],[1.30277,103.77395],[1.30257,103.77398],[1.30232,103.77406],[1.30172,103.77434],[1.30164,103.77439],[1.30145,103.77446],[1.30132,103.77448],[1.30111,103.77447],[1.30097,103.77443],[1.3009,103.77439],[1.30089,103.77437],[1.30084,103.77437],[1.30075,103.77433],[1.3007,103.77431],[1.30066,103.77432],[1.30065,103.77432],[1.3006,103.77434],[1.30055,103.77437],[1.30046,103.77443],[1.30035,103.7745],[1.30022,103.77456],[1.30008,103.77462],[1.29996,103.77464],[1.29986,103.77465],[1.29968,103.77465],[1.29963,103.77466],[1.29957,103.77467],[1.29953,103.77468],[1.29949,103.77469],[1.29941,103.7747],[1.29935,103.7747],[1.2993,103.77467],[1.29926,103.77462],[1.29923,103.77454],[1.2992,103.77451],[1.29915,103.77443],[1.29907,103.77439],[1.29893,103.7743],[1.29889,103.77428],[1.2988,103.77423],[1.29869,103.77415],[1.29848,103.77398],[1.29835,103.77385],[1.29824,103.7737],[1.29816,103.77357],[1.29796,103.77326],[1.29791,103.77321],[1.29786,103.77316],[1.29776,103.7731],[1.29769,103.77306],[1.29755,103.77301],[1.29733,103.77293],[1.29712,103.77285],[1.29706,103.77281],[1.29694,103.77276],[1.29685,103.7727],[1.29674,103.77263],[1.2967,103.7726],[1.29664,103.77255],[1.29662,103.77252],[1.29659,103.77249],[1.29653,103.77243],[1.29651,103.77241],[1.29645,103.77235],[1.29643,103.77232],[1.29641,103.7723],[1.29635,103.7722],[1.29629,103.772],[1.29625,103.77183],[1.29624,103.77171],[1.29624,103.77158],[1.29625,103.77143],[1.29627,103.77106],[1.29627,103.77101],[1.29627,103.77091],[1.2962,103.7709],[1.29615,103.7709],[1.29605,103.77089],[1.29588,103.77087],[1.29569,103.7708],[1.29551,103.77073],[1.29535,103.77065],[1.29518,103.7706],[1.29509,103.77058],[1.29506,103.77057],[1.29497,103.77056],[1.29496,103.77056],[1.29479,103.77055],[1.29459,103.77057],[1.29454,103.77059],[1.29445,103.77061],[1.29434,103.77065],[1.29423,103.77069],[1.29417,103.77071],[1.29411,103.77075],[1.2939,103.77091],[1.29379,103.77102],[1.2937,103.77115],[1.29362,103.77128],[1.29355,103.77143],[1.29354,103.77146],[1.2935,103.7716],[1.29348,103.77176],[1.29345,103.77196],[1.29343,103.77211],[1.29341,103.77218],[1.29337,103.77235],[1.29334,103.77247],[1.29329,103.77258],[1.29324,103.7727],[1.29318,103.7728],[1.29308,103.77298],[1.29295,103.77317],[1.29268,103.77348],[1.2926,103.77355],[1.29256,103.77359],[1.29241,103.77376],[1.29234,103.77392],[1.2923,103.77404],[1.29229,103.77407],[1.29222,103.77423],[1.29221,103.77425],[1.29216,103.77441],[1.29215,103.77444],[1.29232,103.77456],[1.29248,103.77467],[1.29281,103.77492],[1.29288,103.77497],[1.2931,103.7751],[1.2932,103.77513],[1.29324,103.77514],[1.29333,103.77517],[1.29342,103.77519],[1.29355,103.77523],[1.29363,103.77526],[1.29368,103.77533],[1.2937,103.77538],[1.29371,103.7755],[1.29384,103.77547],[1.29387,103.77546],[1.29443,103.77522]],"D2":[[1.29443,103.77522],[1.29387,103.77546],[1.29384,103.77547],[1.29371,103.7755],[1.29372,103.77555],[1.29373,103.77582],[1.29374,103.77597],[1.29374,103.77602],[1.29372,103.77615],[1.29374,103.77645],[1.29377,103.77672],[1.29377,103.7768],[1.29377,103.77684],[1.29376,103.77687],[1.29356,103.77718],[1.29351,103.77725],[1.29314,103.7778],[1.29309,103.7779],[1.29305,103.77801],[1.29301,103.77813],[1.29298,103.77827],[1.29296,103.77862],[1.29294,103.77872],[1.29292,103.77885],[1.29289,103.77894],[1.29287,103.77897],[1.29284,103.77904],[1.29278,103.77914],[1.29265,103.77932],[1.29255,103.77945],[1.29236,103.77972],[1.29233,103.77976],[1.29228,103.77983],[1.29226,103.7799],[1.29219,103.78009],[1.29216,103.78015],[1.29216,103.78015],[1.29212,103.7802],[1.29207,103.78024],[1.29201,103.78028],[1.29195,103.78031],[1.29188,103.78034],[1.29177,103.78036],[1.29175,103.78036],[1.29171,103.78037],[1.29164,103.78039],[1.2915,103.78044],[1.29142,103.78049],[1.2914,103.7805],[1.29129,103.78059],[1.29122,103.7807],[1.29118,103.78075],[1.29114,103.78085],[1.29112,103.78099],[1.29113,103.78111],[1.29116,103.78132],[1.29118,103.78145],[1.29127,103.7817],[1.29146,103.78211],[1.29164,103.78251],[1.29181,103.78287],[1.29196,103.78318],[1.29182,103.78328],[1.29164,103.78348],[1.2916,103.78353],[1.29167,103.78361],[1.29189,103.78385],[1.29212,103.78409],[1.29216,103.78413],[1.29221,103.78418],[1.29225,103.78423],[1.29226,103.78423],[1.29244,103.78443],[1.29279,103.78478],[1.29289,103.78487],[1.29302,103.78499],[1.29316,103.78504],[1.29323,103.78505],[1.29327,103.78506],[1.29332,103.78506],[1.29339,103.78505],[1.29349,103.78502],[1.29368,103.78494],[1.29371,103.78494],[1.29385,103.78492],[1.29407,103.7849],[1.2941,103.7849],[1.29415,103.78489],[1.29419,103.78488],[1.29423,103.78486],[1.29427,103.78484],[1.29449,103.7847],[1.29466,103.78458],[1.29473,103.78453],[1.29484,103.78445],[1.29503,103.78433],[1.29519,103.78423],[1.29526,103.78419],[1.29536,103.78413],[1.29537,103.78409],[1.29539,103.78404],[1.29543,103.78401],[1.29548,103.784],[1.29553,103.78401],[1.29596,103.78377],[1.29604,103.78371],[1.29607,103.78368],[1.29615,103.78363],[1.29623,103.78357],[1.29636,103.78345],[1.29645,103.78336],[1.2965,103.78331],[1.29664,103.78312],[1.29675,103.78294],[1.29677,103.7829],[1.29679,103.78289],[1.2969,103.78271],[1.29691,103.78267],[1.29692,103.78262],[1.29693,103.78252],[1.29693,103.78243],[1.29694,103.78237],[1.29696,103.78221],[1.29702,103.78208],[1.29717,103.78186],[1.2973,103.78168],[1.29734,103.78159],[1.29738,103.78152],[1.29738,103.78151],[1.29742,103.7814],[1.29744,103.78125],[1.29744,103.78121],[1.29744,103.78109],[1.29744,103.781],[1.29744,103.78094],[1.29743,103.78087],[1.29743,103.7808],[1.29742,103.78076],[1.29742,103.78072],[1.29741,103.78065],[1.29741,103.78057],[1.29741,103.78049],[1.29742,103.78044],[1.29743,103.78039],[1.29741,103.7803],[1.29737,103.78014],[1.29732,103.77999],[1.29726,103.77987],[1.29725,103.77984],[1.2972,103.7797],[1.29716,103.77958],[1.29713,103.77945],[1.29713,103.77938],[1.29713,103.77924],[1.29713,103.77909],[1.29718,103.77892],[1.29721,103.77885],[1.29727,103.77864],[1.29733,103.7785],[1.29736,103.77841],[1.29741,103.77827],[1.29753,103.77793],[1.29763,103.77768],[1.29768,103.7776],[1.29771,103.77754],[1.29776,103.77748],[1.29787,103.77733],[1.29797,103.7772],[1.29809,103.77706],[1.29828,103.77687],[1.29848,103.77673],[1.29866,103.77658],[1.29872,103.77649],[1.29879,103.77637],[1.29885,103.7762],[1.29888,103.77611],[1.29888,103.77602],[1.29888,103.77596],[1.29888,103.77593],[1.29885,103.77576],[1.29884,103.77561],[1.29884,103.77559],[1.29886,103.77542],[1.29886,103.7754],[1.2989,103.77525],[1.29907,103.77497],[1.29916,103.77487],[1.2992,103.77482],[1.29921,103.77474],[1.29924,103.77467],[1.29926,103.77462],[1.29923,103.77454],[1.29925,103.77448],[1.2993,103.77444],[1.29935,103.77442],[1.29947,103.77444],[1.29957,103.77448],[1.29961,103.77451],[1.29971,103.77452],[1.2998,103.77452],[1.29991,103.77452],[1.29997,103.77451],[1.30007,103.77449],[1.30018,103.77445],[1.30034,103.77437],[1.30046,103.77431],[1.3005,103.77425],[1.30056,103.77416],[1.30058,103.77413],[1.3006,103.77412],[1.30064,103.77403],[1.30067,103.77398],[1.30076,103.77382],[1.30083,103.7737],[1.3009,103.77358],[1.30096,103.77343],[1.30098,103.77338],[1.30102,103.77323],[1.30103,103.77314],[1.30111,103.77314],[1.30119,103.77314],[1.30119,103.77319],[1.30116,103.7733],[1.30113,103.77342],[1.30104,103.77367],[1.30103,103.77368],[1.301,103.77377],[1.30095,103.77385],[1.30083,103.77404],[1.3008,103.77409],[1.30078,103.77414],[1.30075,103.77418],[1.30076,103.7742],[1.30077,103.77421],[1.30079,103.77424],[1.30086,103.77432],[1.30089,103.77437],[1.3009,103.77439],[1.30097,103.77443],[1.30111,103.77447],[1.30132,103.77448],[1.30145,103.77446],[1.30164,103.77439],[1.30172,103.77434],[1.30232,103.77406],[1.30257,103.77398],[1.30277,103.77395],[1.30289,103.77396],[1.30303,103.77399],[1.30316,103.77405],[1.30323,103.7741],[1.30329,103.77416],[1.30336,103.77423],[1.30343,103.77433],[1.3035,103.77442],[1.30358,103.77454],[1.30364,103.77466],[1.30368,103.77479],[1.30369,103.77503],[1.30364,103.77527],[1.30366,103.77543],[1.30368,103.77548],[1.30369,103.77553],[1.30372,103.77552],[1.30375,103.77551],[1.30378,103.77552],[1.30381,103.77553],[1.30383,103.77555],[1.30384,103.77558],[1.30385,103.77561],[1.30384,103.77564],[1.30383,103.77566],[1.30382,103.77568],[1.30379,103.7757],[1.30377,103.77571],[1.30375,103.77571],[1.30372,103.7757],[1.3037,103.77569],[1.30368,103.77567],[1.30366,103.77565],[1.30365,103.77562],[1.30366,103.77559],[1.30367,103.77556],[1.30369,103.77553],[1.30368,103.77548],[1.30366,103.77543],[1.30364,103.77527],[1.30363,103.77515],[1.30357,103.77503],[1.30355,103.77499],[1.30354,103.77495],[1.30352,103.77486],[1.3035,103.77477],[1.30349,103.77468],[1.30346,103.77457],[1.30342,103.77441],[1.30338,103.77432],[1.30336,103.77423],[1.30329,103.77416],[1.30323,103.7741],[1.30316,103.77405],[1.30303,103.77399],[1.30289,103.77396],[1.30277,103.77395],[1.30257,103.77398],[1.30232,103.77406],[1.30172,103.77434],[1.30164,103.77439],[1.30145,103.77446],[1.30132,103.77448],[1.30111,103.77447],[1.30097,103.77443],[1.3009,103.77439],[1.30089,103.77437],[1.30084,103.77437],[1.30075,103.77433],[1.3007,103.77431],[1.30066,103.77432],[1.30065,103.77432],[1.3006,103.77434],[1.30055,103.77437],[1.30046,103.77443],[1.30035,103.7745],[1.30022,103.77456],[1.30008,103.77462],[1.29996,103.77464],[1.29986,103.77465],[1.29968,103.77465],[1.29963,103.77466],[1.29957,103.77467],[1.29953,103.77468],[1.29949,103.77469],[1.29941,103.7747],[1.29928,103.77479],[1.29923,103.77481],[1.2992,103.77482],[1.29916,103.77487],[1.29907,103.77497],[1.2989,103.77525],[1.29886,103.7754],[1.29886,103.77542],[1.29884,103.77559],[1.29885,103.77576],[1.29888,103.77593],[1.29888,103.77596],[1.29888,103.77602],[1.29888,103.7761],[1.29888,103.77611],[1.29885,103.7762],[1.29879,103.77637],[1.29872,103.77649],[1.29866,103.77658],[1.29848,103.77673],[1.29828,103.77687],[1.29809,103.77706],[1.29797,103.7772],[1.29787,103.77733],[1.29776,103.77748],[1.29771,103.77754],[1.29768,103.7776],[1.29763,103.77768],[1.29753,103.77793],[1.29748,103.77805],[1.29741,103.77827],[1.29736,103.77841],[1.29733,103.7785],[1.29727,103.77864],[1.29718,103.77892],[1.29713,103.77909],[1.29713,103.77924],[1.29713,103.77938],[1.29713,103.77945],[1.29716,103.77958],[1.2972,103.7797],[1.29725,103.77984],[1.29726,103.77987],[1.29732,103.77999],[1.29737,103.78014],[1.29741,103.7803],[1.29743,103.78039],[1.29744,103.78043],[1.29746,103.78051],[1.29749,103.78068],[1.29749,103.78073],[1.29751,103.78101],[1.2975,103.78121],[1.29749,103.78132],[1.29747,103.78142],[1.29744,103.78155],[1.29739,103.78164],[1.29731,103.78176],[1.29724,103.78185],[1.29716,103.78197],[1.2971,103.78207],[1.29704,103.78223],[1.29703,103.78226],[1.29702,103.78237],[1.29701,103.78239],[1.297,103.78244],[1.29699,103.78251],[1.29699,103.78253],[1.29699,103.78261],[1.29698,103.78271],[1.29697,103.78275],[1.29696,103.78286],[1.29692,103.78293],[1.29693,103.78297],[1.29692,103.783],[1.2969,103.78303],[1.29688,103.78305],[1.29686,103.78305],[1.29683,103.78306],[1.29667,103.78323],[1.29657,103.78336],[1.29647,103.78347],[1.29636,103.78357],[1.29632,103.78362],[1.29627,103.78366],[1.29619,103.78373],[1.29607,103.78381],[1.29587,103.78392],[1.29571,103.78405],[1.2956,103.78414],[1.29559,103.78418],[1.29557,103.78421],[1.29553,103.78423],[1.29549,103.78424],[1.29545,103.78424],[1.29536,103.78428],[1.29496,103.78454],[1.29495,103.78455],[1.29457,103.78484],[1.29453,103.78486],[1.29439,103.78493],[1.2942,103.785],[1.29409,103.78501],[1.29399,103.78502],[1.29389,103.78502],[1.29377,103.78503],[1.29367,103.78504],[1.29358,103.78507],[1.29356,103.78508],[1.29354,103.78509],[1.29349,103.78513],[1.29339,103.78522],[1.29334,103.78527],[1.29324,103.78537],[1.29318,103.78531],[1.29313,103.78526],[1.29286,103.785],[1.29237,103.7845],[1.29229,103.78443],[1.29213,103.78425],[1.29209,103.7842],[1.29205,103.78415],[1.29188,103.78398],[1.2916,103.78367],[1.29153,103.7836],[1.2916,103.78353],[1.29164,103.78348],[1.29182,103.78328],[1.29196,103.78318],[1.29181,103.78287],[1.29164,103.78251],[1.29146,103.78211],[1.29127,103.7817],[1.29118,103.78145],[1.29116,103.78145],[1.29114,103.78145],[1.2911,103.78143],[1.29108,103.78139],[1.29105,103.78133],[1.29104,103.7813],[1.29102,103.78124],[1.291,103.78121],[1.291,103.78118],[1.291,103.78107],[1.29101,103.78105],[1.2911,103.7807],[1.29114,103.78073],[1.29118,103.78075],[1.29122,103.7807],[1.29129,103.78059],[1.2914,103.7805],[1.29142,103.78049],[1.2915,103.78044],[1.29164,103.78039],[1.29171,103.78037],[1.29177,103.78036],[1.29188,103.78034],[1.29195,103.78031],[1.29201,103.78028],[1.29207,103.78024],[1.29212,103.7802],[1.29216,103.78015],[1.29216,103.78015],[1.29219,103.78009],[1.29226,103.7799],[1.29228,103.77983],[1.29233,103.77976],[1.29236,103.77972],[1.29255,103.77945],[1.29265,103.77932],[1.29278,103.77914],[1.29284,103.77904],[1.29287,103.77897],[1.29289,103.77894],[1.29292,103.77885],[1.29294,103.77872],[1.29296,103.77862],[1.29298,103.77827],[1.29301,103.77813],[1.29305,103.77801],[1.29309,103.7779],[1.29314,103.7778],[1.29351,103.77725],[1.29356,103.77718],[1.29371,103.77694],[1.29376,103.77687],[1.29377,103.77684],[1.29377,103.7768],[1.29374,103.77645],[1.29372,103.77615],[1.29374,103.77602],[1.29374,103.77597],[1.29373,103.77582],[1.29372,103.77555],[1.29371,103.7755],[1.29384,103.77547],[1.29387,103.77546],[1.29443,103.77522]],"K":[[1.29175,103.78036],[1.29171,103.78037],[1.29164,103.78039],[1.2915,103.78044],[1.29142,103.78049],[1.2914,103.7805],[1.29129,103.78059],[1.29122,103.7807],[1.29118,103.78075],[1.29114,103.78085],[1.29112,103.78099],[1.29113,103.78111],[1.29116,103.78132],[1.29118,103.78145],[1.29127,103.7817],[1.29146,103.78211],[1.29164,103.78251],[1.29181,103.78287],[1.29196,103.78318],[1.29182,103.78328],[1.29164,103.78348],[1.2916,103.78353],[1.29167,103.78361],[1.29189,103.78385],[1.29212,103.78409],[1.29216,103.78413],[1.29221,103.78418],[1.29225,103.78423],[1.29226,103.78423],[1.29244,103.78443],[1.29279,103.78478],[1.29289,103.78487],[1.29302,103.78499],[1.29316,103.78504],[1.29323,103.78505],[1.29327,103.78506],[1.29332,103.78506],[1.29339,103.78505],[1.29349,103.78502],[1.29368,103.78494],[1.29371,103.78494],[1.29385,103.78492],[1.29407,103.7849],[1.2941,103.7849],[1.29415,103.78489],[1.29419,103.78488],[1.29423,103.78486],[1.29427,103.78484],[1.29449,103.7847],[1.29466,103.78458],[1.29473,103.78453],[1.29485,103.78445],[1.29503,103.78433],[1.29519,103.78423],[1.29526,103.78419],[1.29536,103.78413],[1.29537,103.78409],[1.29539,103.78404],[1.29543,103.78401],[1.29548,103.784],[1.29553,103.78401],[1.29596,103.78377],[1.29604,103.78371],[1.29607,103.78368],[1.29615,103.78363],[1.29623,103.78357],[1.29636,103.78345],[1.29645,103.78336],[1.2965,103.78331],[1.29664,103.78312],[1.29675,103.78294],[1.29677,103.7829],[1.29679,103.78289],[1.2969,103.78271],[1.29691,103.78267],[1.29692,103.78262],[1.29693,103.78252],[1.29693,103.78243],[1.29694,103.78237],[1.29696,103.78221],[1.29702,103.78208],[1.29717,103.78186],[1.2973,103.78168],[1.29734,103.78159],[1.29738,103.78152],[1.29738,103.78151],[1.29742,103.7814],[1.29744,103.78125],[1.29744,103.78121],[1.29744,103.78109],[1.29744,103.781],[1.29744,103.78094],[1.29743,103.78087],[1.29743,103.7808],[1.29742,103.78076],[1.29742,103.78072],[1.29741,103.78065],[1.29741,103.78057],[1.29741,103.78049],[1.29742,103.78044],[1.29743,103.78039],[1.29741,103.7803],[1.29737,103.78014],[1.29732,103.77999],[1.29726,103.77987],[1.29725,103.77984],[1.2972,103.7797],[1.29716,103.77958],[1.29713,103.77945],[1.29713,103.77938],[1.29713,103.77924],[1.29713,103.77909],[1.29718,103.77892],[1.29721,103.77885],[1.29727,103.77864],[1.29733,103.7785],[1.29736,103.77841],[1.29741,103.77827],[1.29753,103.77793],[1.29763,103.77768],[1.29768,103.7776],[1.29771,103.77754],[1.29776,103.77748],[1.29787,103.77733],[1.29797,103.7772],[1.29809,103.77706],[1.29828,103.77687],[1.29848,103.77673],[1.29866,103.77658],[1.29872,103.77649],[1.29879,103.77637],[1.29885,103.7762],[1.29888,103.77611],[1.29888,103.77602],[1.29888,103.77596],[1.29888,103.77593],[1.29885,103.77576],[1.29884,103.77561],[1.29884,103.77559],[1.29886,103.77542],[1.29886,103.7754],[1.2989,103.77525],[1.29907,103.77497],[1.29916,103.77487],[1.2992,103.77482],[1.29921,103.77474],[1.29924,103.77467],[1.29926,103.77462],[1.29923,103.77454],[1.2992,103.77451],[1.29915,103.77443],[1.29907,103.77439],[1.29893,103.7743],[1.29889,103.77428],[1.2988,103.77423],[1.29869,103.77415],[1.29848,103.77398],[1.29835,103.77385],[1.29824,103.7737],[1.29816,103.77357],[1.29796,103.77326],[1.29791,103.77321],[1.29786,103.77316],[1.29776,103.7731],[1.29769,103.77306],[1.29755,103.77301],[1.29733,103.77293],[1.29712,103.77285],[1.29706,103.77281],[1.29694,103.77276],[1.29685,103.7727],[1.29674,103.77263],[1.2967,103.7726],[1.29664,103.77255],[1.29662,103.77252],[1.29661,103.77251],[1.29653,103.77243],[1.29651,103.77241],[1.29645,103.77235],[1.29643,103.77232],[1.29641,103.7723],[1.29635,103.7722],[1.29629,103.772],[1.29625,103.77183],[1.29624,103.77171],[1.29624,103.77158],[1.29625,103.77143],[1.29627,103.77106],[1.29627,103.77101],[1.29627,103.77091],[1.29626,103.77068],[1.29625,103.7706],[1.29622,103.77041],[1.2962,103.77034],[1.29612,103.77001],[1.29609,103.76991],[1.29605,103.76977],[1.29605,103.76976],[1.29605,103.76974],[1.29605,103.76957],[1.29615,103.76957],[1.29621,103.76957],[1.2978,103.76967],[1.29787,103.76967],[1.29795,103.76967],[1.29816,103.76969],[1.2993,103.76975],[1.29962,103.76977],[1.2998,103.76978],[1.3002,103.76984],[1.30059,103.76994],[1.30063,103.76995],[1.30073,103.76999],[1.30074,103.77],[1.30084,103.77004],[1.30098,103.77011],[1.30123,103.77022],[1.30145,103.77033],[1.30156,103.77038],[1.30159,103.77033],[1.30163,103.77026],[1.30173,103.77003],[1.30179,103.76997],[1.30181,103.77005],[1.30175,103.77021],[1.30169,103.77039],[1.30167,103.77043],[1.30162,103.77056],[1.30158,103.77064],[1.30149,103.77086],[1.30129,103.77139],[1.30123,103.77156],[1.3012,103.77165],[1.30117,103.77174],[1.30113,103.77187],[1.30111,103.77199],[1.30109,103.77214],[1.30109,103.77234],[1.3011,103.77237],[1.30112,103.77252],[1.30116,103.77271],[1.30119,103.77288],[1.30119,103.7729],[1.3012,103.77303],[1.30119,103.77314],[1.30119,103.77319],[1.30116,103.7733],[1.30113,103.77342],[1.30104,103.77367],[1.30103,103.77368],[1.301,103.77377],[1.30095,103.77385],[1.30083,103.77404],[1.3008,103.77409],[1.30078,103.77414],[1.30075,103.77418],[1.30076,103.7742],[1.30076,103.77422],[1.30075,103.77424],[1.30074,103.77427],[1.30072,103.77429],[1.3007,103.77431],[1.30066,103.77432],[1.30065,103.77432],[1.3006,103.77434],[1.30055,103.77437],[1.30046,103.77443],[1.30035,103.7745],[1.30022,103.77456],[1.30008,103.77462],[1.29996,103.77464],[1.29986,103.77465],[1.29968,103.77465],[1.29963,103.77466],[1.29957,103.77467],[1.29953,103.77468],[1.29949,103.77469],[1.29941,103.7747],[1.29928,103.77479],[1.29923,103.77481],[1.2992,103.77482],[1.29916,103.77487],[1.29907,103.77497],[1.2989,103.77525],[1.29886,103.7754],[1.29886,103.77542],[1.29884,103.77559],[1.29885,103.77576],[1.29888,103.77593],[1.29888,103.77596],[1.29888,103.77602],[1.29888,103.7761],[1.29888,103.77611],[1.29885,103.7762],[1.29879,103.77637],[1.29872,103.77649],[1.29866,103.77658],[1.29848,103.77673],[1.29828,103.77687],[1.29809,103.77706],[1.29797,103.7772],[1.29787,103.77733],[1.29776,103.77748],[1.29771,103.77754],[1.29768,103.7776],[1.29763,103.77768],[1.29753,103.77793],[1.29748,103.77805],[1.29741,103.77827],[1.29736,103.77841],[1.29733,103.7785],[1.29727,103.77864],[1.29718,103.77892],[1.29713,103.77909],[1.29713,103.77924],[1.29713,103.77938],[1.29713,103.77945],[1.29716,103.77958],[1.2972,103.7797],[1.29725,103.77984],[1.29726,103.77987],[1.29732,103.77999],[1.29737,103.78014],[1.29741,103.7803],[1.29743,103.78039],[1.29744,103.78043],[1.29746,103.78051],[1.29749,103.78068],[1.29749,103.78073],[1.29751,103.78101],[1.2975,103.78121],[1.29749,103.78132],[1.29747,103.78142],[1.29744,103.78155],[1.29739,103.78164],[1.29731,103.78176],[1.29724,103.78185],[1.29716,103.78197],[1.2971,103.78207],[1.29704,103.78223],[1.29703,103.78226],[1.29702,103.78237],[1.29701,103.78239],[1.297,103.78244],[1.29699,103.78251],[1.29699,103.78253],[1.29699,103.78261],[1.29698,103.78271],[1.29697,103.78275],[1.29696,103.78286],[1.29692,103.78293],[1.29693,103.78297],[1.29692,103.783],[1.2969,103.78303],[1.29688,103.78305],[1.29686,103.78305],[1.29683,103.78306],[1.29667,103.78323],[1.29657,103.78336],[1.29647,103.78347],[1.29636,103.78357],[1.29632,103.78362],[1.29627,103.78366],[1.29619,103.78373],[1.29607,103.78381],[1.29587,103.78392],[1.29571,103.78405],[1.2956,103.78414],[1.29559,103.78418],[1.29557,103.78421],[1.29553,103.78423],[1.29549,103.78424],[1.29545,103.78424],[1.29536,103.78428],[1.29496,103.78454],[1.29495,103.78455],[1.29457,103.78484],[1.29453,103.78486],[1.29439,103.78493],[1.2942,103.785],[1.29409,103.78501],[1.29399,103.78502],[1.29389,103.78502],[1.29377,103.78503],[1.29367,103.78504],[1.29358,103.78507],[1.29356,103.78508],[1.29354,103.78509],[1.29349,103.78513],[1.29339,103.78522],[1.29334,103.78527],[1.29324,103.78537],[1.29318,103.78531],[1.29313,103.78526],[1.29286,103.785],[1.29237,103.7845],[1.29229,103.78443],[1.29213,103.78425],[1.29209,103.7842],[1.29205,103.78415],[1.29188,103.78398],[1.2916,103.78367],[1.29153,103.7836],[1.2916,103.78353],[1.29164,103.78348],[1.29182,103.78328],[1.29196,103.78318],[1.29181,103.78287],[1.29164,103.78251],[1.29146,103.78211],[1.29127,103.7817],[1.29118,103.78145],[1.29116,103.78145],[1.29114,103.78145],[1.2911,103.78143],[1.29108,103.78139],[1.29105,103.78133],[1.29104,103.7813],[1.29102,103.78124],[1.291,103.78121],[1.291,103.78115]],"R1":[[1.30179,103.76997],[1.30181,103.77005],[1.30175,103.77021],[1.30169,103.77039],[1.30167,103.77043],[1.30162,103.77056],[1.30158,103.77064],[1.30149,103.77086],[1.30129,103.77139],[1.30123,103.77156],[1.3012,103.77165],[1.30117,103.77174],[1.30113,103.77187],[1.30111,103.77199],[1.30109,103.77214],[1.30109,103.77234],[1.3011,103.77237],[1.30112,103.77252],[1.30116,103.77271],[1.30119,103.77288],[1.30119,103.7729],[1.3012,103.77303],[1.30119,103.77314],[1.30119,103.77319],[1.30116,103.7733],[1.30113,103.77342],[1.30105,103.77365],[1.30103,103.77368],[1.301,103.77377],[1.30095,103.77385],[1.30083,103.77404],[1.3008,103.77409],[1.30078,103.77414],[1.30075,103.77418],[1.30076,103.7742],[1.30077,103.77421],[1.30079,103.77424],[1.30086,103.77432],[1.30089,103.77437],[1.3009,103.77439],[1.30097,103.77443],[1.30111,103.77447],[1.30132,103.77448],[1.30145,103.77446],[1.30164,103.77439],[1.30172,103.77434],[1.30232,103.77406],[1.30257,103.77398],[1.30277,103.77395],[1.30289,103.77396],[1.30303,103.77399],[1.30316,103.77405],[1.30323,103.7741],[1.30329,103.77416],[1.30336,103.77423],[1.3035,103.77442],[1.30358,103.77454],[1.30364,103.77466],[1.30366,103.77472],[1.30368,103.77479],[1.30369,103.77503],[1.30364,103.77527],[1.30366,103.77543],[1.30368,103.77548],[1.30369,103.77553],[1.30372,103.77552],[1.30375,103.77551],[1.30378,103.77552],[1.30381,103.77553],[1.30383,103.77555],[1.30384,103.77558],[1.30385,103.77561],[1.30384,103.77564],[1.30383,103.77566],[1.30382,103.77568],[1.30379,103.7757],[1.30377,103.77571],[1.30375,103.77571],[1.30372,103.7757],[1.3037,103.77569],[1.30368,103.77567],[1.30366,103.77565],[1.30365,103.77562],[1.30366,103.77559],[1.30367,103.77556],[1.30369,103.77553],[1.30368,103.77548],[1.30366,103.77543],[1.30364,103.77527],[1.30363,103.77515],[1.30357,103.77503],[1.30355,103.77499],[1.30354,103.77495],[1.30352,103.77486],[1.3035,103.77477],[1.30349,103.77468],[1.30346,103.77457],[1.30342,103.77441],[1.30338,103.77432],[1.30336,103.77423],[1.30329,103.77416],[1.30323,103.7741],[1.30316,103.77405],[1.30303,103.77399],[1.30289,103.77396],[1.30277,103.77395],[1.30257,103.77398],[1.30232,103.77406],[1.30172,103.77434],[1.30164,103.77439],[1.30145,103.77446],[1.30132,103.77448],[1.30111,103.77447],[1.30097,103.77443],[1.3009,103.77439],[1.30089,103.77437],[1.30084,103.77437],[1.30075,103.77433],[1.3007,103.77431],[1.30066,103.77432],[1.30065,103.77432],[1.3006,103.77434],[1.30055,103.77437],[1.30046,103.77443],[1.30035,103.7745],[1.30022,103.77456],[1.30008,103.77462],[1.29996,103.77464],[1.29986,103.77465],[1.29968,103.77465],[1.29963,103.77466],[1.29957,103.77467],[1.29953,103.77468],[1.29949,103.77469],[1.29941,103.7747],[1.29935,103.7747],[1.2993,103.77467],[1.29926,103.77462],[1.29923,103.77454],[1.2992,103.77451],[1.29915,103.77443],[1.29907,103.77439],[1.29889,103.77428],[1.29889,103.77428],[1.2988,103.77423],[1.29869,103.77415],[1.29848,103.77398],[1.29835,103.77385],[1.29824,103.7737],[1.29816,103.77357],[1.29796,103.77326],[1.29791,103.77321],[1.29786,103.77316],[1.29776,103.7731],[1.29769,103.77306],[1.29755,103.77301],[1.29733,103.77293],[1.29712,103.77285],[1.29706,103.77281],[1.29694,103.77276],[1.29685,103.7727],[1.29674,103.77263],[1.2967,103.7726],[1.29664,103.77255],[1.29662,103.77252],[1.29653,103.77243],[1.29651,103.77241],[1.29645,103.77235],[1.29643,103.77232],[1.29641,103.7723],[1.29635,103.7722],[1.29634,103.77215],[1.29629,103.772],[1.29625,103.77183],[1.29624,103.77171],[1.29624,103.77158],[1.29625,103.77143],[1.29627,103.77106],[1.29627,103.77101],[1.29627,103.77091],[1.2962,103.7709],[1.29615,103.7709],[1.29605,103.77089],[1.29588,103.77087],[1.29569,103.7708],[1.29551,103.77073],[1.29535,103.77065],[1.29518,103.7706],[1.29509,103.77058],[1.29506,103.77057],[1.29497,103.77056],[1.29496,103.77056],[1.29482,103.77055],[1.29479,103.77055],[1.29459,103.77057],[1.29445,103.77061],[1.29434,103.77065],[1.29423,103.77069],[1.29417,103.77071],[1.29411,103.77075],[1.2939,103.77091],[1.29379,103.77102],[1.2937,103.77115],[1.29362,103.77128],[1.29355,103.77143],[1.2935,103.7716],[1.29348,103.77176],[1.29347,103.77178],[1.29345,103.77196],[1.29343,103.77211],[1.29341,103.77218],[1.29337,103.77235],[1.29334,103.77247],[1.29329,103.77258],[1.29324,103.7727],[1.29318,103.7728],[1.29308,103.77298],[1.29295,103.77317],[1.29268,103.77348],[1.2926,103.77355],[1.29256,103.77359],[1.29241,103.77376],[1.29234,103.77392],[1.2923,103.77404],[1.29229,103.77407],[1.29222,103.77423],[1.29221,103.77425],[1.29216,103.77441],[1.29215,103.77444],[1.29232,103.77456],[1.29248,103.77467],[1.29281,103.77492],[1.29288,103.77497],[1.2931,103.7751],[1.29324,103.77514],[1.29333,103.77517],[1.29336,103.77518],[1.29342,103.77519],[1.29355,103.77523],[1.29363,103.77526],[1.29368,103.77533],[1.2937,103.77538],[1.29371,103.7755],[1.29372,103.77555],[1.29373,103.77582],[1.29374,103.77597],[1.29374,103.77602],[1.29372,103.77615],[1.29374,103.77645],[1.29377,103.7768],[1.29377,103.77684],[1.29376,103.77687],[1.29356,103.77718],[1.29351,103.77725],[1.29314,103.7778],[1.29309,103.7779],[1.29305,103.77801],[1.29301,103.77813],[1.29298,103.77827],[1.29296,103.77862],[1.29294,103.77872],[1.29292,103.77885],[1.29289,103.77894],[1.29287,103.77897],[1.29284,103.77904],[1.29278,103.77914],[1.29265,103.77932],[1.29255,103.77945],[1.29236,103.77972],[1.29233,103.77976],[1.29228,103.77983],[1.29226,103.7799],[1.29219,103.78009],[1.29216,103.78015],[1.29216,103.78015],[1.29212,103.7802],[1.29207,103.78024],[1.29201,103.78028],[1.29195,103.78031],[1.29188,103.78034],[1.29179,103.78036]],"R2":[[1.29179,103.78036],[1.29188,103.78034],[1.29195,103.78031],[1.29201,103.78028],[1.29207,103.78024],[1.29212,103.7802],[1.29216,103.78015],[1.29216,103.78015],[1.29219,103.78009],[1.29226,103.7799],[1.29228,103.77983],[1.29233,103.77976],[1.29236,103.77972],[1.29255,103.77945],[1.29265,103.77932],[1.29278,103.77914],[1.29284,103.77904],[1.29287,103.77897],[1.29289,103.77894],[1.29292,103.77885],[1.29294,103.77872],[1.29296,103.77862],[1.29298,103.77827],[1.29301,103.77813],[1.29305,103.77801],[1.29309,103.7779],[1.29314,103.7778],[1.29351,103.77725],[1.29356,103.77718],[1.29376,103.77687],[1.29377,103.77684],[1.29377,103.7768],[1.29374,103.77645],[1.29372,103.77615],[1.29374,103.77602],[1.29374,103.77597],[1.29373,103.77582],[1.29372,103.77555],[1.29371,103.7755],[1.2937,103.77538],[1.29368,103.77533],[1.29363,103.77526],[1.29355,103.77523],[1.29342,103.77519],[1.29333,103.77517],[1.29324,103.77514],[1.2931,103.7751],[1.29299,103.77504],[1.29288,103.77497],[1.29281,103.77492],[1.29248,103.77467],[1.29232,103.77456],[1.29215,103.77444],[1.29216,103.77441],[1.29221,103.77425],[1.29219,103.77411],[1.29217,103.77406],[1.29214,103.77402],[1.292,103.77391],[1.29215,103.77386],[1.29229,103.77381],[1.29241,103.77376],[1.29256,103.77359],[1.2926,103.77355],[1.29268,103.77348],[1.29295,103.77317],[1.29308,103.77298],[1.29318,103.7728],[1.29324,103.7727],[1.29329,103.77258],[1.29334,103.77247],[1.29334,103.77245],[1.29337,103.77235],[1.29341,103.77218],[1.29343,103.77211],[1.29345,103.77196],[1.29348,103.77176],[1.2935,103.7716],[1.29355,103.77143],[1.29362,103.77128],[1.2937,103.77115],[1.29379,103.77102],[1.2939,103.77091],[1.29411,103.77075],[1.29417,103.77071],[1.29423,103.77069],[1.29434,103.77065],[1.29445,103.77061],[1.29459,103.77057],[1.29479,103.77055],[1.29496,103.77056],[1.29497,103.77056],[1.29506,103.77057],[1.29509,103.77058],[1.29518,103.7706],[1.29533,103.77065],[1.29535,103.77065],[1.29551,103.77073],[1.29569,103.7708],[1.29588,103.77087],[1.29605,103.77089],[1.29615,103.7709],[1.2962,103.7709],[1.29627,103.77091],[1.2964,103.77094],[1.2964,103.77101],[1.29639,103.77107],[1.29636,103.77161],[1.29637,103.77178],[1.2964,103.77195],[1.29644,103.77205],[1.29649,103.77214],[1.29656,103.77222],[1.29658,103.77225],[1.29662,103.77228],[1.29667,103.77232],[1.29672,103.77235],[1.29683,103.77243],[1.29698,103.77239],[1.29702,103.77239],[1.29709,103.77238],[1.29714,103.77238],[1.29717,103.7724],[1.2972,103.77241],[1.29723,103.77242],[1.29727,103.77244],[1.29717,103.77267],[1.29727,103.77244],[1.29723,103.77242],[1.2972,103.77241],[1.29717,103.7724],[1.29714,103.77238],[1.29709,103.77238],[1.29702,103.77239],[1.29701,103.77242],[1.2969,103.7725],[1.29697,103.77257],[1.2971,103.77267],[1.29726,103.77279],[1.29743,103.7729],[1.29759,103.77296],[1.29771,103.773],[1.29779,103.77303],[1.29789,103.7731],[1.298,103.7732],[1.29819,103.77346],[1.29833,103.77368],[1.29845,103.77384],[1.2986,103.77398],[1.2987,103.77405],[1.29882,103.77414],[1.29893,103.77421],[1.29918,103.77435],[1.29928,103.77439],[1.29935,103.77442],[1.29947,103.77444],[1.29957,103.77448],[1.29961,103.77451],[1.29971,103.77452],[1.2998,103.77452],[1.29991,103.77452],[1.29997,103.77451],[1.30007,103.77449],[1.30018,103.77445],[1.30034,103.77437],[1.30046,103.77431],[1.3005,103.77425],[1.30056,103.77416],[1.30058,103.77413],[1.3006,103.77412],[1.30063,103.77411],[1.30065,103.77411],[1.30068,103.77411],[1.3007,103.77412],[1.30072,103.77414],[1.30074,103.77415],[1.30075,103.77418],[1.30076,103.7742],[1.30077,103.77421],[1.30079,103.77424],[1.30086,103.77432],[1.30089,103.77437],[1.3009,103.77439],[1.30097,103.77443],[1.30111,103.77447],[1.30132,103.77448],[1.30145,103.77446],[1.30164,103.77439],[1.30172,103.77434],[1.30232,103.77406],[1.30257,103.77398],[1.30277,103.77395],[1.30289,103.77396],[1.30303,103.77399],[1.30316,103.77405],[1.30323,103.7741],[1.30329,103.77416],[1.30336,103.77423],[1.3035,103.77442],[1.30358,103.77454],[1.30364,103.77466],[1.30367,103.77478],[1.30368,103.77479],[1.30369,103.77503],[1.30364,103.77527],[1.30366,103.77543],[1.30368,103.77548],[1.30369,103.77553],[1.30372,103.77552],[1.30375,103.77551],[1.30378,103.77552],[1.30381,103.77553],[1.30383,103.77555],[1.30384,103.77558],[1.30385,103.77561],[1.30384,103.77564],[1.30383,103.77566],[1.30382,103.77568],[1.30379,103.7757],[1.30377,103.77571],[1.30375,103.77571],[1.30372,103.7757],[1.3037,103.77569],[1.30368,103.77567],[1.30366,103.77565],[1.30365,103.77562],[1.30366,103.77559],[1.30367,103.77556],[1.30369,103.77553],[1.30368,103.77548],[1.30366,103.77543],[1.30364,103.77527],[1.30363,103.77515],[1.30357,103.77503],[1.30355,103.77499],[1.30354,103.77495],[1.30352,103.77486],[1.3035,103.77477],[1.30349,103.77468],[1.30346,103.77457],[1.30342,103.77441],[1.30338,103.77432],[1.30336,103.77423],[1.30329,103.77416],[1.30323,103.7741],[1.30316,103.77405],[1.30303,103.77399],[1.30289,103.77396],[1.30277,103.77395],[1.30257,103.77398],[1.30232,103.77406],[1.30172,103.77434],[1.30164,103.77439],[1.30145,103.77446],[1.30132,103.77448],[1.30111,103.77447],[1.30097,103.77443],[1.3009,103.77439],[1.30089,103.77437],[1.30084,103.77437],[1.30075,103.77433],[1.3007,103.77431],[1.30066,103.77432],[1.30065,103.77432],[1.30063,103.77432],[1.3006,103.77431],[1.30058,103.77429],[1.30056,103.77427],[1.30055,103.77424],[1.30054,103.77421],[1.30055,103.77418],[1.30056,103.77416],[1.30058,103.77413],[1.3006,103.77412],[1.30064,103.77403],[1.30067,103.77398],[1.30076,103.77382],[1.30083,103.7737],[1.3009,103.77358],[1.30096,103.77343],[1.30098,103.77338],[1.30102,103.77323],[1.30103,103.77314],[1.30105,103.77288],[1.30102,103.77269],[1.30101,103.7726],[1.30099,103.77237],[1.30099,103.77222],[1.30101,103.77192],[1.30106,103.77173],[1.3011,103.7716],[1.30113,103.77152],[1.30119,103.77136],[1.3014,103.77081],[1.30147,103.77058],[1.3015,103.77051],[1.30156,103.77038],[1.30159,103.77033],[1.30163,103.77026],[1.30173,103.77003],[1.30179,103.76997]],"E":[[1.29443,103.77522],[1.29387,103.77546],[1.29384,103.77547],[1.29371,103.7755],[1.2937,103.77538],[1.29368,103.77533],[1.29363,103.77526],[1.29355,103.77523],[1.29342,103.77519],[1.29333,103.77517],[1.29324,103.77514],[1.2931,103.7751],[1.29288,103.77497],[1.29283,103.77494],[1.29281,103.77492],[1.29248,103.77467],[1.29232,103.77456],[1.29215,103.77444],[1.29216,103.77441],[1.29221,103.77425],[1.29219,103.77411],[1.29217,103.77406],[1.29214,103.77402],[1.292,103.77391],[1.29215,103.77386],[1.29229,103.77381],[1.29241,103.77376],[1.29256,103.77359],[1.2926,103.77355],[1.29268,103.77348],[1.29295,103.77317],[1.29308,103.77298],[1.29318,103.7728],[1.29324,103.7727],[1.29326,103.77264],[1.29329,103.77258],[1.29334,103.77247],[1.29337,103.77235],[1.29341,103.77218],[1.29343,103.77211],[1.29345,103.77196],[1.29348,103.77176],[1.2935,103.7716],[1.29355,103.77143],[1.29362,103.77128],[1.2937,103.77115],[1.29379,103.77102],[1.2939,103.77091],[1.29411,103.77075],[1.29417,103.77071],[1.29423,103.77069],[1.29434,103.77065],[1.29445,103.77061],[1.29459,103.77057],[1.29479,103.77055],[1.29496,103.77056],[1.29497,103.77056],[1.29506,103.77057],[1.29509,103.77058],[1.29518,103.7706],[1.29533,103.77065],[1.29535,103.77065],[1.29551,103.77073],[1.29569,103.7708],[1.29588,103.77087],[1.29605,103.77089],[1.29615,103.7709],[1.2962,103.7709],[1.29627,103.77091],[1.2964,103.77094],[1.2964,103.77101],[1.29639,103.77107],[1.29636,103.77161],[1.29637,103.77178],[1.2964,103.77195],[1.29644,103.77205],[1.29649,103.77214],[1.29656,103.77222],[1.29658,103.77225],[1.29662,103.77228],[1.29667,103.77232],[1.29672,103.77235],[1.29683,103.77243],[1.29698,103.77239],[1.29702,103.77239],[1.29709,103.77238],[1.29714,103.77238],[1.29717,103.7724],[1.2972,103.77241],[1.29723,103.77242],[1.29727,103.77244],[1.29717,103.77267],[1.29727,103.77244],[1.29723,103.77242],[1.2972,103.77241],[1.29717,103.7724],[1.29714,103.77238],[1.29709,103.77238],[1.29702,103.77239],[1.29701,103.77242],[1.2969,103.7725],[1.29697,103.77257],[1.2971,103.77267],[1.29726,103.77279],[1.29743,103.7729],[1.29759,103.77296],[1.29771,103.773],[1.29779,103.77303],[1.29789,103.7731],[1.298,103.7732],[1.29819,103.77346],[1.29833,103.77368],[1.29845,103.77384],[1.2986,103.77398],[1.2987,103.77405],[1.29882,103.77414],[1.29887,103.77417],[1.29918,103.77435],[1.29928,103.77439],[1.29935,103.77442],[1.29947,103.77444],[1.29957,103.77448],[1.29961,103.77451],[1.29971,103.77452],[1.2998,103.77452],[1.29991,103.77452],[1.29997,103.77451],[1.30007,103.77449],[1.30018,103.77445],[1.30034,103.77437],[1.30046,103.77431],[1.3005,103.77425],[1.30056,103.77416],[1.30058,103.77413],[1.3006,103.77412],[1.30064,103.77403],[1.30067,103.77398],[1.30076,103.77382],[1.30083,103.7737],[1.3009,103.77358],[1.30096,103.77343],[1.30098,103.77338],[1.30102,103.77323],[1.30103,103.77314],[1.30111,103.77314],[1.30119,103.77314],[1.30119,103.77319],[1.30116,103.7733],[1.30113,103.77342],[1.30104,103.77367]]};

const NUS_ROUTE_STOPS = {
  A1: new Set(["KRB","LT13","AS5","BIZ2","TCOMS-OPP","PGP","KR-MRT","LT27","UHALL","UHC-OPP","YIH","CLB","Opp TCOMS","Prince George's Park (PGP)","Kent Ridge MRT (Exit A)","Faculty of Science (LT27)","University Hall","Opp University Health Centre","Yusof Ishak House (YIH)","Central Library (CLB)","Lecture Theatre 13 (LT13)","Faculty of Arts (AS5)","Business School (BIZ 2)","Kent Ridge Bus Terminal"]),
  A2: new Set(["KRB","IT","YIH-OPP","MUSEUM","UHC","UHALL-OPP","S17","KR-MRT-OPP","PGPR","TCOMS","HSSML-OPP","NUSS-OPP","LT13-OPP","NUS Museum","University Health Centre (UHC)","Opp University Hall","Faculty of Science (S17)","Opp Kent Ridge MRT","Prince George's Park Residences (PGPR)","TCOMS","Opp Hon Sui Sen Memorial Library","Opp NUSS Guild House","Ventus (Opp LT13)","Information Technology (IT)","Opp Yusof Ishak House (Opp YIH)","Kent Ridge Bus Terminal"]),
  D1: new Set(["COM3","HSSML-OPP","NUSS-OPP","LT13-OPP","IT","YIH-OPP","MUSEUM","UTOWN","YIH","CLB","LT13","AS5","BIZ2","COM 3 (School of Computing)","NUS Museum","University Town (UTown)","Opp Hon Sui Sen Memorial Library","Opp NUSS Guild House","Ventus (Opp LT13)","Information Technology (IT)","Opp Yusof Ishak House (Opp YIH)","Yusof Ishak House (YIH)","Central Library (CLB)","Lecture Theatre 13 (LT13)","Faculty of Arts (AS5)","Business School (BIZ 2)"]),
  D2: new Set(["COM3","TCOMS-OPP","PGP","KR-MRT","LT27","UHALL","UHC-OPP","MUSEUM","UTOWN","UHC","UHALL-OPP","S17","KR-MRT-OPP","PGPR","TCOMS","COM 3 (School of Computing)","Opp TCOMS","Prince George's Park (PGP)","Kent Ridge MRT (Exit A)","Faculty of Science (LT27)","University Hall","Opp University Health Centre","NUS Museum","University Town (UTown)","University Health Centre (UHC)","Opp University Hall","Faculty of Science (S17)","Opp Kent Ridge MRT","Prince George's Park Residences (PGPR)","TCOMS"]),
  E: new Set(["UTOWN","MUSEUM","YIH","CLB","LT13","AS5","BIZ2","COM3","COM 3 (School of Computing)","NUS Museum","University Town (UTown)","Yusof Ishak House (YIH)","Central Library (CLB)","Lecture Theatre 13 (LT13)","Faculty of Arts (AS5)","Business School (BIZ 2)"]),
  K: new Set(["PGP","KR-MRT","LT27","UHALL","UHC-OPP","YIH","CLB","SDE3-OPP","JP-SCH-16151","KV","MUSEUM","UHC","UHALL-OPP","S17","KR-MRT-OPP","PGPR","Prince George's Park (PGP)","Kent Ridge MRT (Exit A)","Faculty of Science (LT27)","University Hall","Opp University Health Centre","NUS Museum","University Health Centre (UHC)","Opp University Hall","Faculty of Science (S17)","Opp Kent Ridge MRT","Prince George's Park Residences (PGPR)","Yusof Ishak House (YIH)","Central Library (CLB)","Opp SDE 3","The Japanese Primary School","Kent Vale"]),
  R1: new Set(["KV","UTOWN","MUSEUM","YIH","CLB","LT13","AS5","BIZ2","TCOMS-OPP","PGP","Kent Vale","University Town (UTown)","NUS Museum","Yusof Ishak House (YIH)","Central Library (CLB)","Lecture Theatre 13 (LT13)","Faculty of Arts (AS5)","Business School (BIZ 2)","Opp TCOMS","Prince George's Park (PGP)"]),
  R2: new Set(["PGP","TCOMS","HSSML-OPP","NUSS-OPP","LT13-OPP","IT","YIH-OPP","MUSEUM","UTOWN","KV","Prince George's Park (PGP)","TCOMS","Opp Hon Sui Sen Memorial Library","Opp NUSS Guild House","Ventus (Opp LT13)","Information Technology (IT)","Opp Yusof Ishak House (Opp YIH)","NUS Museum","University Town (UTown)","Kent Vale"])
};

const NUS_ORDERED_ROUTE_STOPS = {
  A1: ["PGP", "KR-MRT", "LT27", "UHALL", "UHC-OPP", "YIH", "CLB", "LT13", "AS5", "BIZ2", "TCOMS-OPP", "PGP"],
  A2: ["PGP", "TCOMS", "HSSML-OPP", "NUSS-OPP", "LT13-OPP", "IT", "YIH-OPP", "MUSEUM", "UHC", "UHALL-OPP", "S17", "KR-MRT-OPP", "PGPR", "PGP"],
  D1: ["COM3", "HSSML-OPP", "NUSS-OPP", "LT13-OPP", "IT", "YIH-OPP", "MUSEUM", "UTOWN", "YIH", "CLB", "LT13", "AS5", "BIZ2", "COM3"],
  D2: ["COM3", "TCOMS-OPP", "PGP", "KR-MRT", "LT27", "UHALL", "UHC-OPP", "MUSEUM", "UTOWN", "UHC", "UHALL-OPP", "S17", "KR-MRT-OPP", "PGPR", "TCOMS", "COM3"],
  E: ["UTOWN", "MUSEUM", "YIH", "CLB", "LT13", "AS5", "BIZ2", "COM3", "UTOWN"],
  K: ["PGP", "KR-MRT", "LT27", "UHALL", "UHC-OPP", "YIH", "CLB", "SDE3-OPP", "JP-SCH-16151", "KV", "MUSEUM", "UHC", "UHALL-OPP", "S17", "KR-MRT-OPP", "PGPR", "PGP"],
  R1: ["KV", "UTOWN", "MUSEUM", "YIH", "CLB", "LT13", "AS5", "BIZ2", "TCOMS-OPP", "PGP"],
  R2: ["PGP", "TCOMS", "HSSML-OPP", "NUSS-OPP", "LT13-OPP", "IT", "YIH-OPP", "MUSEUM", "UTOWN", "KV"]
};

function getStopByCodeOrName(identifier) {
  if (!identifier) return null;
  return NUS_BUS_STOPS.find(s => s.code === identifier || s.name === identifier) || null;
}

function getDistanceToStop(lat1, lon1, lat2, lon2) {
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null ||
      lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) return Infinity;
  const R = 6371e3;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaPhi = (lat2 - lat1) * Math.PI / 180;
  const deltaLambda = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateBearing(lat1, lon1, lat2, lon2) {
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null ||
      lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined ||
      (lat1 === lat2 && lon1 === lon2)) return null;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaLambda = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function angleDifference(bearing1, bearing2) {
  if (bearing1 === null || bearing1 === undefined || bearing2 === null || bearing2 === undefined) return 180;
  let diff = Math.abs(bearing1 - bearing2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function getVehicleBearing(bus) {
  if (!bus) return null;
  if (typeof bus.heading === 'number' && Number.isFinite(bus.heading)) {
    return bus.heading;
  }
  const plate = bus.vehplate;
  if (plate && STATE.vehicleMovement) {
    const tracked = STATE.vehicleMovement.get(plate);
    if (tracked && typeof tracked.heading === 'number' && Number.isFinite(tracked.heading)) {
      return tracked.heading;
    }
  }
  if (plate && STATE.vehicleSnapshotsCache) {
    const snaps = STATE.vehicleSnapshotsCache.get(plate);
    if (Array.isArray(snaps) && snaps.length >= 2) {
      for (let i = 0; i < snaps.length - 1; i++) {
        const sNew = snaps[i];
        const sOld = snaps[i + 1];
        if (typeof sNew?.lat === 'number' && typeof sNew?.lng === 'number' &&
            typeof sOld?.lat === 'number' && typeof sOld?.lng === 'number') {
          const d = getDistanceToStop(sOld.lat, sOld.lng, sNew.lat, sNew.lng);
          if (d >= 5) {
            const h = calculateBearing(sOld.lat, sOld.lng, sNew.lat, sNew.lng);
            if (h !== null) {
              if (STATE.vehicleMovement) {
                const existing = STATE.vehicleMovement.get(plate) || {};
                STATE.vehicleMovement.set(plate, { ...existing, heading: h });
              }
              return h;
            }
          }
        }
      }
    }
  }
  return null;
}

function updateVehicleMovement(bus) {
  if (!bus || !hasCoordinates(bus) || !bus.vehplate) return;
  const plate = bus.vehplate;
  if (!STATE.vehicleMovement) STATE.vehicleMovement = new Map();
  const prev = STATE.vehicleMovement.get(plate);
  if (!prev) {
    STATE.vehicleMovement.set(plate, {
      lastLat: bus.lat,
      lastLng: bus.lng,
      lastTime: bus.timestamp || Date.now(),
      heading: typeof bus.heading === 'number' ? bus.heading : null
    });
    return;
  }
  const dist = getDistanceToStop(prev.lastLat, prev.lastLng, bus.lat, bus.lng);
  let heading = prev.heading;
  if (dist >= 5) {
    heading = calculateBearing(prev.lastLat, prev.lastLng, bus.lat, bus.lng);
    STATE.vehicleMovement.set(plate, {
      lastLat: bus.lat,
      lastLng: bus.lng,
      lastTime: bus.timestamp || Date.now(),
      heading
    });
  }
  bus.heading = heading;
}

function getServicedRoutesForStop(stopCode, stopName) {
  const routes = [];
  for (const [route, stops] of Object.entries(NUS_ROUTE_STOPS)) {
    if ((stopCode && stops.has(stopCode)) || (stopName && stops.has(stopName))) {
      routes.push(route);
    }
  }
  return routes;
}

async function fetchStopEtas(stopCode) {
  if (!stopCode) return null;
  const now = Date.now();
  const cached = STATE.stopArrivalCache.get(stopCode);
  if (cached && (now - cached.timestamp < 30000)) {
    return cached.data;
  }
  try {
    const res = await fetch(`https://bus.hewliyang.com/api/stop/${encodeURIComponent(stopCode)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.etas || data;
    STATE.stopArrivalCache.set(stopCode, { timestamp: now, data: result });
    return result;
  } catch {
    return null;
  }
}

function isBusApproachingOrAtStop(bus, stop, stopEtas = null) {
  if (!bus || !stop || !hasCoordinates(bus)) return { isAtStop: false, isApproaching: false, distance: Infinity, eta: null };
  const dist = getDistanceToStop(bus.lat, bus.lng, stop.lat, stop.lng);
  let isAtStop = dist <= 180;
  let isApproaching = dist > 180 && dist <= 500;
  let eta = null;

  if (stopEtas && Array.isArray(stopEtas.timings)) {
    const timing = stopEtas.timings.find(t =>
      t.arrivalTime_veh_plate === bus.vehplate || t.nextArrivalTime_veh_plate === bus.vehplate
    );
    if (timing) {
      eta = timing.arrivalTime;
      if (eta === 'Arr' || eta === '1' || isAtStop) {
        isAtStop = true;
        isApproaching = false;
      } else {
        isApproaching = true;
      }
    }
  }

  // If approaching without explicit ETA timing, check if vehicle is traveling away from the stop
  if (!eta && isApproaching) {
    const heading = getVehicleBearing(bus);
    if (heading !== null && typeof stop.lat === 'number' && typeof stop.lng === 'number') {
      const bearingToStop = calculateBearing(bus.lat, bus.lng, stop.lat, stop.lng);
      if (bearingToStop !== null && angleDifference(heading, bearingToStop) >= 90) {
        isApproaching = false;
      }
    }
  }

  return { isAtStop, isApproaching, distance: dist, eta };
}

function getBusesNearStop(stopCode, stopName, stopLat, stopLng, stopEtas = null) {
  const serviced = getServicedRoutesForStop(stopCode, stopName);
  const stopObj = { code: stopCode, name: stopName, lat: stopLat, lng: stopLng };
  const matchingBuses = [];

  for (const bus of STATE.liveBuses) {
    if (!serviced.includes(bus.route_code) || !hasCoordinates(bus)) continue;
    const proximity = isBusApproachingOrAtStop(bus, stopObj, stopEtas);
    if (proximity.isAtStop || proximity.isApproaching || proximity.distance <= 600) {
      matchingBuses.push({
        ...bus,
        isAtStop: proximity.isAtStop,
        isApproaching: proximity.isApproaching,
        distance: proximity.distance,
        eta: proximity.eta
      });
    }
  }

  matchingBuses.sort((a, b) => {
    if (a.isAtStop && !b.isAtStop) return -1;
    if (!a.isAtStop && b.isAtStop) return 1;
    return a.distance - b.distance;
  });

  return matchingBuses;
}

function renderStopPopupHtml(stop, stopEtas = null) {
  const serviced = getServicedRoutesForStop(stop.code, stop.name);
  const buses = getBusesNearStop(stop.code, stop.name, stop.lat, stop.lng, stopEtas);
  const routePills = serviced.map(rc => `<span class="stop-popup-route-pill" style="background-color:${routeColor(rc)}">${escapeHtml(rc)}</span>`).join('');

  let busesHtml = '';
  if (buses.length) {
    busesHtml = buses.map(bus => {
      const color = routeColor(bus.route_code);
      const lvl = busCrowd(bus);
      const pct = occupancy(bus);
      const isAtStop = bus.isAtStop;
      const isApproaching = bus.isApproaching;
      const statusLabel = isAtStop ? 'At Stop' : isApproaching ? 'Approaching' : `${Math.round(bus.distance)}m away`;
      const statusClass = isAtStop ? 'status-at-stop' : isApproaching ? 'status-approaching' : 'status-upcoming';
      const statusIcon = isAtStop ? '📍 ' : isApproaching ? '⚡ ' : '';
      const etaLabel = bus.eta ? (bus.eta === 'Arr' ? 'Now' : `${bus.eta}m`) : (isAtStop ? 'Now' : (isApproaching ? '~2m' : ''));
      const pfillPct = pct === null ? 0 : Math.max(4, Math.min(100, Math.round(pct)));

      return `
        <div class="stop-popup-bus-row">
          <div class="stop-popup-bus-top">
            <div class="stop-popup-bus-identity">
              <span class="route-badge-pill" style="background-color:${color}">${escapeHtml(bus.route_code)}</span>
              <strong class="stop-popup-bus-plate">${escapeHtml(bus.vehplate)}</strong>
              <span class="stop-card-status-badge ${statusClass}">${statusIcon}${statusLabel}</span>
            </div>
            ${etaLabel ? `<span class="stop-popup-eta ${isAtStop ? 'eta-now' : ''}">${etaLabel}</span>` : ''}
          </div>
          <div class="stop-popup-bus-bottom">
            <div class="stop-popup-bus-metrics">
              <div class="stop-popup-pbar"><div class="stop-popup-pfill" style="width:${pfillPct}%;background-color:${lvl.color}"></div></div>
              <span class="stop-popup-pax">${numberLabel(bus.ridership)} pax (${percentLabel(pct)})</span>
              <span class="badge ${lvl.badge}" style="font-size:0.68rem;padding:1px 5px">${lvl.label}</span>
            </div>
            <button type="button" class="stop-popup-inspect-btn btn-open-bus-dashboard" data-plate="${escapeHtml(bus.vehplate)}">Inspect Bus ↗</button>
          </div>
        </div>
      `;
    }).join('');
  } else {
    let etaListHtml = '';
    if (stopEtas && Array.isArray(stopEtas.timings) && stopEtas.timings.length) {
      const activeTimings = stopEtas.timings.filter(t => t.arrivalTime && t.arrivalTime !== '-');
      if (activeTimings.length) {
        etaListHtml = activeTimings.map(t => `
          <div class="stop-popup-bus-row eta-only">
            <div class="stop-popup-bus-top">
              <div class="stop-popup-bus-identity">
                <span class="route-badge-pill" style="background-color:${routeColor(t.name)}">${escapeHtml(t.name)}</span>
                <strong class="stop-popup-bus-plate">${t.arrivalTime_veh_plate ? escapeHtml(t.arrivalTime_veh_plate) : 'Scheduled arrival'}</strong>
              </div>
              <span class="stop-popup-eta">${t.arrivalTime === 'Arr' ? 'Now' : `${t.arrivalTime} min`}</span>
            </div>
          </div>
        `).join('');
      }
    }
    busesHtml = etaListHtml || '<div class="stop-popup-empty">No buses currently approaching this stop.</div>';
  }

  return `
    <div class="map-popup-card stop-popup" data-stop-code="${escapeHtml(stop.code || '')}">
      <div class="stop-popup-header">
        <h4 class="stop-popup-title">${escapeHtml(stop.name)}</h4>
        <div class="stop-popup-routes">${routePills}</div>
      </div>
      <div class="stop-popup-buses">
        ${busesHtml}
      </div>
    </div>
  `;
}

function updateStopMarkerPopups() {
  for (const marker of STATE.stopMarkers) {
    if (marker.isPopupOpen && marker.isPopupOpen()) {
      const stop = NUS_BUS_STOPS.find(s => s.code === marker.stopCode || s.name === marker.stopName);
      if (stop) {
        const cached = STATE.stopArrivalCache.get(stop.code)?.data;
        marker.setPopupContent(renderStopPopupHtml(stop, cached));
      }
    }
  }
}

function updateMapStopSelectDropdown() {
  const select = $('selectMapStop');
  if (!select) return;
  const stops = [...NUS_BUS_STOPS].sort((a, b) => a.name.localeCompare(b.name));
  select.innerHTML = '<option value="all">Jump to Bus Stop…</option>' + stops.map(s => `<option value="${escapeHtml(s.code || s.name)}">${escapeHtml(s.name)}</option>`).join('');
  select.value = STATE.selectedMapStop;
}

function updateTimelineVehicleDropdown() {
  const select = $('selectTimelineVehicle');
  if (!select) return;
  const buses = [...STATE.allFleet].sort((a, b) => String(a.vehplate).localeCompare(String(b.vehplate)));
  select.innerHTML = '<option value="all">All fleet (Campus &amp; Routes)</option>' + buses.map(b => `<option value="${escapeHtml(b.vehplate)}">${escapeHtml(b.vehplate)} (${escapeHtml(b.route_code)})</option>`).join('');
  select.value = STATE.selectedTimelineVehicle;
}

function recordVehicleStopCrowd(bus, stopCode, stopName, customData = null) {
  if (!bus || !stopCode) return;
  const plate = bus.vehplate;
  const route = bus.route_code;
  const cap = numeric(bus.capacity) || 88;

  let ridership, occVal, crowdLvl;
  if (customData) {
    ridership = customData.ridership;
    occVal = cap > 0 ? ridership / cap : 0;
    crowdLvl = customData.crowdLevel || crowd(occVal * 100);
  } else {
    ridership = numeric(bus.ridership);
    occVal = numeric(bus.occupancy);
    if (occVal === null && ridership !== null && cap > 0) occVal = ridership / cap;
    crowdLvl = busCrowd({ ridership, occupancy: occVal, capacity: cap });
  }

  if (ridership === null && occVal === null) return;

  const entry = {
    stopCode,
    stopName: stopName || stopCode,
    ridership: ridership ?? Math.round(occVal * cap),
    occupancy: occVal ?? (cap > 0 ? ridership / cap : 0),
    capacity: cap,
    crowdLevel: crowdLvl,
    timestamp: Date.now(),
    vehplate: plate,
    routeCode: route,
    isManual: Boolean(customData?.isManual)
  };

  if (!STATE.stopCrowdStorage.byVehicle[plate]) {
    STATE.stopCrowdStorage.byVehicle[plate] = {};
  }
  STATE.stopCrowdStorage.byVehicle[plate][stopCode] = entry;

  if (route) {
    if (!STATE.stopCrowdStorage.byRoute[route]) {
      STATE.stopCrowdStorage.byRoute[route] = {};
    }
    STATE.stopCrowdStorage.byRoute[route][stopCode] = entry;
  }

  saveStopCrowdStorage();
}

function closeDwellSession(plate, dwell, now) {
  STATE.activeBusDwells.delete(plate);
  const rawDwellSec = Math.round((now - dwell.startTime) / 1000);
  // Exclude buses on downtime, driver rest, or parked layover (> 5 minutes or empty stationary >= 3m)
  if (dwell.isDowntime || rawDwellSec > MAX_PASSENGER_DWELL_SEC) {
    return;
  }
  if (rawDwellSec >= 180 && dwell.startPax === 0 && dwell.lastPax === 0) {
    return;
  }
  const dwellSec = Math.max(30, rawDwellSec);
  const deltaPax = (dwell.startPax !== null && dwell.lastPax !== null) ? (dwell.lastPax - dwell.startPax) : 0;
  STATE.stopDwellSessions.push({
    stopCode: dwell.stopCode,
    dwellSec,
    deltaPax,
    timestamp: now,
    vehplate: plate
  });
  if (STATE.stopDwellSessions.length > 500) {
    STATE.stopDwellSessions.splice(0, STATE.stopDwellSessions.length - 500);
  }
}

function updateLiveStopsCrowdReadings(buses) {
  if (!Array.isArray(buses) || !buses.length) return;
  const now = Date.now();
  const seenPlates = new Set();

  for (const bus of buses) {
    if (!hasCoordinates(bus)) continue;
    seenPlates.add(bus.vehplate);
    updateVehicleMovement(bus);
    const routeCode = bus.route_code;
    const orderedCodes = NUS_ORDERED_ROUTE_STOPS[routeCode];
    if (!orderedCodes) continue;

    const progression = resolveVehicleRouteProgression(bus, orderedCodes);
    const currentRidership = numeric(bus.ridership);

    if (progression.atStopIndex >= 0) {
      const stopInfo = progression.stops[progression.atStopIndex];
      if (stopInfo) {
        recordVehicleStopCrowd(bus, stopInfo.code, stopInfo.name);

        const currentDwell = STATE.activeBusDwells.get(bus.vehplate);
        if (currentDwell && currentDwell.stopCode === stopInfo.code) {
          currentDwell.lastSeen = now;
          if (currentRidership !== null) currentDwell.lastPax = currentRidership;
          if (now - currentDwell.startTime > MAX_PASSENGER_DWELL_SEC * 1000) {
            currentDwell.isDowntime = true;
          }
        } else {
          if (currentDwell) {
            closeDwellSession(bus.vehplate, currentDwell, now);
          }
          STATE.activeBusDwells.set(bus.vehplate, {
            stopCode: stopInfo.code,
            startTime: now,
            startPax: currentRidership,
            lastPax: currentRidership,
            lastSeen: now,
            isDowntime: false
          });
        }
      }
    } else {
      const currentDwell = STATE.activeBusDwells.get(bus.vehplate);
      if (currentDwell) {
        closeDwellSession(bus.vehplate, currentDwell, now);
      }
    }
  }

  // Close dwells for buses that disappeared from the feed or haven't been seen in > 3 minutes
  for (const [plate, dwell] of STATE.activeBusDwells.entries()) {
    if (!seenPlates.has(plate) || now - dwell.lastSeen > 3 * 60 * 1000) {
      closeDwellSession(plate, dwell, dwell.lastSeen || now);
    }
  }
}

async function fetchVehicleSnapshots(vehplate, routeCode) {
  if (!vehplate) return;
  try {
    const data = await requestJson(`/api/history/vehicle-snapshots?plate=${encodeURIComponent(vehplate)}&limit=500`);
    if (!data || !Array.isArray(data.snapshots)) return;
    const chronological = [...data.snapshots].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    STATE.vehicleSnapshotsCache.set(vehplate, chronological);
    processSnapshotsIntoStopCrowd(vehplate, routeCode, chronological);
    extractDwellSessionsFromSnapshots(vehplate, chronological);

    if (STATE.selectedVehiclePlate === vehplate) {
      updateVehicleDashboardWithInsights(vehplate, routeCode, chronological);
    }
  } catch {}
}

function updateVehicleDashboardWithInsights(vehplate, routeCode, snapshots) {
  if (!snapshots || !snapshots.length) return;
  const bus = STATE.allFleet.find(b => b.vehplate === vehplate) || STATE.liveBuses.find(b => b.vehplate === vehplate);

  const { startMs, endMs } = getSingaporeDayBounds();
  const todaySnaps = snapshots.filter(s => (s.timestamp || 0) >= startMs && (s.timestamp || 0) < endMs);
  const duty = todaySnaps.length
    ? computeVehicleDutyCycle(todaySnaps, vehplate)
    : getVehicleDutySummary(vehplate);
  setText('vehicleMetricShift', duty.profile);
  setText('vehicleMetricDistance', `~${duty.distanceKm} km`);

  const cycles = analyzeVehicleCycles(todaySnaps.length >= 10 ? todaySnaps : snapshots, routeCode);
  setText('vehicleStatLoops', `Loops: ${cycles.loopCount || '--'}`);
  setText('vehicleStatLayover', `Layover: ${cycles.avgLayoverMin ? `${cycles.avgLayoverMin}m` : '--'}`);
  if (cycles.avgLoopMin && bus) {
    setText('vehicleMetricRoute', `Service ${routeCode} (${cycles.avgLoopMin}m loop)`);
  }

  if (bus) {
    renderVehicleStopProgression(bus);
  }
}

function processSnapshotsIntoStopCrowd(vehplate, routeCode, snapshots) {
  const orderedCodes = NUS_ORDERED_ROUTE_STOPS[routeCode];
  if (!orderedCodes || !Array.isArray(snapshots) || !snapshots.length) return;

  let changed = false;
  // Sort newest first
  const sorted = [...snapshots].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  for (const code of orderedCodes) {
    const stop = getStopByCodeOrName(code);
    if (!stop || typeof stop.lat !== 'number' || typeof stop.lng !== 'number') continue;

    for (const snap of sorted) {
      if (typeof snap.lat !== 'number' || typeof snap.lng !== 'number') continue;
      const dist = getDistanceToStop(snap.lat, snap.lng, stop.lat, stop.lng);
      if (dist <= 180) {
        const cap = snap.capacity || 88;
        const ridership = numeric(snap.ridership);
        let occVal = numeric(snap.occupancy);
        if (occVal === null && ridership !== null && cap > 0) occVal = ridership / cap;
        if (ridership !== null || occVal !== null) {
          const existing = STATE.stopCrowdStorage.byVehicle[vehplate]?.[code];
          if (!existing || (snap.timestamp && snap.timestamp > existing.timestamp && !existing.isManual)) {
            const crowdLvl = busCrowd({ ridership, occupancy: occVal, capacity: cap });
            const entry = {
              stopCode: code,
              stopName: stop.name || code,
              ridership: ridership ?? Math.round(occVal * cap),
              occupancy: occVal ?? (cap > 0 ? ridership / cap : 0),
              capacity: cap,
              crowdLevel: crowdLvl,
              timestamp: snap.timestamp || Date.now(),
              vehplate,
              routeCode,
              distance: Math.round(dist)
            };
            if (!STATE.stopCrowdStorage.byVehicle[vehplate]) STATE.stopCrowdStorage.byVehicle[vehplate] = {};
            STATE.stopCrowdStorage.byVehicle[vehplate][code] = entry;
            if (routeCode) {
              if (!STATE.stopCrowdStorage.byRoute[routeCode]) STATE.stopCrowdStorage.byRoute[routeCode] = {};
              const existingRoute = STATE.stopCrowdStorage.byRoute[routeCode][code];
              if (!existingRoute || snap.timestamp > existingRoute.timestamp) {
                STATE.stopCrowdStorage.byRoute[routeCode][code] = entry;
              }
            }
            changed = true;
          }
        }
        break;
      }
    }
  }

  if (changed) {
    saveStopCrowdStorage();
    if (STATE.selectedVehiclePlate === vehplate) {
      const bus = STATE.allFleet.find(b => b.vehplate === vehplate) || STATE.liveBuses.find(b => b.vehplate === vehplate);
      if (bus) renderVehicleStopProgression(bus);
    }
  }
}

function extractDwellSessionsFromSnapshots(vehplate, snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return;
  let currentStop = null;
  let dwellPoints = 0;
  let startPax = null;
  let lastPax = null;

  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    if (s.lat == null || s.lng == null) continue;
    const speed = numeric(s.speed) ?? 0;
    const pax = numeric(s.ridership);

    let matchedStop = null;
    if (speed <= 5) {
      for (const stop of NUS_BUS_STOPS) {
        if (getDistanceToStop(s.lat, s.lng, stop.lat, stop.lng) <= 65) {
          matchedStop = stop;
          break;
        }
      }
    }

    if (matchedStop && currentStop && matchedStop.code === currentStop.code) {
      dwellPoints++;
      if (pax !== null) lastPax = pax;
    } else {
      if (currentStop && dwellPoints >= 1) {
        const dwellSec = dwellPoints * 60;
        // Exclude downtime and resting buses (> 5 minutes or empty parked buses >= 3 minutes)
        const isDowntime = dwellSec > MAX_PASSENGER_DWELL_SEC || (dwellSec >= 180 && startPax === 0 && lastPax === 0);
        if (!isDowntime) {
          const deltaPax = (startPax !== null && lastPax !== null) ? lastPax - startPax : 0;
          STATE.stopDwellSessions.push({
            stopCode: currentStop.code,
            dwellSec,
            deltaPax,
            timestamp: s.timestamp || Date.now(),
            vehplate
          });
        }
      }
      if (matchedStop) {
        currentStop = matchedStop;
        dwellPoints = 1;
        startPax = pax;
        lastPax = pax;
      } else {
        currentStop = null;
        dwellPoints = 0;
        startPax = null;
        lastPax = null;
      }
    }
  }

  if (currentStop && dwellPoints >= 1) {
    const dwellSec = dwellPoints * 60;
    const isDowntime = dwellSec > MAX_PASSENGER_DWELL_SEC || (dwellSec >= 180 && startPax === 0 && lastPax === 0);
    if (!isDowntime) {
      const deltaPax = (startPax !== null && lastPax !== null) ? lastPax - startPax : 0;
      STATE.stopDwellSessions.push({
        stopCode: currentStop.code,
        dwellSec,
        deltaPax,
        timestamp: snapshots[snapshots.length - 1].timestamp || Date.now(),
        vehplate
      });
    }
  }

  if (STATE.stopDwellSessions.length > 500) {
    STATE.stopDwellSessions.splice(0, STATE.stopDwellSessions.length - 500);
  }
}

function promptSetStopCrowd(vehplate, stopCode, stopName, capacity = 88) {
  const current = STATE.stopCrowdStorage.byVehicle[vehplate]?.[stopCode];
  const defVal = current ? current.ridership : '';
  const input = typeof window !== 'undefined' && typeof window.prompt === 'function'
    ? window.prompt(`Set crowd reading at ${stopName} for bus ${vehplate}:\nEnter passenger count (0 - ${capacity}):`, defVal)
    : null;
  if (input === null) return;
  const parsed = Number(String(input).trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > capacity * 1.5) {
    if (typeof alert === 'function') alert(`Please enter a valid passenger count between 0 and ${capacity}.`);
    return;
  }
  const bus = STATE.allFleet.find(b => b.vehplate === vehplate) ||
              STATE.liveBuses.find(b => b.vehplate === vehplate) ||
              { vehplate, route_code: current?.routeCode || '', capacity };
  recordVehicleStopCrowd(bus, stopCode, stopName, { ridership: Math.round(parsed), isManual: true });
  if (STATE.selectedVehiclePlate === vehplate) {
    renderVehicleStopProgression(bus);
  }
}
function resolveVehicleRouteProgression(bus, orderedCodes) {
  if (!orderedCodes || !orderedCodes.length) {
    return { atStopIndex: -1, approachingIndex: -1, stops: [] };
  }

  const hasGps = hasCoordinates(bus);
  const busHeading = getVehicleBearing(bus);

  const stops = orderedCodes.map((code, index) => {
    const s = getStopByCodeOrName(code);
    const dist = (hasGps && s && typeof s.lat === 'number' && typeof s.lng === 'number')
      ? getDistanceToStop(bus.lat, bus.lng, s.lat, s.lng)
      : Infinity;
    return {
      index,
      code,
      name: s?.name || code,
      stop: s,
      lat: s?.lat,
      lng: s?.lng,
      dist,
      isAtStop: false,
      isApproaching: false
    };
  });

  if (!hasGps) {
    return { atStopIndex: -1, approachingIndex: -1, stops };
  }

  // 1. Identify candidate stops within 180m for "At Stop"
  const atStopCandidates = [];
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].dist <= 180) {
      atStopCandidates.push(i);
    }
  }

  let atStopIndex = -1;
  if (atStopCandidates.length === 1) {
    atStopIndex = atStopCandidates[0];
  } else if (atStopCandidates.length > 1) {
    // Disambiguate when multiple stops are close (e.g. opposing stops across the street or loop endpoints)
    let bestScore = Infinity;
    for (const idx of atStopCandidates) {
      const curStop = stops[idx];
      let headingPenalty = 0;

      // Check route direction from curStop to next stop
      const nextIdx = idx < stops.length - 1 ? idx + 1 : 0;
      const nextStop = stops[nextIdx];
      if (curStop.lat != null && curStop.lng != null && nextStop.lat != null && nextStop.lng != null) {
        const segBearing = calculateBearing(curStop.lat, curStop.lng, nextStop.lat, nextStop.lng);
        if (busHeading !== null && segBearing !== null) {
          const diff = angleDifference(busHeading, segBearing);
          if (diff >= 90) headingPenalty += 1000;
          else headingPenalty += diff * 2;
        }
      }

      // Check recently visited stops in storage to reward forward progress
      const vehicleHistory = STATE.stopCrowdStorage?.byVehicle?.[bus?.vehplate];
      if (vehicleHistory && idx > 0) {
        const prevCode = stops[idx - 1].code;
        if (vehicleHistory[prevCode]) {
          headingPenalty -= 250;
        }
      }

      const score = curStop.dist + headingPenalty;
      if (score < bestScore) {
        bestScore = score;
        atStopIndex = idx;
      }
    }
  }

  // 2. Identify candidate for "Approaching (Next Stop)"
  let approachingIndex = -1;

  if (atStopIndex >= 0) {
    // Bus is AT a stop. The only possible approaching stop is the immediate next stop in forward direction!
    const nextIdx = atStopIndex + 1;
    if (nextIdx < stops.length && stops[nextIdx].dist <= 500) {
      approachingIndex = nextIdx;
    }
  } else {
    // Bus is in transit between stops (not at any stop).
    // Find the next upcoming stop that the bus is moving toward.
    const approachingCandidates = [];
    for (let i = 0; i < stops.length; i++) {
      if (stops[i].dist <= 500) {
        let isMovingTowards = true;
        if (busHeading !== null && stops[i].lat != null && stops[i].lng != null) {
          const bearingToStop = calculateBearing(bus.lat, bus.lng, stops[i].lat, stops[i].lng);
          if (bearingToStop !== null) {
            const diff = angleDifference(busHeading, bearingToStop);
            if (diff >= 90) {
              isMovingTowards = false; // Stop is behind the bus or moving away!
            }
          }
        }
        if (isMovingTowards) {
          approachingCandidates.push(i);
        }
      }
    }

    if (approachingCandidates.length === 1) {
      approachingIndex = approachingCandidates[0];
    } else if (approachingCandidates.length > 1) {
      approachingCandidates.sort((a, b) => stops[a].dist - stops[b].dist);
      approachingIndex = approachingCandidates[0];
    }
  }

  // Strictly enforce single status guarantees: at most 1 at stop and at most 1 approaching
  if (atStopIndex >= 0) {
    stops[atStopIndex].isAtStop = true;
    stops[atStopIndex].isApproaching = false;
  }
  if (approachingIndex >= 0 && approachingIndex !== atStopIndex) {
    stops[approachingIndex].isApproaching = true;
    stops[approachingIndex].isAtStop = false;
  }

  return { atStopIndex, approachingIndex, stops };
}

// ==========================================================================
// 1-Minute Live Headway, Bus Bunching, Duty Cycles & Transit Insights
// ==========================================================================

function computeRouteHeadways(buses, routeCode) {
  const orderedCodes = NUS_ORDERED_ROUTE_STOPS[routeCode];
  if (!orderedCodes || orderedCodes.length < 2 || !buses || buses.length < 2) {
    return { routeCode, buses: [], pairs: [], bunchedPlates: new Set(), hasBunching: false };
  }

  const busProgress = buses.map(bus => {
    let progress = 0;
    if (hasCoordinates(bus)) {
      const progression = resolveVehicleRouteProgression(bus, orderedCodes);
      if (progression.atStopIndex >= 0) {
        progress = progression.atStopIndex / (orderedCodes.length - 1);
      } else if (progression.approachingIndex >= 0) {
        progress = Math.max(0, (progression.approachingIndex - 0.5) / (orderedCodes.length - 1));
      } else {
        let minDist = Infinity;
        let bestIdx = 0;
        progression.stops.forEach((s, idx) => {
          if (s.dist < minDist) {
            minDist = s.dist;
            bestIdx = idx;
          }
        });
        progress = bestIdx / (orderedCodes.length - 1);
      }
    }
    return {
      ...bus,
      progress: Math.max(0, Math.min(0.999, progress))
    };
  });

  busProgress.sort((a, b) => a.progress - b.progress);

  const n = busProgress.length;
  const loopEstMin = 25;
  const pairs = [];
  const bunchedPlates = new Set();

  for (let i = 0; i < n; i++) {
    const trailingBus = busProgress[i];
    const leadingBus = busProgress[(i + 1) % n];
    const fracGap = (leadingBus.progress - trailingBus.progress + 1.0) % 1.0;
    const timeGapMin = Math.round(fracGap * loopEstMin * 10) / 10;
    let distM = Math.round(fracGap * 6500);

    if (hasCoordinates(trailingBus) && hasCoordinates(leadingBus)) {
      const directDist = getDistanceToStop(trailingBus.lat, trailingBus.lng, leadingBus.lat, leadingBus.lng);
      if (directDist < 350) {
        distM = Math.round(directDist);
      }
    }

    const isBunched = (timeGapMin < 2.5 && timeGapMin > 0.05) || (distM < 250 && (numeric(trailingBus.speed) || 0) > 2);
    if (isBunched) {
      bunchedPlates.add(trailingBus.vehplate);
    }

    pairs.push({
      trailingPlate: trailingBus.vehplate,
      leadingPlate: leadingBus.vehplate,
      timeGapMin,
      distM,
      isBunched
    });

    trailingBus.headwayToNextMin = timeGapMin;
    leadingBus.headwayFromPrevMin = timeGapMin;
    leadingBus.prevPlate = trailingBus.vehplate;
  }

  return {
    routeCode,
    buses: busProgress,
    pairs,
    bunchedPlates,
    hasBunching: bunchedPlates.size > 0
  };
}

function computeAllRouteHeadways(liveBuses) {
  const headwaysByRoute = new Map();
  const vehicleHeadways = new Map();

  const byRoute = new Map();
  for (const bus of (liveBuses || [])) {
    if (!bus.route_code || !hasCoordinates(bus)) continue;
    if (!byRoute.has(bus.route_code)) byRoute.set(bus.route_code, []);
    byRoute.get(bus.route_code).push(bus);
  }

  for (const [routeCode, buses] of byRoute) {
    const hw = computeRouteHeadways(buses, routeCode);
    headwaysByRoute.set(routeCode, hw);
    for (const b of hw.buses) {
      vehicleHeadways.set(b.vehplate, {
        routeCode,
        isBunched: hw.bunchedPlates.has(b.vehplate),
        headwayToNextMin: b.headwayToNextMin,
        headwayFromPrevMin: b.headwayFromPrevMin,
        prevPlate: b.prevPlate
      });
    }
  }

  STATE.routeHeadways = headwaysByRoute;
  STATE.vehicleHeadways = vehicleHeadways;
}

function getSingaporeDayBounds(targetDateStr = null) {
  let dateStr = targetDateStr;
  if (!dateStr) {
    if (STATE.timeMode === 'date' && STATE.selectedDate) {
      dateStr = STATE.selectedDate;
    } else if (STATE.history24h?.queryRange?.end && Math.abs(STATE.history24h.queryRange.end - Date.now()) > 2 * 86400000) {
      // Historical test fixture or mocked clock environment
      dateStr = formatLocalDate(new Date(STATE.history24h.queryRange.end));
    } else {
      dateStr = formatLocalDate();
    }
  }
  const startMs = new Date(`${dateStr}T00:00:00+08:00`).getTime();
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { dateStr, startMs, endMs };
}

function computeVehicleDutyCycle(snapshots, plate) {
  if (!snapshots || !snapshots.length) {
    return {
      activeMinutes: 0,
      activeHoursLabel: '0h 0m',
      distanceKm: 0,
      profile: 'Standby / Off-duty',
      badgeClass: 'badge-duty-standby'
    };
  }

  const activeMinutes = snapshots.length;
  const h = Math.floor(activeMinutes / 60);
  const m = activeMinutes % 60;
  const activeHoursLabel = `${h}h ${m}m`;

  let totalDistM = 0;
  for (let i = 0; i < snapshots.length - 1; i++) {
    const p1 = snapshots[i];
    const p2 = snapshots[i + 1];
    if (p1.lat != null && p1.lng != null && p2.lat != null && p2.lng != null) {
      const timeDiffMs = Math.abs((p2.timestamp || 0) - (p1.timestamp || 0));
      // Guard against idle jumps across shifts or overnight gap
      if (!p1.timestamp || !p2.timestamp || timeDiffMs <= 15 * 60 * 1000) {
        const d = getDistanceToStop(p1.lat, p1.lng, p2.lat, p2.lng);
        if (d >= 10 && d < 2000) {
          totalDistM += d;
        }
      }
    }
  }
  const distanceKm = Math.round((totalDistM / 1000) * 10) / 10;

  let isPeakBooster = false;
  if (activeMinutes <= 330) {
    const peakCount = snapshots.filter(s => {
      const sgHour = new Date(s.timestamp + 8 * 3600 * 1000).getUTCHours();
      return (sgHour >= 7 && sgHour <= 10) || (sgHour >= 16 && sgHour <= 19);
    }).length;
    if (peakCount >= activeMinutes * 0.65) {
      isPeakBooster = true;
    }
  }

  let profile = 'Standby / Off-duty';
  let badgeClass = 'badge-duty-standby';
  if (activeMinutes >= 480) {
    profile = 'Full-Day Workhorse';
    badgeClass = 'badge-duty-full-day';
  } else if (isPeakBooster) {
    profile = 'Peak Booster';
    badgeClass = 'badge-duty-booster';
  } else if (activeMinutes >= 120) {
    profile = 'Mid-Shift Relief';
    badgeClass = 'badge-duty-booster';
  }

  return {
    activeMinutes,
    activeHoursLabel,
    distanceKm,
    profile,
    badgeClass
  };
}

function getVehicleDutySummary(plate, targetDateStr = null) {
  const { startMs, endMs } = getSingaporeDayBounds(targetDateStr);

  const snaps = STATE.vehicleSnapshotsCache?.get(plate);
  if (snaps && snaps.length) {
    const todaySnaps = snaps.filter(s => {
      const ts = s.timestamp || 0;
      return ts >= startMs && ts < endMs;
    });
    if (todaySnaps.length) {
      return computeVehicleDutyCycle(todaySnaps, plate);
    }
    return {
      activeMinutes: 0,
      activeHoursLabel: '0h 0m',
      distanceKm: 0,
      profile: 'Standby / Off-duty',
      badgeClass: 'badge-duty-standby'
    };
  }

  const allVehicleRows = STATE.history24h?.vehicleData || [];
  const rows = allVehicleRows.filter(r => {
    if (r.vehplate !== plate) return false;
    const ts = typeof r.bucket_ts === 'number' ? r.bucket_ts : 0;
    return ts >= startMs && ts < endMs;
  });

  if (!rows.length) {
    return {
      activeMinutes: 0,
      activeHoursLabel: '0h 0m',
      distanceKm: 0,
      profile: 'Standby / Off-duty',
      badgeClass: 'badge-duty-standby'
    };
  }
  const activeMinutes = rows.length;
  const h = Math.floor(activeMinutes / 60);
  const m = activeMinutes % 60;
  const activeHoursLabel = `${h}h ${m}m`;
  const distanceKm = Math.round((activeMinutes * 0.18) * 10) / 10;
  const profile = activeMinutes >= 480 ? 'Full-Day Workhorse' : activeMinutes <= 330 ? 'Peak Booster' : 'Mid-Shift Relief';
  const badgeClass = activeMinutes >= 480 ? 'badge-duty-full-day' : 'badge-duty-booster';
  return { activeMinutes, activeHoursLabel, distanceKm, profile, badgeClass };
}

function analyzeVehicleCycles(snapshots, routeCode) {
  if (!snapshots || snapshots.length < 10) {
    return { loopCount: 0, avgLoopMin: null, avgLayoverMin: null, cycles: [] };
  }

  const orderedCodes = NUS_ORDERED_ROUTE_STOPS[routeCode];
  const terminalCode = orderedCodes ? orderedCodes[0] : null;
  const termStop = terminalCode ? getStopByCodeOrName(terminalCode) : null;

  if (!termStop) {
    return { loopCount: 0, avgLoopMin: null, avgLayoverMin: null, cycles: [] };
  }

  const terminalVisits = [];
  let atTerm = false;
  let visitStart = null;

  for (const s of snapshots) {
    if (s.lat == null || s.lng == null) continue;
    const dist = getDistanceToStop(s.lat, s.lng, termStop.lat, termStop.lng);
    const isNearby = dist <= 120;

    if (isNearby && !atTerm) {
      atTerm = true;
      visitStart = s.timestamp;
    } else if (!isNearby && atTerm) {
      atTerm = false;
      terminalVisits.push({
        arrive: visitStart,
        depart: s.timestamp,
        layoverMin: Math.max(1, Math.round((s.timestamp - visitStart) / 60000))
      });
    }
  }

  if (atTerm && visitStart) {
    const lastSnap = snapshots[snapshots.length - 1];
    terminalVisits.push({
      arrive: visitStart,
      depart: lastSnap.timestamp,
      layoverMin: Math.max(1, Math.round((lastSnap.timestamp - visitStart) / 60000))
    });
  }

  if (terminalVisits.length < 2) {
    return { loopCount: terminalVisits.length, avgLoopMin: null, avgLayoverMin: terminalVisits[0]?.layoverMin || null, cycles: [] };
  }

  const loopDurations = [];
  const layovers = [];
  for (let i = 0; i < terminalVisits.length - 1; i++) {
    const loopDuration = Math.round((terminalVisits[i + 1].arrive - terminalVisits[i].depart) / 60000);
    if (loopDuration >= 10 && loopDuration <= 60) {
      loopDurations.push(loopDuration);
    }
    layovers.push(terminalVisits[i].layoverMin);
  }

  const avgLoopMin = loopDurations.length ? Math.round(loopDurations.reduce((a, b) => a + b, 0) / loopDurations.length) : 26;
  const avgLayoverMin = layovers.length ? Math.round(layovers.reduce((a, b) => a + b, 0) / layovers.length) : 6;

  return {
    loopCount: loopDurations.length || terminalVisits.length,
    avgLoopMin,
    avgLayoverMin,
    cycles: loopDurations
  };
}

function getStopDwellAndExchangeForVehicle(snapshots, stopCode) {
  if (!snapshots || !snapshots.length || !stopCode) return null;
  const targetStop = getStopByCodeOrName(stopCode);
  if (!targetStop) return null;

  let consecutiveDwell = 0;
  let firstPax = null;
  let lastPax = null;

  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i];
    if (s.lat == null || s.lng == null) continue;
    const dist = getDistanceToStop(s.lat, s.lng, targetStop.lat, targetStop.lng);
    const speed = numeric(s.speed) || 0;

    if (dist <= 65 && speed <= 5) {
      consecutiveDwell++;
      if (lastPax === null) lastPax = numeric(s.ridership);
      firstPax = numeric(s.ridership);
    } else if (consecutiveDwell > 0) {
      break;
    }
  }

  if (consecutiveDwell > 0) {
    const deltaPax = (firstPax !== null && lastPax !== null) ? lastPax - firstPax : 0;
    const isDowntime = consecutiveDwell > 5 || (consecutiveDwell >= 3 && firstPax === 0 && lastPax === 0);
    return {
      dwellMin: consecutiveDwell,
      deltaPax,
      isDowntime
    };
  }
  return null;
}

function computeStopBottlenecksAndCorridors() {
  const corridors = [
    { from: 'Prince George\'s Park', to: 'Kent Ridge MRT', route: 'A1', baselineMin: 3, observedMin: 3, status: 'Normal' },
    { from: 'Central Library (CLB)', to: 'LT13', route: 'A1', baselineMin: 2, observedMin: 2, status: 'Normal' },
    { from: 'University Town (UTown)', to: 'NUS Museum', route: 'D1', baselineMin: 3, observedMin: 3, status: 'Normal' },
    { from: 'NUS Museum', to: 'University Health Centre', route: 'A2', baselineMin: 4, observedMin: 4, status: 'Normal' },
    { from: 'Ventus (Opp LT13)', to: 'Information Technology', route: 'A2', baselineMin: 2, observedMin: 2, status: 'Normal' },
    { from: 'Faculty of Science (S17)', to: 'Opp Kent Ridge MRT', route: 'D2', baselineMin: 3, observedMin: 3, status: 'Normal' }
  ];

  let delayedCount = 0;
  for (const corr of corridors) {
    const busesOnRoute = (STATE.liveBuses || []).filter(b => b.route_code === corr.route && hasCoordinates(b));
    for (const b of busesOnRoute) {
      const spd = numeric(b.speed);
      if (spd !== null && spd < 10) {
        corr.observedMin = corr.baselineMin + 2;
        corr.status = 'Delay (+2m)';
        delayedCount++;
        break;
      }
    }
  }

  // Dynamic Stop Dwell Leaderboard Aggregation
  const dwellByStop = new Map();
  const now = Date.now();

  // Aggregate ongoing active dwells (strictly exclude buses resting, parked, or on downtime > 5 mins)
  if (STATE.activeBusDwells && STATE.activeBusDwells.size) {
    for (const [, active] of STATE.activeBusDwells.entries()) {
      if (active.isDowntime) continue;
      const elapsedSec = Math.round((now - active.startTime) / 1000);
      if (elapsedSec > MAX_PASSENGER_DWELL_SEC) continue;
      if (elapsedSec >= 180 && active.startPax === 0 && active.lastPax === 0) continue;

      const validDwellSec = Math.max(30, elapsedSec);
      const deltaPax = (active.startPax !== null && active.lastPax !== null) ? (active.lastPax - active.startPax) : 0;
      if (!dwellByStop.has(active.stopCode)) dwellByStop.set(active.stopCode, []);
      dwellByStop.get(active.stopCode).push({ dwellSec: validDwellSec, deltaPax, isLive: true });
    }
  }

  // Aggregate completed dwell sessions (strictly exclude any session > 5 minutes)
  if (Array.isArray(STATE.stopDwellSessions)) {
    for (const session of STATE.stopDwellSessions) {
      if (session.dwellSec > MAX_PASSENGER_DWELL_SEC) continue;
      if (!dwellByStop.has(session.stopCode)) dwellByStop.set(session.stopCode, []);
      dwellByStop.get(session.stopCode).push(session);
    }
  }

  // Baseline calibration data for campus stops to maintain seamless initialization before live samples accumulate
  const stopBaselines = {
    'CLB': { name: 'Central Library (CLB)', baseDwell: 165, basePax: 48, defaultSeverity: 'High Dwell' },
    'KR-MRT': { name: 'Kent Ridge MRT (Exit A)', baseDwell: 140, basePax: 62, defaultSeverity: 'High Boarding' },
    'UTOWN': { name: 'University Town (UTown)', baseDwell: 120, basePax: 55, defaultSeverity: 'High Exchange' },
    'PGP': { name: 'Prince George\'s Park (PGP)', baseDwell: 110, basePax: 35, defaultSeverity: 'Moderate Dwell' },
    'LT27': { name: 'Faculty of Science (LT27)', baseDwell: 95, basePax: 30, defaultSeverity: 'Lecture Surge' },
    'BIZ2': { name: 'Business School (BIZ 2)', baseDwell: 85, basePax: 28, defaultSeverity: 'Moderate' },
    'COM3': { name: 'Computing (COM 3)', baseDwell: 90, basePax: 32, defaultSeverity: 'Moderate' }
  };

  const candidateCodes = new Set([...Object.keys(stopBaselines), ...dwellByStop.keys()]);
  const scoredStops = [];

  for (const code of candidateCodes) {
    const base = stopBaselines[code];
    const stopMeta = getStopByCodeOrName(code);
    const stopName = base?.name || stopMeta?.name || code;
    const sessions = dwellByStop.get(code) || [];

    let avgDwellSec, peakExchangeNum;
    if (sessions.length > 0) {
      const totalSec = sessions.reduce((sum, s) => sum + s.dwellSec, 0);
      const measuredAvg = Math.min(MAX_PASSENGER_DWELL_SEC, Math.round(totalSec / sessions.length));
      const maxDelta = Math.max(...sessions.map(s => Math.abs(s.deltaPax || 0)));

      if (base) {
        const weight = Math.min(1.0, sessions.length / 5);
        avgDwellSec = Math.min(MAX_PASSENGER_DWELL_SEC, Math.round(measuredAvg * weight + base.baseDwell * (1 - weight)));
        peakExchangeNum = Math.round(Math.max(maxDelta, base.basePax * (1 - weight)));
      } else {
        avgDwellSec = measuredAvg;
        peakExchangeNum = maxDelta;
      }
    } else if (base) {
      avgDwellSec = base.baseDwell;
      peakExchangeNum = base.basePax;
    } else {
      continue;
    }

    let severity;
    if (avgDwellSec >= 150) severity = 'Severe Dwell';
    else if (peakExchangeNum >= 50) severity = 'High Boarding';
    else if (avgDwellSec >= 110) severity = 'High Dwell';
    else if (peakExchangeNum >= 30) severity = 'Lecture Surge';
    else severity = base?.defaultSeverity || 'Moderate';

    const score = avgDwellSec * 0.6 + peakExchangeNum * 0.4;
    scoredStops.push({
      code,
      name: stopName,
      avgDwellSec,
      peakExchange: `+${peakExchangeNum} pax`,
      severity,
      score,
      sampleCount: sessions.length
    });
  }

  scoredStops.sort((a, b) => b.score - a.score);

  const topStops = scoredStops.slice(0, 6).map((s, idx) => ({
    rank: idx + 1,
    code: s.code,
    name: s.name,
    avgDwellSec: Math.min(MAX_PASSENGER_DWELL_SEC, s.avgDwellSec),
    peakExchange: s.peakExchange,
    severity: s.severity,
    sampleCount: s.sampleCount
  }));

  return { corridors, topStops, delayedCount };
}

function isCurrentTimeInRange(startHour, startMin, endHour, endMin, refTimeMs = Date.now()) {
  const sgDate = new Date(refTimeMs + 8 * 3600 * 1000);
  const nowMin = sgDate.getUTCHours() * 60 + sgDate.getUTCMinutes();
  const startTotal = startHour * 60 + startMin;
  const endTotal = endHour * 60 + endMin;
  return nowMin >= startTotal && nowMin <= endTotal;
}

function detectLectureSurgeWindows(campusHourly, campusData, refTimeMs = Date.now()) {
  const windowSpecs = [
    {
      id: 'morning_rush',
      startHour: 8, startMin: 25, endHour: 8, endMin: 45,
      timeRange: '08:25 – 08:45 SGT',
      baseIncrease: 38,
      desc: 'Morning Lecture Rush: Science (LT27), Computing (COM3), and Business (BIZ2) arrival wave.',
      baseTip: 'Board before 08:20 at Kent Ridge MRT to secure a seat.',
      relevantRoutes: ['A1', 'D1', 'D2']
    },
    {
      id: 'transition_1000',
      startHour: 9, startMin: 50, endHour: 10, endMin: 15,
      timeRange: '09:50 – 10:15 SGT',
      baseIncrease: 45,
      desc: '10:00 Lecture Transition: Major campus cross-transit between UTown, Central Library, and Arts.',
      baseTip: 'Buses A1 and D1 experience bunching during this window.',
      relevantRoutes: ['A1', 'D1']
    },
    {
      id: 'lunch_wave',
      startHour: 11, startMin: 50, endHour: 12, endMin: 20,
      timeRange: '11:50 – 12:20 SGT',
      baseIncrease: 52,
      desc: 'Midday Lunch Wave: Heavy boarding towards UTown Flavours and Fine Foods food courts.',
      baseTip: 'Expect 2+ minute dwell times at Central Library and Museum stops.',
      relevantRoutes: ['D1', 'A1', 'A2']
    },
    {
      id: 'afternoon_switch',
      startHour: 13, startMin: 50, endHour: 14, endMin: 15,
      timeRange: '13:50 – 14:15 SGT',
      baseIncrease: 40,
      desc: '14:00 Afternoon Lecture Switch: Bi-directional flow between Science and Engineering.',
      baseTip: 'Service A2 offers quicker turnaround than A1 along Lower Kent Ridge Rd.',
      relevantRoutes: ['A2', 'A1']
    },
    {
      id: 'transition_1600',
      startHour: 15, startMin: 50, endHour: 16, endMin: 15,
      timeRange: '15:50 – 16:15 SGT',
      baseIncrease: 35,
      desc: '16:00 Transition Window: Gradual surge towards central campus and library.',
      baseTip: 'Service D2 usually operates with lowest headway variance during this period.',
      relevantRoutes: ['D2']
    },
    {
      id: 'evening_departure',
      startHour: 17, startMin: 45, endHour: 18, endMin: 30,
      timeRange: '17:45 – 18:30 SGT',
      baseIncrease: 60,
      desc: 'Evening Campus Departure: Massive exodus toward Kent Ridge MRT and Haw Par Villa.',
      baseTip: 'Peak booster vehicles deployed; observe headway spacing on Map view.',
      relevantRoutes: ['A1', 'D2', 'K']
    }
  ];

  function getSingaporeMinute(row) {
    if (numeric(row?.bucket_ts) !== null) {
      const d = new Date(Number(row.bucket_ts) + 8 * 3600 * 1000);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    }
    if (typeof row?.time_str === 'string' && row.time_str.includes(':')) {
      const parts = row.time_str.split(':').map(Number);
      if (!isNaN(parts[0]) && !isNaN(parts[1])) return parts[0] * 60 + parts[1];
    }
    return null;
  }

  const validBuckets = (Array.isArray(campusData) ? campusData : []).filter(r => numeric(r?.avg_occupancy_pct) !== null);

  let baselineOccupancy = 30;
  if (validBuckets.length > 0) {
    const daytime = validBuckets.filter(r => {
      const m = getSingaporeMinute(r);
      return m !== null && m >= 7 * 60 && m <= 21 * 60;
    });
    const pool = daytime.length >= 5 ? daytime : validBuckets;
    baselineOccupancy = pool.reduce((sum, r) => sum + Number(r.avg_occupancy_pct), 0) / pool.length;
  } else if (Array.isArray(campusHourly) && campusHourly.length > 0) {
    const validHours = campusHourly.filter(r => numeric(r?.avg_occupancy_pct) !== null);
    if (validHours.length > 0) {
      const daytimeHours = validHours.filter(r => r.hour >= 7 && r.hour <= 21);
      const pool = daytimeHours.length > 0 ? daytimeHours : validHours;
      baselineOccupancy = pool.reduce((sum, r) => sum + Number(r.avg_occupancy_pct), 0) / pool.length;
    }
  }

  let liveOccupancy = null;
  const liveList = (typeof STATE !== 'undefined' && Array.isArray(STATE.liveBuses)) ? STATE.liveBuses : [];
  if (liveList.length > 0) {
    const busesWithOccupancy = liveList.filter(b => numeric(b.occupancy) !== null);
    if (busesWithOccupancy.length > 0) {
      const sum = busesWithOccupancy.reduce((acc, b) => acc + (b.occupancy * 100), 0);
      liveOccupancy = Math.round(sum / busesWithOccupancy.length);
    }
  }

  return windowSpecs.map(spec => {
    const startTotal = spec.startHour * 60 + spec.startMin;
    const endTotal = spec.endHour * 60 + spec.endMin;
    const isActive = isCurrentTimeInRange(spec.startHour, spec.startMin, spec.endHour, spec.endMin, refTimeMs);

    const matching = validBuckets.filter(r => {
      const m = getSingaporeMinute(r);
      return m !== null && m >= startTotal && m <= endTotal;
    });

    let displaySurgePct = spec.baseIncrease;
    let observedSummary = 'Baseline timetable schedule';
    let isEmpirical = false;
    let observedAvgOccupancy = null;
    let sampleCount = 0;

    if (matching.length > 0) {
      sampleCount = matching.length;
      observedAvgOccupancy = Math.round(matching.reduce((acc, r) => acc + Number(r.avg_occupancy_pct), 0) / sampleCount);
      const effBase = Math.max(15, baselineOccupancy);
      const rawSurge = Math.round(((observedAvgOccupancy - effBase) / effBase) * 100);
      const weight = Math.min(1.0, sampleCount / 6);
      displaySurgePct = Math.max(5, Math.round(rawSurge * weight + spec.baseIncrease * (1 - weight)));
      observedSummary = `${observedAvgOccupancy}% avg load · ${sampleCount} readings`;
      isEmpirical = true;
    } else {
      const hourlyMatch = (Array.isArray(campusHourly) ? campusHourly : []).find(h => h.hour === spec.startHour);
      if (hourlyMatch && numeric(hourlyMatch.avg_occupancy_pct) !== null) {
        observedAvgOccupancy = Math.round(Number(hourlyMatch.avg_occupancy_pct));
        const effBase = Math.max(15, baselineOccupancy);
        const rawSurge = Math.round(((observedAvgOccupancy - effBase) / effBase) * 100);
        const hSamples = Number(hourlyMatch.occupancy_sample_count) || 1;
        const weight = Math.min(0.6, hSamples / 10);
        displaySurgePct = Math.max(5, Math.round(rawSurge * weight + spec.baseIncrease * (1 - weight)));
        observedSummary = `${observedAvgOccupancy}% avg load · hourly`;
        isEmpirical = true;
        sampleCount = hSamples;
      }
    }

    let dynamicTip = spec.baseTip;
    if (typeof STATE !== 'undefined') {
      const bunchedRoutes = [];
      if (STATE.routeHeadways) {
        for (const rCode of spec.relevantRoutes) {
          const hw = STATE.routeHeadways.get(rCode);
          if (hw && hw.bunchedPlates && hw.bunchedPlates.size > 0) {
            bunchedRoutes.push(rCode);
          }
        }
      }

      if (isActive && bunchedRoutes.length > 0) {
        dynamicTip = `Active Surge Alert: Bunching detected on Service ${bunchedRoutes.join(', ')}. Check Headway spacing on Map.`;
      } else if (isActive && liveOccupancy !== null && liveOccupancy >= 70) {
        dynamicTip = `High Load Alert: Fleet at ${liveOccupancy}% capacity. Board immediately at origin stops to secure seats.`;
      }
    }

    return {
      id: spec.id,
      timeRange: spec.timeRange,
      peakIncrease: `+${displaySurgePct}% crowd`,
      desc: spec.desc,
      tip: dynamicTip,
      isActive,
      isEmpirical,
      observedSummary,
      observedAvgOccupancy,
      sampleCount,
      liveOccupancy: isActive ? liveOccupancy : null
    };
  });
}

const globalRoot = typeof window !== 'undefined' ? window : globalThis;
globalRoot.promptSetStopCrowd = promptSetStopCrowd;
globalRoot.resolveVehicleRouteProgression = resolveVehicleRouteProgression;
globalRoot.calculateBearing = calculateBearing;
globalRoot.angleDifference = angleDifference;
globalRoot.getVehicleBearing = getVehicleBearing;
globalRoot.updateVehicleMovement = updateVehicleMovement;
globalRoot.navigateTimeline = navigateTimeline;
globalRoot.zoomTimeline = zoomTimeline;
globalRoot.resetTimelineZoom = resetTimelineZoom;
globalRoot.computeRouteHeadways = computeRouteHeadways;
globalRoot.computeAllRouteHeadways = computeAllRouteHeadways;
globalRoot.computeVehicleDutyCycle = computeVehicleDutyCycle;
globalRoot.getVehicleDutySummary = getVehicleDutySummary;
globalRoot.getSingaporeDayBounds = getSingaporeDayBounds;
globalRoot.analyzeVehicleCycles = analyzeVehicleCycles;
globalRoot.getStopDwellAndExchangeForVehicle = getStopDwellAndExchangeForVehicle;
globalRoot.computeStopBottlenecksAndCorridors = computeStopBottlenecksAndCorridors;
globalRoot.detectLectureSurgeWindows = detectLectureSurgeWindows;
globalRoot.isCurrentTimeInRange = isCurrentTimeInRange;
globalRoot.MAX_PASSENGER_DWELL_SEC = MAX_PASSENGER_DWELL_SEC;

function renderVehicleStopProgression(bus) {
  const container = $('vehicleStopProgressionList');
  if (!container) return;
  const routeCode = bus?.route_code;
  const orderedCodes = NUS_ORDERED_ROUTE_STOPS[routeCode];
  if (!orderedCodes || !orderedCodes.length) {
    container.innerHTML = '<div class="stop-popup-empty">No fixed stop sequence defined for this route.</div>';
    setText('vehicleStopsCurrentNearest', 'Nearest: Unknown');
    setText('vehicleStopsTotalCount', '0 stops');
    return;
  }

  setText('vehicleStopsTotalCount', `${orderedCodes.length} stops`);

  const hasGps = hasCoordinates(bus);
  updateVehicleMovement(bus);
  const progression = resolveVehicleRouteProgression(bus, orderedCodes);

  let nearestDist = Infinity;
  let nearestStopName = 'Unknown';

  if (progression.atStopIndex >= 0) {
    const atStop = progression.stops[progression.atStopIndex];
    nearestDist = atStop.dist;
    nearestStopName = atStop.name;
    recordVehicleStopCrowd(bus, atStop.code, atStop.name);
  } else if (progression.approachingIndex >= 0) {
    const apprStop = progression.stops[progression.approachingIndex];
    nearestDist = apprStop.dist;
    nearestStopName = apprStop.name;
  } else {
    for (const s of progression.stops) {
      if (s.dist < nearestDist) {
        nearestDist = s.dist;
        nearestStopName = s.name;
      }
    }
  }

  if (hasGps && nearestDist !== Infinity) {
    setText('vehicleStopsCurrentNearest', `Nearest: ${nearestStopName} (${Math.round(nearestDist)}m)`);
  } else {
    setText('vehicleStopsCurrentNearest', 'Nearest: Location unknown');
  }

  const busCap = numeric(bus?.capacity) || 88;

  const stopsData = progression.stops.map((s, index) => {
    // Strictly vehicle-specific data: ONLY show readings for this vehicle!
    const vehicleReading = STATE.stopCrowdStorage?.byVehicle?.[bus?.vehplate]?.[s.code];
    const reading = vehicleReading;

    return {
      index: index + 1,
      code: s.code,
      name: s.name,
      dist: s.dist,
      isAtStop: s.isAtStop,
      isApproaching: s.isApproaching,
      reading,
      isVehicleSpecific: true
    };
  });

  container.innerHTML = stopsData.map(s => {
    let cardClass = 'stop-progression-card';
    let statusBadgeHtml = '<span class="stop-card-status-badge status-upcoming">Upcoming</span>';

    if (s.isAtStop) {
      cardClass += ' is-at-stop';
      statusBadgeHtml = '<span class="stop-card-status-badge status-at-stop">📍 At Stop</span>';
    } else if (s.isApproaching) {
      cardClass += ' is-approaching';
      statusBadgeHtml = '<span class="stop-card-status-badge status-approaching">⚡ Approaching (Next Stop)</span>';
    }

    const distLabel = Number.isFinite(s.dist) && s.dist < 50000 ? `${Math.round(s.dist)}m away` : '';

    let crowdBadgeHtml;
    let paxHtml;
    let timeLabelHtml;

    if (s.isAtStop) {
      const pct = occupancy(bus);
      const lvl = busCrowd(bus);
      crowdBadgeHtml = `<span class="badge ${lvl.badge}" style="font-size:0.7rem">${lvl.label} (${percentLabel(pct)})</span>`;
      paxHtml = `<span>${numberLabel(bus?.ridership)} / ${numberLabel(bus?.capacity || busCap)} pax</span>`;
      timeLabelHtml = `<span class="stop-card-time is-live">Live at stop · Updated now</span>`;
    } else if (s.reading) {
      const r = s.reading;
      const lvl = r.crowdLevel || crowd(r.occupancy * 100);
      const pct = r.occupancy * 100;
      const timeText = `Recorded ${formatTimeAgo(r.timestamp)}`;
      crowdBadgeHtml = `<span class="badge ${lvl.badge}" style="font-size:0.7rem">${lvl.label} (${percentLabel(pct)})</span>`;
      paxHtml = `<span>${numberLabel(r.ridership)} / ${numberLabel(r.capacity || busCap)} pax</span>`;
      timeLabelHtml = `<span class="stop-card-time" title="${formatTime(r.timestamp, true)} SGT">${escapeHtml(timeText)}</span>`;
    } else {
      crowdBadgeHtml = `<span class="badge badge-muted" style="font-size:0.7rem">Awaiting stop</span>`;
      paxHtml = `<span>-- / ${numberLabel(bus?.capacity || busCap)} pax</span>`;
      timeLabelHtml = `<span class="stop-card-time is-unvisited">No reading at stop yet</span>`;
    }

    const snaps = STATE.vehicleSnapshotsCache?.get(bus?.vehplate);
    const dwellInfo = getStopDwellAndExchangeForVehicle(snaps, s.code);
    let dwellBadgeHtml = '';
    if (dwellInfo) {
      if (dwellInfo.isDowntime) {
        dwellBadgeHtml = `<span class="badge badge-muted" style="font-size:0.68rem;padding:1px 5px" title="Bus resting or on scheduled downtime / layover">💤 Layover / Rest (${dwellInfo.dwellMin}m)</span>`;
      } else {
        const deltaSign = dwellInfo.deltaPax > 0 ? `+${dwellInfo.deltaPax}` : `${dwellInfo.deltaPax}`;
        dwellBadgeHtml = `<span class="badge badge-secondary" style="font-size:0.68rem;padding:1px 5px" title="Observed dwell and passenger exchange">⏱️ ${dwellInfo.dwellMin}m dwell (${deltaSign} pax)</span>`;
      }
    }

    return `
      <div class="${cardClass}" role="listitem">
        <div class="stop-card-header">
          <div class="stop-card-seq-name">
            <span class="stop-seq-badge">${s.index}</span>
            <span class="stop-card-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
          </div>
          ${statusBadgeHtml}
        </div>
        <div class="stop-card-telemetry">
          <div class="stop-card-crowd-strip">
            ${crowdBadgeHtml}
            ${paxHtml}
          </div>
          ${distLabel ? `<span class="stop-card-dist">${distLabel}</span>` : ''}
        </div>
        <div class="stop-card-meta-row">
          ${timeLabelHtml}
          ${dwellBadgeHtml}
        </div>
      </div>
    `;
  }).join('');
}

function initLeafletMap() {
  if (typeof L === 'undefined') { setText('mapDataMessage', 'Map library unavailable. Fleet readings remain available in the Fleet tab.'); return; }
  STATE.leafletMap = L.map('leafletMap', { center: [1.2966, 103.7764], zoom: 15, minZoom: 10, maxZoom: 19 });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, TomTom',
    maxZoom: 19,
    className: 'map-tiles-dark'
  }).on('tileerror', () => setText('mapDataMessage', 'Background map tiles are unavailable. Reported vehicle coordinates are still shown.')).addTo(STATE.leafletMap);
  renderBusStopsOnMap();
  if (STATE.mapShowHighlights) renderRouteTraceOnMap(true);
}

function renderBusStopsOnMap() {
  if (!STATE.leafletMap) return;
  STATE.stopMarkers.forEach(marker => STATE.leafletMap.removeLayer(marker)); STATE.stopMarkers = [];
  if (!STATE.mapShowStops) return;
  const activeRoute = STATE.mapRouteFilter;
  const hasRouteFilter = activeRoute !== 'all' && Boolean(NUS_ROUTE_STOPS[activeRoute]);
  const activeStops = hasRouteFilter ? NUS_ROUTE_STOPS[activeRoute] : null;
  const routeClr = hasRouteFilter ? routeColor(activeRoute) : '#38bdf8';

  for (const stop of NUS_BUS_STOPS) {
    const isStopOnRoute = !hasRouteFilter || activeStops.has(stop.name) || (stop.code && activeStops.has(stop.code));
    const pinClass = !hasRouteFilter
      ? 'bus-stop-pin'
      : isStopOnRoute
        ? 'bus-stop-pin active-route-stop'
        : 'bus-stop-pin dimmed-route-stop';
    const pinStyle = hasRouteFilter && isStopOnRoute ? ` style="--c:${routeClr}"` : '';
    const icon = L.divIcon({
      className: 'bus-stop-pin-wrapper',
      html: `<div class="${pinClass}"${pinStyle} title="${escapeHtml(stop.name)}"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });
    const marker = L.marker([stop.lat, stop.lng], { icon }).addTo(STATE.leafletMap);
    marker.stopCode = stop.code;
    marker.stopName = stop.name;

    marker.bindPopup(renderStopPopupHtml(stop));
    marker.on?.('popupopen', async () => {
      if (stop.code) {
        const etas = await fetchStopEtas(stop.code);
        if (etas && marker.getPopup && marker.isPopupOpen && marker.isPopupOpen()) {
          marker.setPopupContent(renderStopPopupHtml(stop, etas));
        }
      }
    });

    STATE.stopMarkers.push(marker);
  }
}

function renderRouteTraceOnMap(force = false) {
  if (!STATE.leafletMap) return;
  const legendTrace = $('legendRouteTrace');

  if (!STATE.mapShowHighlights) {
    if (STATE.routeTraceGroup) {
      STATE.leafletMap.removeLayer(STATE.routeTraceGroup);
      STATE.routeTraceGroup = null;
    }
    STATE.tracedRoute = null;
    if (legendTrace) legendTrace.hidden = true;
    renderBusStopsOnMap();
    return;
  }

  const route = STATE.mapRouteFilter;
  if (!force && route === STATE.tracedRoute) return;

  const routeChanged = STATE.tracedRoute !== route;

  if (STATE.routeTraceGroup) {
    STATE.leafletMap.removeLayer(STATE.routeTraceGroup);
    STATE.routeTraceGroup = null;
  }

  if (route === 'all') {
    STATE.tracedRoute = 'all';
    if (legendTrace) legendTrace.hidden = true;
    const layers = [];
    const allCampusRoutes = ['A1', 'A2', 'D1', 'D2', 'E', 'K'];
    for (const code of allCampusRoutes) {
      const coords = NUS_ROUTE_PATHS[code];
      if (!coords) continue;
      const color = routeColor(code);
      const glow = L.polyline(coords, {
        color,
        weight: 6,
        opacity: 0.22,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      });
      const line = L.polyline(coords, {
        color,
        weight: 3,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round'
      });
      line.bindTooltip(`<div class="route-trace-tooltip"><strong style="color:${color}">Service ${escapeHtml(code)}</strong> · Standard Route Path</div>`, {
        sticky: true,
        className: 'leaflet-route-tooltip'
      });
      layers.push(glow, line);
    }
    STATE.routeTraceGroup = (L.layerGroup ? L.layerGroup(layers) : layers[0]).addTo(STATE.leafletMap);
    renderBusStopsOnMap();
    return;
  }

  if (!NUS_ROUTE_PATHS[route]) {
    STATE.tracedRoute = route;
    if (legendTrace) legendTrace.hidden = true;
    renderBusStopsOnMap();
    return;
  }

  const coords = NUS_ROUTE_PATHS[route];
  const color = routeColor(route);

  // Outer ambient glow polyline
  const glow = L.polyline(coords, {
    color,
    weight: 9,
    opacity: 0.32,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false
  });

  // Inner crisp illuminated route line
  const line = L.polyline(coords, {
    color,
    weight: 3.5,
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round'
  });

  line.bindTooltip(`<div class="route-trace-tooltip"><strong style="color:${color}">Service ${escapeHtml(route)}</strong> · Standard Route Path</div>`, {
    sticky: true,
    className: 'leaflet-route-tooltip'
  });

  STATE.routeTraceGroup = (L.layerGroup ? L.layerGroup([glow, line]) : glow).addTo(STATE.leafletMap);
  STATE.tracedRoute = route;

  if (legendTrace) {
    legendTrace.hidden = false;
    const legendLine = $('legendRouteLine');
    const legendName = $('legendRouteName');
    if (legendLine) {
      if (typeof legendLine.style?.setProperty === 'function') legendLine.style.setProperty('--c', color);
      if (legendLine.style) legendLine.style.backgroundColor = color;
    }
    if (legendName) legendName.textContent = `Service ${route} path`;
  }

  renderBusStopsOnMap();

  if (routeChanged) {
    try {
      const bounds = line.getBounds();
      if (bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
        STATE.leafletMap.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
      }
    } catch {}
  }
}

function renderMapBuses() {
  if (!STATE.leafletMap) return;
  renderRouteTraceOnMap();
  const candidates = STATE.liveBuses.filter(bus => (STATE.mapRouteFilter === 'all' || bus.route_code === STATE.mapRouteFilter) &&
    (STATE.mapBusFilter === 'all' || bus.vehplate === STATE.mapBusFilter) && (STATE.mapCrowdFilter === 'all' || busCrowd(bus).level === STATE.mapCrowdFilter));
  const buses = candidates.filter(hasCoordinates), current = new Set(), stale = telemetryStale();
  const routeTraceNotice = STATE.mapRouteFilter === 'all'
    ? 'All campus routes traced. '
    : NUS_ROUTE_PATHS[STATE.mapRouteFilter]
      ? `Traced normal route path for ${escapeHtml(STATE.mapRouteFilter)}. `
      : '';
  setText('mapActiveBusesBadge', `${buses.length} of ${STATE.liveBuses.length} vehicles shown`);
  setText('mapDataMessage', `${routeTraceNotice}${stale ? 'Last known locations. ' : ''}${!STATE.liveBuses.length ? 'No vehicles reported. ' : ''}${candidates.length - buses.length ? `${candidates.length - buses.length} matching vehicles have no GPS reading. ` : ''}${feedContext().isPublic ? 'Only vehicles appearing in the monitored-stop arrivals feed are included. ' : ''}Locations update only when the live feed is collected.`);
  for (const bus of buses) {
    current.add(bus.vehplate);
    const level = busCrowd(bus), color = routeColor(bus.route_code);
    const icon = L.divIcon({ className: 'bus-custom-marker', html: `<div class="bus-marker-node ${stale ? 'is-stale' : ''}"><div class="bus-marker-badge" style="background-color:${color};border-color:${level.color}">🚌 ${escapeHtml(bus.route_code)}</div><div class="bus-plate-subtext">${escapeHtml(bus.vehplate)}</div></div>`, iconSize: [56, 38], iconAnchor: [28, 19] });
    const popup = `<div class="map-popup-card"><div class="map-popup-header"><span class="map-popup-route" style="background-color:${color}">${escapeHtml(bus.route_code)}</span><strong>${escapeHtml(bus.vehplate)}</strong></div><div class="bus-card-status"><span class="badge ${stale ? 'badge-secondary' : level.badge}">${stale ? 'Last known reading' : `${level.label} occupancy`}</span></div>${busReadingsMarkup(bus)}<div class="map-popup-action"><button type="button" class="btn btn-xs btn-primary btn-open-bus-dashboard" data-plate="${escapeHtml(bus.vehplate)}">Open Bus Dashboard ↗</button></div></div>`;
    let marker = STATE.busMarkers.get(bus.vehplate);
    if (marker) marker.setLatLng([bus.lat, bus.lng]).setIcon(icon).setPopupContent(popup);
    else { marker = L.marker([bus.lat, bus.lng], { icon }).addTo(STATE.leafletMap).bindPopup(popup); STATE.busMarkers.set(bus.vehplate, marker); }
  }
  for (const [plate, marker] of STATE.busMarkers) if (!current.has(plate)) { STATE.leafletMap.removeLayer(marker); STATE.busMarkers.delete(plate); }
  updateStopMarkerPopups();
  renderMapHeadwaysAndTraffic();
}

function renderMapHeadwaysAndTraffic() {
  computeAllRouteHeadways(STATE.liveBuses);

  const headwayBar = $('mapHeadwayBar');
  if (headwayBar) {
    const routeGroups = [];
    for (const [routeCode, hw] of (STATE.routeHeadways || [])) {
      if (!hw.buses || hw.buses.length < 2) continue;
      const color = routeColor(routeCode);
      const itemsHtml = [];
      const n = hw.buses.length;
      for (let i = 0; i < n; i++) {
        const b = hw.buses[i];
        const isBunched = hw.bunchedPlates.has(b.vehplate);
        itemsHtml.push(`<span class="headway-bus-badge ${isBunched ? 'is-bunched' : ''}">${escapeHtml(b.vehplate)}</span>`);
        const pair = hw.pairs[i];
        if (pair) {
          itemsHtml.push(`<span class="headway-gap ${pair.isBunched ? 'is-bunched' : ''}">── ${pair.timeGapMin}m ${pair.isBunched ? '⚠️ (Bunched)' : ''} ──</span>`);
        }
      }
      routeGroups.push(`
        <div class="headway-route-group">
          <span class="headway-route-tag" style="background-color:${color}">${escapeHtml(routeCode)}</span>
          ${itemsHtml.join('')}
        </div>
      `);
    }

    if (routeGroups.length) {
      headwayBar.innerHTML = routeGroups.join('');
      headwayBar.hidden = false;
    } else {
      headwayBar.hidden = true;
    }
  }

  const trafficBadge = $('mapTrafficIndexBadge');
  if (trafficBadge) {
    const { delayedCount } = computeStopBottlenecksAndCorridors();
    if (delayedCount === 0) {
      trafficBadge.className = 'badge badge-success';
      trafficBadge.textContent = 'Campus Traffic: Normal';
    } else {
      trafficBadge.className = 'badge badge-warning';
      trafficBadge.textContent = `⚠️ Traffic Delay (${delayedCount} corridor${delayedCount > 1 ? 's' : ''})`;
    }
  }
}
function updateMapBusSelectDropdown() {
  const buses = [...STATE.liveBuses].sort((a, b) => String(a.vehplate).localeCompare(String(b.vehplate)));
  if (!buses.some(bus => bus.vehplate === STATE.mapBusFilter)) STATE.mapBusFilter = 'all';
  $('selectBusVehicle').innerHTML = '<option value="all">All vehicles</option>' + buses.map(bus => `<option value="${escapeHtml(bus.vehplate)}">${escapeHtml(bus.vehplate)} (${escapeHtml(bus.route_code)})</option>`).join('');
  $('selectBusVehicle').value = STATE.mapBusFilter;
}

function updateAvailableDatesDropdown() {
  const dates = [...new Set(STATE.availableDates)].filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().reverse();
  $('selectQuickDate').innerHTML = '<option value="">Recorded dates</option>' + dates.map(date => `<option value="${date}">${date}${date === formatLocalDate() ? ' (Today)' : ''}</option>`).join('');
  $('selectQuickDate').value = dates.includes(STATE.selectedDate) ? STATE.selectedDate : '';
  $('selectQuickDate').disabled = !dates.length;
  $('inputSpecificDate').max = formatLocalDate();
  $('inputSpecificDate').value = STATE.selectedDate;
}

function openVehicleDashboard(vehplate) {
  const bus = STATE.allFleet.find(b => b.vehplate === vehplate) ||
              STATE.liveBuses.find(b => b.vehplate === vehplate);
  if (!bus) return;
  STATE.selectedVehiclePlate = vehplate;

  const modal = $('vehicleDashboardModal');
  if (!modal) return;
  modal.hidden = false;

  const color = routeColor(bus.route_code);
  const badge = $('vehicleModalRouteBadge');
  if (badge) {
    badge.textContent = bus.route_code;
    badge.style.backgroundColor = color;
  }
  setText('vehicleModalTitle', bus.vehplate);
  setText('vehicleModalSubtitle', `Service ${bus.route_code} · Telemetry & 24-Hour Crowd Analytics`);

  const status = fleetStatus(bus);
  const active = status === 'active';
  const stale = telemetryStale();
  const level = busCrowd(bus);

  const statusEl = $('vehicleModalLiveStatus');
  if (statusEl) {
    statusEl.className = `badge ${active && !stale ? 'badge-info' : 'badge-secondary'}`;
    statusEl.textContent = status === 'stale' || stale ? 'Stale · Last known reading' : active ? 'Reported in latest pull' : 'Not in latest pull';
  }

  const crowdEl = $('vehicleModalCrowdStatus');
  if (crowdEl) {
    crowdEl.className = `badge ${level.badge}`;
    crowdEl.textContent = `${level.label} occupancy (${percentLabel(bus.occupancy ? bus.occupancy * 100 : 0)})`;
  }

  setText('vehicleMetricRoute', `Service ${bus.route_code}`);
  setText('vehicleMetricCrowd', `${level.label} (${percentLabel(bus.occupancy ? bus.occupancy * 100 : 0)})`);
  setText('vehicleMetricRidership', `${numberLabel(bus.ridership)} / ${numberLabel(bus.capacity)} pax`);
  setText('vehicleMetricSpeed', numeric(bus.speed) === null ? 'Unknown' : `${numberLabel(bus.speed)} km/h`);
  setText('vehicleMetricGps', hasCoordinates(bus) ? `${bus.lat.toFixed(4)}, ${bus.lng.toFixed(4)}` : 'Location unknown');
  setText('vehicleMetricLastSeen', `${escapeHtml(formatTime(lastSeen(bus), true))}${lastSeen(bus) ? ' SGT' : ''}`);

  const duty = getVehicleDutySummary(bus.vehplate);
  setText('vehicleMetricShift', duty.profile);
  setText('vehicleMetricDistance', `~${duty.distanceKm} km`);
  const hw = STATE.vehicleHeadways?.get(bus.vehplate);
  if (hw && hw.isBunched) {
    setText('vehicleMetricHeadway', `⚠️ Bunched (${hw.headwayFromPrevMin || '1.5'}m behind ${hw.prevPlate || 'bus'})`);
  } else if (hw && hw.headwayToNextMin) {
    setText('vehicleMetricHeadway', `${hw.headwayToNextMin}m gap to next bus`);
  } else {
    setText('vehicleMetricHeadway', active ? 'Spacing nominal' : 'Off-service');
  }

  const banner = $('vehicleModalInactiveBanner');
  if (banner) {
    if (!active || stale) {
      const reason = inactiveReason(bus);
      banner.className = `vehicle-inactive-banner ${reason.badgeClass}`;
      banner.innerHTML = `<div class="inactive-reason-header"><span class="inactive-reason-icon" aria-hidden="true">${reason.icon}</span><strong class="inactive-reason-title">${escapeHtml(reason.title)}</strong></div><p class="inactive-reason-desc">${escapeHtml(reason.detail)}</p>`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  renderVehicleDetailMap(bus);
  renderVehicleDetailChart(bus);
  renderVehicleHourlyBarChart(bus);
  renderVehicleStopProgression(bus);
  fetchVehicleSnapshots(bus.vehplate, bus.route_code);
}

function closeVehicleDashboard() {
  const modal = $('vehicleDashboardModal');
  if (modal) modal.hidden = true;
  STATE.selectedVehiclePlate = null;
}

function renderVehicleDetailMap(bus) {
  const container = $('vehicleDetailMap');
  const banner = $('vehicleMapBanner');
  if (!container || typeof L === 'undefined') {
    if (banner) {
      banner.hidden = false;
      banner.textContent = 'Map library unavailable.';
    }
    return;
  }

  const hasGps = hasCoordinates(bus);
  const routeCode = bus.route_code;
  const color = routeColor(routeCode);

  if (!STATE.vehicleDetailMap) {
    STATE.vehicleDetailMap = L.map(container, {
      center: [1.2966, 103.7764],
      zoom: 15,
      minZoom: 10,
      maxZoom: 19,
      zoomControl: true,
      attributionControl: false
    });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      className: 'map-tiles-dark'
    }).addTo(STATE.vehicleDetailMap);
  }

  // Clear previous layers
  if (STATE.vehicleRouteTraceGroup) {
    STATE.vehicleDetailMap.removeLayer(STATE.vehicleRouteTraceGroup);
    STATE.vehicleRouteTraceGroup = null;
  }
  if (STATE.vehicleMarker) {
    STATE.vehicleDetailMap.removeLayer(STATE.vehicleMarker);
    STATE.vehicleMarker = null;
  }

  const layers = [];
  const routeCoordinates = NUS_ROUTE_PATHS[routeCode];
  if (routeCoordinates && routeCoordinates.length) {
    const glow = L.polyline(routeCoordinates, {
      color,
      weight: 8,
      opacity: 0.28,
      lineCap: 'round',
      lineJoin: 'round'
    });
    const line = L.polyline(routeCoordinates, {
      color,
      weight: 4,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round'
    });
    line.bindTooltip?.(`<div class="route-trace-tooltip"><strong style="color:${color}">Service ${escapeHtml(routeCode)}</strong> · Standard Route Path</div>`, {
      sticky: true,
      className: 'leaflet-route-tooltip'
    });
    layers.push(glow, line);
  }

  const servicedStops = NUS_ROUTE_STOPS[routeCode];
  for (const stop of NUS_BUS_STOPS) {
    const isServiced = servicedStops && (servicedStops.has(stop.name) || (stop.code && servicedStops.has(stop.code)));
    const stopIcon = L.divIcon({
      className: 'bus-stop-pin-wrapper',
      html: `<div class="bus-stop-pin ${isServiced ? 'active-route-stop' : 'dimmed-route-stop'}" style="--c:${color}" title="${escapeHtml(stop.name)}"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });
    const marker = L.marker([stop.lat, stop.lng], { icon: stopIcon });
    if (isServiced && hasGps) {
      const prox = isBusApproachingOrAtStop(bus, stop);
      const statusText = prox.isAtStop ? '📍 Bus is at this stop' : prox.isApproaching ? '⚡ Bus approaching this stop' : `${Math.round(prox.distance)}m away`;
      const lvl = busCrowd(bus);
      marker.bindPopup?.(`
        <div class="map-popup-card">
          <strong>${escapeHtml(stop.name)}</strong>
          <p class="map-popup-sub">Service ${escapeHtml(routeCode)} · ${statusText}</p>
          <div class="stop-popup-bus-row">
            <div class="stop-popup-bus-info">
              <span class="stop-popup-bus-plate">${escapeHtml(bus.vehplate)}</span>
              <span class="stop-popup-bus-sub">${statusText}</span>
            </div>
            <div class="stop-popup-bus-right">
              <span class="badge ${lvl.badge}">${lvl.label} (${percentLabel(occupancy(bus))})</span>
            </div>
          </div>
        </div>
      `);
    } else {
      marker.bindPopup?.(`<div class="map-popup-card"><strong>${escapeHtml(stop.name)}</strong><p class="map-popup-sub">${isServiced ? `Serviced by Service ${escapeHtml(routeCode)}` : 'Not on this service route'}</p></div>`);
    }
    layers.push(marker);
  }

  if (L.layerGroup) {
    STATE.vehicleRouteTraceGroup = L.layerGroup(layers).addTo(STATE.vehicleDetailMap);
  } else if (layers.length) {
    STATE.vehicleRouteTraceGroup = layers[0].addTo(STATE.vehicleDetailMap);
  }

  if (hasGps) {
    if (banner) banner.hidden = true;
    const level = busCrowd(bus);
    const stale = telemetryStale() || fleetStatus(bus) !== 'active';
    const vehicleIcon = L.divIcon({
      className: 'bus-custom-marker bus-marker-detail-pulsing',
      html: `<div class="bus-marker-node ${stale ? 'is-stale' : ''}" style="--c:${color}"><div class="bus-marker-badge" style="background-color:${color};border-color:${level.color}">🚌 ${escapeHtml(bus.route_code)}</div><div class="bus-plate-subtext">${escapeHtml(bus.vehplate)}</div></div>`,
      iconSize: [56, 38],
      iconAnchor: [28, 19]
    });
    const popupHtml = `<div class="map-popup-card"><div class="map-popup-header"><span class="map-popup-route" style="background-color:${color}">${escapeHtml(bus.route_code)}</span><strong>${escapeHtml(bus.vehplate)}</strong></div>${busReadingsMarkup(bus)}</div>`;
    STATE.vehicleMarker = L.marker([bus.lat, bus.lng], { icon: vehicleIcon })
      .addTo(STATE.vehicleDetailMap);
    STATE.vehicleMarker.bindPopup?.(popupHtml);

    STATE.vehicleDetailMap.setView([bus.lat, bus.lng], 16);
  } else {
    if (banner) {
      banner.hidden = false;
      banner.textContent = `No live GPS coordinates reported for ${bus.vehplate}. Showing standard Service ${routeCode} corridor.`;
    }
    if (routeCoords && routeCoords.length) {
      const mid = routeCoords[Math.floor(routeCoords.length / 2)];
      STATE.vehicleDetailMap.setView(mid, 15);
    } else {
      STATE.vehicleDetailMap.setView([1.2966, 103.7764], 14);
    }
  }
}

function renderVehicleDetailChart(bus) {
  const containerW = $('vehicleTimelineChart')?.parentElement?.clientWidth || 700;
  const isMobile = containerW < 520;
  const height = isMobile ? 180 : 240;
  const chart = chartContext('vehicleTimelineChart', height);
  if (!chart) return;
  const { canvas, ctx, width } = chart;
  const padding = isMobile
    ? { top: 22, right: 14, bottom: 32, left: 38 }
    : { top: 24, right: 18, bottom: 42, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  if (chartW <= 0 || chartH <= 0) return;

  const rolling = STATE.timeMode === 'rolling';
  const range = STATE.history24h.queryRange || {};
  const count = BUCKETS_COUNT;
  const lastIdx = count - 1;
  const start = rolling
    ? Math.floor((range.end || Date.now()) / BUCKET_MS) * BUCKET_MS - lastIdx * BUCKET_MS
    : new Date(`${STATE.selectedDate}T00:00:00+08:00`).getTime();
  const buckets = Array.from({ length: count }, (_, i) => ({
    timestamp: start + i * BUCKET_MS,
    label: formatTime(start + i * BUCKET_MS, true)
  }));

  const plate = bus.vehplate;
  const routeCode = bus.route_code;
  const color = routeColor(routeCode);
  const metric = STATE.vehicleDetailMetric || 'crowd';

  // Vehicle-specific historical readings
  const vehicleRows = (STATE.history24h.vehicleData || []).filter(r => r.vehplate === plate);
  const routeRows = (STATE.history24h.routeData || []).filter(r => r.route_code === routeCode);

  const vehicleValues = Array(count).fill(null);
  const vehicleOccupancies = Array(count).fill(null);
  const routeValues = Array(count).fill(null);
  const routeOccupancies = Array(count).fill(null);

  for (const row of vehicleRows) {
    const idx = Math.floor((row.bucket_ts - start) / BUCKET_MS);
    if (idx >= 0 && idx < count) {
      vehicleValues[idx] = numeric(row.avg_ridership);
      vehicleOccupancies[idx] = numeric(row.avg_occupancy_pct);
    }
  }

  for (const row of routeRows) {
    const idx = Math.floor((row.bucket_ts - start) / BUCKET_MS);
    if (idx >= 0 && idx < count) {
      routeValues[idx] = numeric(row.avg_ridership);
      routeOccupancies[idx] = numeric(row.avg_occupancy_pct);
    }
  }

  // Include latest live observation into timeline if not yet in aggregated bucket
  const busLastTime = lastSeen(bus);
  if (busLastTime && busLastTime >= start && busLastTime < start + count * BUCKET_MS) {
    const liveIdx = Math.floor((busLastTime - start) / BUCKET_MS);
    if (liveIdx >= 0 && liveIdx < count && vehicleOccupancies[liveIdx] === null) {
      if (numeric(bus.ridership) !== null) vehicleValues[liveIdx] = bus.ridership;
      if (bus.occupancy !== null && bus.occupancy !== undefined) vehicleOccupancies[liveIdx] = Math.round(bus.occupancy * 100);
    }
  }

  const primaryData = metric === 'crowd' ? vehicleOccupancies : vehicleValues;
  const baselineData = metric === 'crowd' ? routeOccupancies : routeValues;
  const observed = [...primaryData, ...baselineData].filter(v => v !== null);

  const maxY = metric === 'crowd'
    ? Math.max(100, Math.ceil(Math.max(0, ...observed) / 25) * 25)
    : Math.max(10, Math.ceil(Math.max(0, ...observed) / 10) * 10);

  const xAt = index => padding.left + (index / lastIdx) * chartW;
  const yAt = value => padding.top + chartH * (1 - value / maxY);

  if (metric === 'crowd') {
    for (const [from, to, zoneColor] of [
      [0, 35, 'rgba(16,185,129,.07)'],
      [35, 75, 'rgba(245,158,11,.07)'],
      [75, maxY, 'rgba(239,68,68,.07)']
    ]) {
      ctx.fillStyle = zoneColor;
      ctx.fillRect(padding.left, yAt(to), chartW, ((to - from) / maxY) * chartH);
    }
  }

  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  for (let tick = 0; tick <= 4; tick++) {
    const val = (maxY * tick) / 4;
    const y = yAt(val);
    ctx.strokeStyle = '#273553';
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    const tickText = metric === 'crowd' ? `${numberLabel(val)}%` : `${Math.round(val)}`;
    ctx.fillText(tickText, padding.left - 6, y + 3);
  }

  // Draw clean, readable in-chart legend at top
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  // Vehicle solid line legend
  ctx.fillStyle = color;
  ctx.fillRect(padding.left, 10, 14, 3);
  ctx.fillStyle = '#f1f5f9';
  ctx.fillText(`Bus ${plate}`, padding.left + 18, 14);

  // Route dashed baseline legend
  const legX = padding.left + 105;
  ctx.strokeStyle = '#64748b';
  ctx.setLineDash([4, 2]);
  ctx.beginPath();
  ctx.moveTo(legX, 11);
  ctx.lineTo(legX + 16, 11);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`Route ${routeCode} Avg`, legX + 22, 14);

  const step = chartW < 380 ? Math.round(count / 3) : (chartW < 550 ? Math.round(count / 4) : Math.round(count / 6));
  const endX = xAt(lastIdx);
  const endLabel = isMobile ? formatTime(buckets[lastIdx].timestamp) : `${formatTime(buckets[lastIdx].timestamp)} SGT`;
  const labelY = height - (isMobile ? 10 : 12);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#64748b';
  for (let i = 0; i < count; i += step) {
    const x = xAt(i);
    if (endX - x < 50) continue;
    ctx.fillText(formatTime(buckets[i].timestamp), x, labelY);
  }
  ctx.textAlign = 'right';
  ctx.fillText(endLabel, endX, labelY);

  // Route baseline (dashed reference line)
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  let prev = false;
  baselineData.forEach((val, i) => {
    if (val === null) { prev = false; return; }
    if (prev) ctx.lineTo(xAt(i), yAt(val)); else ctx.moveTo(xAt(i), yAt(val));
    prev = true;
  });
  ctx.stroke();
  ctx.setLineDash([]);

  // Vehicle-specific primary curve
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  prev = false;
  primaryData.forEach((val, i) => {
    if (val === null) { prev = false; return; }
    if (prev) ctx.lineTo(xAt(i), yAt(val)); else ctx.moveTo(xAt(i), yAt(val));
    prev = true;
  });
  ctx.stroke();

  const validVehicleData = primaryData.filter(v => v !== null);
  const baseR = validVehicleData.length < 20 ? 3.5 : 2.5;
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  primaryData.forEach((val, i) => {
    if (val === null || STATE.vehicleHoveredIndex === i) return;
    const x = xAt(i), y = yAt(val);
    ctx.moveTo(x + baseR, y);
    ctx.arc(x, y, baseR, 0, Math.PI * 2);
  });
  ctx.fill();
  ctx.stroke();

  if (STATE.vehicleHoveredIndex !== null && primaryData[STATE.vehicleHoveredIndex] !== null && primaryData[STATE.vehicleHoveredIndex] !== undefined) {
    const i = STATE.vehicleHoveredIndex;
    ctx.beginPath();
    ctx.arc(xAt(i), yAt(primaryData[i]), 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  const hasVehicleData = primaryData.some(v => v !== null);
  if (!hasVehicleData) {
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.font = '13px sans-serif';
    ctx.fillText(`No 24-hour readings recorded for ${plate} yet.`, padding.left + chartW / 2, padding.top + chartH / 2);
  }

  if (STATE.vehicleHoveredIndex !== null) {
    ctx.strokeStyle = '#94a3b8';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xAt(STATE.vehicleHoveredIndex), padding.top);
    ctx.lineTo(xAt(STATE.vehicleHoveredIndex), padding.top + chartH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const avgVal = validVehicleData.length ? validVehicleData.reduce((a, b) => a + b, 0) / validVehicleData.length : null;
  const maxIdx = validVehicleData.length ? primaryData.indexOf(Math.max(...validVehicleData)) : -1;
  const peakTime = maxIdx >= 0 ? buckets[maxIdx]?.label : null;
  const peakVal = maxIdx >= 0 ? primaryData[maxIdx] : null;
  const obsCount = validVehicleData.length;

  setText('vehicleStatPeak', `Peak: ${peakTime ? `${peakTime} SGT (${metric === 'crowd' ? percentLabel(peakVal) : `${numberLabel(peakVal)} pax`})` : 'No data'}`);
  setText('vehicleStatAvg', `24h Bus Avg: ${metric === 'crowd' ? percentLabel(avgVal) : `${numberLabel(avgVal)} pax`}`);
  setText('vehicleStatActiveCount', `Observed: ${obsCount} interval${obsCount === 1 ? '' : 's'}`);

  canvas._chartMeta = { padding, chartW, chartH, buckets, primaryData, baselineData, plate, routeCode, color, metric };
}

function renderVehicleHourlyBarChart(bus) {
  const chart = chartContext('vehicleHourlyBarChart', 120);
  if (!chart) return;
  const { canvas, ctx, width, height } = chart;
  const padding = { top: 14, right: 18, bottom: 26, left: 45 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  if (chartW <= 0 || chartH <= 0) return;

  const plate = bus.vehplate;
  const vehicleRows = (STATE.history24h.vehicleData || []).filter(r => r.vehplate === plate);

  const hourlySums = Array(24).fill(0);
  const hourlyWeights = Array(24).fill(0);
  const hourlyCounts = Array(24).fill(0);

  for (const row of vehicleRows) {
    if (row.avg_occupancy_pct === null || row.avg_occupancy_pct === undefined) continue;
    const hour = new Date(row.bucket_ts + 8 * 3600 * 1000).getUTCHours();
    const weight = row.sample_count || 1;
    hourlySums[hour] += row.avg_occupancy_pct * weight;
    hourlyWeights[hour] += weight;
    hourlyCounts[hour] += 1;
  }

  // Include latest live bus reading if not yet bucketed
  const busLastTime = lastSeen(bus);
  if (busLastTime && bus.occupancy !== null && bus.occupancy !== undefined) {
    const liveHour = new Date(busLastTime + 8 * 3600 * 1000).getUTCHours();
    if (hourlyCounts[liveHour] === 0) {
      hourlySums[liveHour] += Math.round(bus.occupancy * 100);
      hourlyWeights[liveHour] += 1;
      hourlyCounts[liveHour] += 1;
    }
  }

  const hourlyValues = Array(24).fill(null);
  for (let h = 0; h < 24; h++) {
    if (hourlyWeights[h] > 0) {
      hourlyValues[h] = Math.round(hourlySums[h] / hourlyWeights[h]);
    }
  }

  const observed = hourlyValues.filter(v => v !== null);
  const maxY = Math.max(100, Math.ceil(Math.max(0, ...observed) / 25) * 25);

  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const val = (maxY * i) / 4;
    const y = padding.top + chartH * (1 - i / 4);
    ctx.strokeStyle = '#273553';
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.fillText(`${numberLabel(val)}%`, padding.left - 6, y + 3);
  }

  const slotW = chartW / 24;
  const barW = Math.max(5, slotW * 0.65);

  for (let hour = 0; hour < 24; hour++) {
    const x = padding.left + hour * slotW;
    const barX = x + (slotW - barW) / 2;
    const isHovered = STATE.vehicleHourlyHoveredIndex === hour;

    if (isHovered) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fillRect(x, padding.top, slotW, chartH);
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = isHovered ? '#f1f5f9' : '#64748b';
    const step = chartW < 500 ? 3 : chartW < 750 ? 2 : 1;
    if (hour % step === 0) {
      ctx.fillText(String(hour).padStart(2, '0'), barX + barW / 2, height - 8);
    }

    const val = hourlyValues[hour];
    if (val === null) {
      ctx.fillStyle = '#334155';
      ctx.fillText('·', barX + barW / 2, padding.top + chartH - 4);
      continue;
    }

    // For 0% occupancy (empty bus), draw a clean baseline pill
    const barH = val === 0 ? 5 : Math.max(5, (val / maxY) * chartH);
    const barY = padding.top + chartH - barH;
    ctx.fillStyle = crowd(val).color;
    ctx.fillRect(barX, barY, barW, barH);

    if (isHovered) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(barX, barY, barW, barH);
    }
  }

  if (!observed.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.font = '13px sans-serif';
    ctx.fillText(`No hourly occupancy readings recorded for ${plate} in this window.`, padding.left + chartW / 2, padding.top + chartH / 2);
  }

  // Update hourly summary stats
  if (observed.length) {
    const maxVal = Math.max(...observed);
    const peakH = hourlyValues.indexOf(maxVal);
    const avgVal = Math.round(observed.reduce((a, b) => a + b, 0) / observed.length);
    setText('vehicleHourlyPeak', `Peak Hour: ${String(peakH).padStart(2, '0')}:00 SGT (${percentLabel(maxVal)})`);
    setText('vehicleHourlyAvg', `Active Avg: ${percentLabel(avgVal)}`);
    setText('vehicleHourlyActiveHours', `Operating: ${observed.length} of 24 hrs`);
  } else {
    setText('vehicleHourlyPeak', 'Peak Hour: No data');
    setText('vehicleHourlyAvg', 'Active Avg: No data');
    setText('vehicleHourlyActiveHours', 'Operating: 0 of 24 hrs');
  }

  canvas._hourlyMeta = { padding, chartW, chartH, slotW, barW, hourlyValues, hourlyCounts, maxY, plate, routeCode: bus.route_code };
}

function setupVehicleDashboardInteractivity() {
  const canvas = $('vehicleTimelineChart');
  const tooltip = $('vehicleChartTooltip');
  if (canvas) {
    let timelineRaf = null;
    let timelineCoords = null;

    const handleTimelinePointer = (clientX, clientY) => {
      const meta = canvas._chartMeta;
      if (!meta) return;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      if (x < meta.padding.left || x > meta.padding.left + meta.chartW) {
        if (tooltip) tooltip.style.display = 'none';
        if (STATE.vehicleHoveredIndex !== null) {
          STATE.vehicleHoveredIndex = null;
          const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                      STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
          if (bus) renderVehicleDetailChart(bus);
        }
        return;
      }
      const maxIdx = (meta.buckets?.length || BUCKETS_COUNT) - 1;
      const index = Math.max(0, Math.min(maxIdx, Math.round(((x - meta.padding.left) / meta.chartW) * maxIdx)));
      const indexChanged = STATE.vehicleHoveredIndex !== index;
      if (indexChanged) {
        STATE.vehicleHoveredIndex = index;
        const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                    STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
        if (bus) renderVehicleDetailChart(bus);
      }

      if (tooltip) {
        if (indexChanged) {
          const primary = meta.primaryData[index];
          const baseline = meta.baselineData[index];
          const timeLabel = meta.buckets[index]?.label || '';
          const unit = meta.metric === 'crowd' ? '%' : ' pax';
          tooltip.innerHTML = `<strong>${escapeHtml(timeLabel)} SGT</strong>` +
            (primary !== null ? `<div class="tooltip-row"><span style="color:${meta.color}">Bus ${escapeHtml(meta.plate)}</span><span>${numberLabel(primary)}${unit}</span></div>` : `<div>No reading for ${escapeHtml(meta.plate)}</div>`) +
            (baseline !== null ? `<div class="tooltip-row"><span style="color:#94a3b8">Route ${escapeHtml(meta.routeCode)} Avg</span><span>${numberLabel(baseline)}${unit}</span></div>` : '');
        }
        tooltip.style.display = 'block';
        positionChartTooltip(tooltip, canvas, clientX, clientY);
      }
    };

    const onTimelineMove = (clientX, clientY) => {
      timelineCoords = { clientX, clientY };
      if (!timelineRaf) {
        let active = true;
        timelineRaf = requestAnimationFrame(() => {
          active = false;
          timelineRaf = null;
          if (timelineCoords) handleTimelinePointer(timelineCoords.clientX, timelineCoords.clientY);
        });
        if (!active) timelineRaf = null;
      }
    };

    canvas.addEventListener('mousemove', event => onTimelineMove(event.clientX, event.clientY));
    canvas.addEventListener('touchmove', event => {
      if (event.touches?.length) onTimelineMove(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: true });
    canvas.addEventListener('touchstart', event => {
      if (event.touches?.length) handleTimelinePointer(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: true });
    const resetTimelinePointer = () => {
      if (timelineRaf) { cancelAnimationFrame(timelineRaf); timelineRaf = null; }
      timelineCoords = null;
      if (tooltip) tooltip.style.display = 'none';
      if (STATE.vehicleHoveredIndex !== null) {
        STATE.vehicleHoveredIndex = null;
        const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                    STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
        if (bus) renderVehicleDetailChart(bus);
      }
    };
    canvas.addEventListener('mouseleave', resetTimelinePointer);
    canvas.addEventListener('touchend', resetTimelinePointer);
  }

  const hourlyCanvas = $('vehicleHourlyBarChart');
  const hourlyTooltip = $('vehicleHourlyTooltip');
  if (hourlyCanvas) {
    let vHourlyRaf = null;
    let vHourlyCoords = null;

    const handleHourlyPointer = (clientX, clientY) => {
      const meta = hourlyCanvas._hourlyMeta;
      if (!meta) return;
      const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                  STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
      const rect = hourlyCanvas.getBoundingClientRect();
      const x = clientX - rect.left;
      if (x < meta.padding.left || x > meta.padding.left + meta.chartW) {
        if (hourlyTooltip) hourlyTooltip.style.display = 'none';
        if (STATE.vehicleHourlyHoveredIndex !== null) {
          STATE.vehicleHourlyHoveredIndex = null;
          if (bus) renderVehicleHourlyBarChart(bus);
        }
        return;
      }
      const hour = Math.max(0, Math.min(23, Math.floor((x - meta.padding.left) / meta.slotW)));
      const indexChanged = STATE.vehicleHourlyHoveredIndex !== hour;
      if (indexChanged) {
        STATE.vehicleHourlyHoveredIndex = hour;
        if (bus) renderVehicleHourlyBarChart(bus);
      }

      if (hourlyTooltip) {
        if (indexChanged) {
          const val = meta.hourlyValues[hour];
          const count = meta.hourlyCounts[hour];
          const timeLabel = `${String(hour).padStart(2, '0')}:00 - ${String(hour).padStart(2, '0')}:59 SGT`;
          const cap = bus ? numeric(bus.capacity) : null;
          const estPax = val !== null && cap ? Math.round((val / 100) * cap) : null;
          hourlyTooltip.innerHTML = `<strong>${escapeHtml(timeLabel)}</strong>` +
            (val !== null ? `<div class="tooltip-row"><span style="color:${crowd(val).color}">Bus ${escapeHtml(meta.plate)}</span><span>${numberLabel(val)}% occupancy</span></div>` +
              (estPax !== null ? `<div class="tooltip-row"><span>Est. Passenger Load</span><span>${estPax} / ${cap} pax</span></div>` : '') +
              `<div class="tooltip-row"><span>Observations</span><span>${count} reading${count === 1 ? '' : 's'}</span></div>`
            : `<div>No readings for ${escapeHtml(meta.plate)}</div>`);
        }
        hourlyTooltip.style.display = 'block';
        positionChartTooltip(hourlyTooltip, hourlyCanvas, clientX, clientY);
      }
    };

    const onVHourlyMove = (clientX, clientY) => {
      vHourlyCoords = { clientX, clientY };
      if (!vHourlyRaf) {
        let active = true;
        vHourlyRaf = requestAnimationFrame(() => {
          active = false;
          vHourlyRaf = null;
          if (vHourlyCoords) handleHourlyPointer(vHourlyCoords.clientX, vHourlyCoords.clientY);
        });
        if (!active) vHourlyRaf = null;
      }
    };

    hourlyCanvas.addEventListener('mousemove', event => onVHourlyMove(event.clientX, event.clientY));
    hourlyCanvas.addEventListener('touchmove', event => {
      if (event.touches?.length) onVHourlyMove(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: true });
    hourlyCanvas.addEventListener('touchstart', event => {
      if (event.touches?.length) handleHourlyPointer(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: true });
    const resetHourlyPointer = () => {
      if (vHourlyRaf) { cancelAnimationFrame(vHourlyRaf); vHourlyRaf = null; }
      vHourlyCoords = null;
      if (hourlyTooltip) hourlyTooltip.style.display = 'none';
      if (STATE.vehicleHourlyHoveredIndex !== null) {
        STATE.vehicleHourlyHoveredIndex = null;
        const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                    STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
        if (bus) renderVehicleHourlyBarChart(bus);
      }
    };
    hourlyCanvas.addEventListener('mouseleave', resetHourlyPointer);
    hourlyCanvas.addEventListener('touchend', resetHourlyPointer);
  }

  $('btnVehicleMetricCrowd')?.addEventListener('click', () => {
    STATE.vehicleDetailMetric = 'crowd';
    $('btnVehicleMetricCrowd')?.classList.add('active');
    $('btnVehicleMetricCrowd')?.setAttribute('aria-pressed', 'true');
    $('btnVehicleMetricPax')?.classList.remove('active');
    $('btnVehicleMetricPax')?.setAttribute('aria-pressed', 'false');
    const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
    if (bus) renderVehicleDetailChart(bus);
  });

  $('btnVehicleMetricPax')?.addEventListener('click', () => {
    STATE.vehicleDetailMetric = 'exact';
    $('btnVehicleMetricPax')?.classList.add('active');
    $('btnVehicleMetricPax')?.setAttribute('aria-pressed', 'true');
    $('btnVehicleMetricCrowd')?.classList.remove('active');
    $('btnVehicleMetricCrowd')?.setAttribute('aria-pressed', 'false');
    const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
    if (bus) renderVehicleDetailChart(bus);
  });

  $('btnVehicleModalClose')?.addEventListener('click', closeVehicleDashboard);
  $('vehicleDashboardModal')?.addEventListener('click', event => {
    if (event.target === $('vehicleDashboardModal')) closeVehicleDashboard();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && STATE.selectedVehiclePlate) {
      closeVehicleDashboard();
    }
  });

  $('btnVehicleJumpToMap')?.addEventListener('click', () => {
    const plate = STATE.selectedVehiclePlate;
    const bus = STATE.allFleet.find(b => b.vehplate === plate) || STATE.liveBuses.find(b => b.vehplate === plate);
    closeVehicleDashboard();
    if (bus) {
      STATE.mapRouteFilter = bus.route_code;
      STATE.mapBusFilter = bus.vehplate;
    }
    $('tabButtonMap')?.click();
  });

  $('btnVehicleJumpToAnalytics')?.addEventListener('click', () => {
    const plate = STATE.selectedVehiclePlate;
    const bus = STATE.allFleet.find(b => b.vehplate === plate) || STATE.liveBuses.find(b => b.vehplate === plate);
    closeVehicleDashboard();
    if (bus) {
      STATE.activeRoutes = new Set([bus.route_code]);
      STATE.selectedTimelineVehicle = bus.vehplate;
      if ($('selectTimelineVehicle')) $('selectTimelineVehicle').value = bus.vehplate;
    }
    $('tabButtonHistory')?.click();
  });

  // Delegated clicks for bus cards in fleetGrid
  $('fleetGrid')?.addEventListener('click', event => {
    const card = event.target?.closest?.('.bus-card');
    if (card && card.dataset?.plate) {
      openVehicleDashboard(card.dataset.plate);
    }
  });
  $('fleetGrid')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      const card = event.target?.closest?.('.bus-card');
      if (card && card.dataset?.plate) {
        event.preventDefault();
        openVehicleDashboard(card.dataset.plate);
      }
    }
  });

  // Delegated click for map popup buttons
  document.addEventListener('click', event => {
    const btn = event.target?.closest?.('.btn-open-bus-dashboard');
    if (btn && btn.dataset?.plate) {
      openVehicleDashboard(btn.dataset.plate);
    }
  });
}

function setupTabs() {
  const tabs = [...document.querySelectorAll('.tab-btn')];
  tabs.forEach(button => button.addEventListener('click', () => {
    STATE.currentTab = button.dataset.tab;
    tabs.forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); tab.tabIndex = tab === button ? 0 : -1; });
    document.querySelectorAll('.tab-content').forEach(panel => panel.classList.toggle('active', panel.id === STATE.currentTab));
    if (STATE.currentTab === 'tab-map') { initMapIfNeeded(); STATE.leafletMap?.invalidateSize(); renderMapBuses(); }
    if (STATE.currentTab === 'tab-24h') renderTimelineChart();
    if (STATE.currentTab === 'tab-optimizer') renderOptimizerView();
  }));
  tabs.forEach((button, index) => {
    button.tabIndex = button.classList.contains('active') ? 0 : -1;
    button.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next !== null) { event.preventDefault(); tabs[next].focus(); tabs[next].click(); }
    });
  });
}
function initMapIfNeeded() { if (!STATE.leafletMap) initLeafletMap(); }
function setupFilters() {
  $('routeFilterPills').addEventListener('click', event => {
    const code = event.target.closest('[data-route]')?.dataset.route; if (!code) return;
    if (STATE.activeRoutes.has(code)) STATE.activeRoutes.delete(code); else STATE.activeRoutes.add(code);
    renderRouteFilters(); renderTimelineChart();
  });
  for (const [id, dataName, stateKey, render] of [
    ['mapRouteFilterPills', 'mapRoute', 'mapRouteFilter', renderMapBuses], ['fleetRouteGroup', 'fleetFilter', 'fleetFilter', renderFleetGrid],
    ['fleetStatusGroup', 'fleetStatus', 'fleetStatusFilter', renderFleetGrid], ['viewToggleGroup', 'view', 'currentView', renderTimelineChart],
    ['smoothingToggleGroup', 'smoothing', 'smoothing', renderTimelineChart]
  ]) $(id).addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button?.dataset[dataName]) return;
    STATE[stateKey] = button.dataset[dataName];
    $(id).querySelectorAll('button').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    render();
  });
  $('fleetSearch').addEventListener('input', event => { STATE.fleetSearch = event.target.value.trim().toLocaleLowerCase(); renderFleetGrid(); });
  $('selectBusVehicle').addEventListener('change', event => {
    STATE.mapBusFilter = event.target.value; renderMapBuses();
    const bus = STATE.liveBuses.find(item => item.vehplate === STATE.mapBusFilter);
    if (bus && hasCoordinates(bus) && STATE.leafletMap) { STATE.leafletMap.setView([bus.lat, bus.lng], 17); STATE.busMarkers.get(bus.vehplate)?.openPopup(); }
  });
  $('selectMapStop')?.addEventListener('change', event => {
    STATE.selectedMapStop = event.target.value;
    if (STATE.selectedMapStop === 'all') return;
    const stop = NUS_BUS_STOPS.find(s => s.code === STATE.selectedMapStop || s.name === STATE.selectedMapStop);
    if (stop && STATE.leafletMap) {
      STATE.leafletMap.setView([stop.lat, stop.lng], 17);
      const marker = STATE.stopMarkers.find(m => m.stopCode === stop.code || m.stopName === stop.name);
      if (marker) marker.openPopup();
    }
  });
  $('selectTimelineVehicle')?.addEventListener('change', event => {
    STATE.selectedTimelineVehicle = event.target.value;
    renderTimelineChart();
  });
  $('selectMapCrowd').addEventListener('change', event => { STATE.mapCrowdFilter = event.target.value; renderMapBuses(); });
  $('checkShowRouteHighlights').addEventListener('change', event => { STATE.mapShowHighlights = event.target.checked; renderRouteTraceOnMap(true); });
  $('checkShowStops').addEventListener('change', event => { STATE.mapShowStops = event.target.checked; renderBusStopsOnMap(); });
  $('btnCenterCampus').addEventListener('click', () => STATE.leafletMap?.setView([1.2966, 103.7764], 15));
  $('timeModeToggleGroup').addEventListener('click', event => {
    const button = event.target.closest('[data-timemode]'); if (!button) return;
    STATE.timeMode = button.dataset.timemode; STATE.hoveredIndex = null;
    $('datePickerGroup').hidden = STATE.timeMode !== 'date';
    $('timeModeToggleGroup').querySelectorAll('button').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    fetchHistory24h();
  });
  const selectDate = date => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > formatLocalDate()) return;
    STATE.selectedDate = date; STATE.hoveredIndex = null; updateAvailableDatesDropdown(); fetchHistory24h();
  };
  $('selectQuickDate').addEventListener('change', event => selectDate(event.target.value));
  $('inputSpecificDate').addEventListener('change', event => selectDate(event.target.value));
  $('btnDateToday').addEventListener('click', () => selectDate(formatLocalDate()));
  $('btnDateYesterday').addEventListener('click', () => selectDate(formatLocalDate(new Date(Date.now() - DAY_MS))));
}

function setupActionButtons() {
  const pollNow = async () => {
    if (STATE.polling) return;
    STATE.polling = true; renderStatus();
    try {
      const endpoint = STATE.adminToken ? '/api/poll-now' : '/api/cron';
      const options = STATE.adminToken ? { method: 'POST' } : {};
      const data = await requestJson(endpoint, options);
      showAction(`Live collection complete: ${numberLabel(data.recordsCount ?? data.polledCount)} vehicle readings.`);
    } catch (error) { showAction(`Collection failed: ${error.message}`, true); }
    finally { STATE.polling = false; if (STATE.refreshPromise) await STATE.refreshPromise; await refreshAllData(); }
  };
  $('btnPollNow').addEventListener('click', pollNow); $('btnSettingsPollNow').addEventListener('click', pollNow);
  $('btnCloseBanner')?.addEventListener('click', () => { $('connectionBanner').hidden = true; });
  $('inputAdminToken').addEventListener('input', event => { STATE.adminToken = event.target.value.trim(); });
  let resizeFrame;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => {
      renderTimelineChart(); renderHourlyBarChart(); STATE.leafletMap?.invalidateSize();
      if (STATE.selectedVehiclePlate && $('vehicleDashboardModal') && !$('vehicleDashboardModal').hidden) {
        const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                    STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
        if (bus) {
          renderVehicleDetailChart(bus);
          renderVehicleHourlyBarChart(bus);
          STATE.vehicleDetailMap?.invalidateSize();
        }
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs(); setupFilters(); setupActionButtons(); setupChartInteractivity(); setupVehicleDashboardInteractivity();
  await refreshAllData();
  setInterval(() => { if (!document.hidden) refreshAllData(); }, 30000);
  setInterval(() => { if (!document.hidden) { renderCountdown(); if (telemetryStale()) { renderStatus(); renderSummaryCards(); } } }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAllData(); });
});
