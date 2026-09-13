/* Live NUS shuttle telemetry. All dashboard times use Singapore time. */
'use strict';

const TIME_ZONE = 'Asia/Singapore';
const BUCKET_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
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
const hourRange = hour => `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`;
const STATE = {
  currentTab: 'tab-24h', currentView: 'exact', timeMode: 'rolling', selectedDate: formatLocalDate(),
  availableDates: [], activeRoutes: new Set(['CAMPUS_AVG']), seenRoutes: new Set(), routesMeta: {},
  fleetFilter: 'all', fleetStatusFilter: 'all', fleetSearch: '', liveBuses: [], allFleet: [], live: {},
  history24h: { routeData: [], campusData: [] }, analytics: {}, status: {}, errors: {},
  mapRouteFilter: 'all', mapBusFilter: 'all', mapCrowdFilter: 'all', mapShowStops: true, mapShowHighlights: true,
  leafletMap: null, busMarkers: new Map(), stopMarkers: [], routeTraceGroup: null, tracedRoute: 'all', hoveredIndex: null,
  selectedVehiclePlate: null, vehicleDetailMap: null, vehicleDetailMetric: 'crowd', vehicleMarker: null, vehicleRouteTraceGroup: null, vehicleHoveredIndex: null,
  refreshPromise: null, historyRequest: 0, nextPollAt: null, polling: false, adminToken: ''
};
const ROUTE_COLORS = { CAMPUS_AVG: '#38bdf8', A1: '#FB0101', A2: '#FBAE17', D1: '#9E005D', D2: '#6A1B9A', E: '#00838F', K: '#2E7D32' };
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
    (timestamp && Date.now() - new Date(timestamp).getTime() > (STATE.status.pollingIntervalSec || 600) * 1500));
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
    renderAll();
  })().finally(() => { STATE.refreshPromise = null; });
  return STATE.refreshPromise;
}

function renderAll() {
  renderRouteFilters(); updateAvailableDatesDropdown(); renderStatus(); renderSummaryCards();
  renderTimelineChart(); renderOptimizerView(); renderFleetGrid(); updateMapBusSelectDropdown(); renderMapBuses();
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
  if (STATE.status.collectionMode === 'on-demand') return setText('pollerCountdown', 'On-demand / external schedule');
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

function renderTimelineChart() {
  const chart = chartContext('timelineChart', 420);
  if (!chart) return;
  const { canvas, ctx, width, height } = chart;
  const padding = { top: 30, right: 24, bottom: 52, left: 60 };
  const chartW = width - padding.left - padding.right, chartH = height - padding.top - padding.bottom;
  const rolling = STATE.timeMode === 'rolling';
  const range = STATE.history24h.queryRange || {};
  const start = rolling ? Math.floor((range.end || Date.now()) / BUCKET_MS) * BUCKET_MS - 143 * BUCKET_MS : new Date(`${STATE.selectedDate}T00:00:00+08:00`).getTime();
  const buckets = Array.from({ length: 144 }, (_, i) => ({ timestamp: start + i * BUCKET_MS, label: formatTime(start + i * BUCKET_MS, true) }));
  const seriesMap = new Map();
  for (const code of ['CAMPUS_AVG', ...routeCodes()]) {
    if (STATE.activeRoutes.has(code)) seriesMap.set(code, { code, color: routeColor(code), values: Array(144).fill(null), occupancies: Array(144).fill(null) });
  }
  const populate = (row, code) => {
    const series = seriesMap.get(code);
    const index = Math.floor((row.bucket_ts - start) / BUCKET_MS);
    if (!series || index < 0 || index >= 144) return;
    series.values[index] = numeric(row.avg_ridership);
    series.occupancies[index] = numeric(row.avg_occupancy_pct);
  };
  (STATE.history24h.routeData || []).forEach(row => populate(row, row.route_code));
  (STATE.history24h.campusData || []).forEach(row => populate(row, 'CAMPUS_AVG'));
  const valuesFor = series => STATE.currentView === 'exact' ? series.values : series.occupancies;
  const observed = [...seriesMap.values()].flatMap(valuesFor).filter(value => value !== null);
  const maxY = STATE.currentView === 'exact' ? Math.max(10, Math.ceil(Math.max(0, ...observed) / 10) * 10) : Math.max(100, Math.ceil(Math.max(0, ...observed) / 25) * 25);
  const xAt = index => padding.left + index / 143 * chartW;
  const yAt = value => padding.top + chartH * (1 - value / maxY);
  if (STATE.currentView === 'crowd') {
    for (const [from, to, color] of [[0, 35, 'rgba(16,185,129,.08)'], [35, 75, 'rgba(245,158,11,.08)'], [75, maxY, 'rgba(239,68,68,.08)']]) {
      ctx.fillStyle = color; ctx.fillRect(padding.left, yAt(to), chartW, (to - from) / maxY * chartH);
    }
  }
  ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
  for (let tick = 0; tick <= 4; tick++) {
    const value = maxY * tick / 4, y = yAt(value);
    ctx.strokeStyle = '#273553'; ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
    ctx.fillStyle = '#94a3b8'; ctx.fillText(`${numberLabel(value)}${STATE.currentView === 'exact' ? '' : '%'}`, padding.left - 8, y + 4);
  }
  ctx.textAlign = 'left'; ctx.fillText(STATE.currentView === 'exact' ? 'Average passengers per bus' : 'Crowd level (%)', padding.left, 16);
  const labelStep = chartW < 600 ? 36 : 24;
  ctx.textAlign = 'center';
  for (let i = 0; i < 144; i += labelStep) ctx.fillText(formatTime(buckets[i].timestamp), xAt(i), height - 27);
  ctx.textAlign = 'right'; ctx.fillText(`${formatTime(buckets[143].timestamp)} SGT`, xAt(143), height - 27);
  for (const series of seriesMap.values()) {
    const values = valuesFor(series);
    ctx.strokeStyle = series.color; ctx.lineWidth = series.code === 'CAMPUS_AVG' ? 3 : 2;
    ctx.setLineDash(series.code === 'CAMPUS_AVG' ? [5, 3] : []);
    ctx.beginPath(); let previous = false;
    values.forEach((value, index) => {
      if (value === null) { previous = false; return; }
      if (previous) ctx.lineTo(xAt(index), yAt(value)); else ctx.moveTo(xAt(index), yAt(value));
      previous = true;
    });
    ctx.stroke(); ctx.setLineDash([]);
    values.forEach((value, index) => {
      if (value === null) return;
      ctx.beginPath(); ctx.arc(xAt(index), yAt(value), STATE.hoveredIndex === index ? 4 : 2, 0, Math.PI * 2);
      ctx.fillStyle = series.color; ctx.fill();
    });
  }
  if (!observed.length) {
    ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'; ctx.font = '14px sans-serif';
    ctx.fillText(STATE.errors.history ? 'History could not be loaded' : 'No reported readings for this view', padding.left + chartW / 2, padding.top + chartH / 2);
  }
  if (STATE.hoveredIndex !== null) {
    ctx.strokeStyle = '#64748b'; ctx.setLineDash([3, 3]); ctx.beginPath();
    ctx.moveTo(xAt(STATE.hoveredIndex), padding.top); ctx.lineTo(xAt(STATE.hoveredIndex), padding.top + chartH); ctx.stroke(); ctx.setLineDash([]);
  }
  setText('panelTimelineTitle', rolling ? 'Rolling 24-Hour Shuttle Readings' : `Shuttle Readings · ${STATE.selectedDate}`);
  setText('panelTimelineSubtitle', `${buckets[0].label} → ${buckets[143].label} SGT · Gaps indicate missing readings`);
  setText('chartDescription', STATE.errors.history ? `History unavailable: ${STATE.errors.history}` : `${observed.length} plotted readings in selected routes. Passenger counts are averages per bus; missing values remain unknown. All times are SGT.`);
  canvas._chartMeta = { padding, chartW, chartH, seriesMap, buckets };
}

function setupChartInteractivity() {
  const canvas = $('timelineChart'), tooltip = $('chartTooltip');
  canvas.addEventListener('mousemove', event => {
    const meta = canvas._chartMeta;
    if (!meta) return;
    const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left;
    if (x < meta.padding.left || x > meta.padding.left + meta.chartW) { tooltip.style.display = 'none'; STATE.hoveredIndex = null; renderTimelineChart(); return; }
    const index = Math.max(0, Math.min(143, Math.round((x - meta.padding.left) / meta.chartW * 143)));
    STATE.hoveredIndex = index;
    const rows = [...meta.seriesMap.values()].filter(series => series.values[index] !== null || series.occupancies[index] !== null);
    tooltip.innerHTML = `<strong>${escapeHtml(meta.buckets[index].label)} SGT</strong>${rows.length ? rows.map(series => `<div class="tooltip-row"><span style="color:${series.color}">${escapeHtml(series.code === 'CAMPUS_AVG' ? 'Observed Average' : series.code)}</span><span>${numberLabel(series.values[index])} pax · ${percentLabel(series.occupancies[index])}</span></div>`).join('') : '<p>No reported readings in this interval</p>'}`;
    tooltip.style.display = 'block';
    tooltip.style.left = `${Math.max(0, Math.min(x + 12, rect.width - tooltip.offsetWidth))}px`;
    tooltip.style.top = `${Math.min(event.clientY - rect.top + 12, Math.max(0, rect.height - tooltip.offsetHeight))}px`;
    renderTimelineChart();
  });
  canvas.addEventListener('mouseleave', () => { STATE.hoveredIndex = null; tooltip.style.display = 'none'; renderTimelineChart(); });
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
  const chart = chartContext('hourlyBarChart', 260);
  if (!chart) return;
  const { ctx, width } = chart;
  const left = 50, top = 25, chartW = width - 70, chartH = 190;
  const rows = STATE.errors.analytics ? [] : STATE.analytics.campusHourly || [];
  const values = new Map(rows.map(row => [row.hour, numeric(row.avg_occupancy_pct)]));
  const maxY = Math.max(100, Math.ceil(Math.max(0, ...[...values.values()].filter(value => value !== null)) / 25) * 25);
  ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const value = maxY * i / 4, y = top + chartH * (1 - i / 4);
    ctx.strokeStyle = '#273553'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + chartW, y); ctx.stroke();
    ctx.fillStyle = '#94a3b8'; ctx.fillText(`${numberLabel(value)}%`, left - 8, y + 4);
  }
  for (let hour = 0; hour < 24; hour++) {
    const value = values.get(hour), x = left + hour * chartW / 24, barWidth = chartW / 24 * 0.65;
    ctx.textAlign = 'center'; ctx.fillStyle = '#94a3b8';
    if (hour % (chartW < 500 ? 4 : 2) === 0) ctx.fillText(String(hour).padStart(2, '0'), x + barWidth / 2, top + chartH + 20);
    if (value === undefined || value === null) { ctx.fillText('·', x + barWidth / 2, top + chartH - 5); continue; }
    ctx.fillStyle = crowd(value).color;
    ctx.fillRect(x, top + chartH * (1 - value / maxY), barWidth, Math.max(2, value / maxY * chartH));
  }
  if (![...values.values()].some(value => value !== null)) {
    ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'; ctx.fillText('No hourly occupancy readings available', left + chartW / 2, top + chartH / 2);
  }
}

function busReadingsMarkup(bus) {
  const pct = occupancy(bus), level = busCrowd(bus);
  return `<div class="bus-crowd-row"><span class="bus-pax">${numberLabel(bus.ridership)} <small>/ ${numberLabel(bus.capacity)} pax</small></span><span style="color:${level.color}">${percentLabel(pct)}</span></div>
    <div class="progress-bar-bg ${pct === null ? 'is-unknown' : ''}"><div class="progress-bar-fill" style="width:${pct === null ? 0 : Math.max(0, Math.min(100, pct))}%;background-color:${level.color}"></div></div>
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
  $('fleetGrid').innerHTML = buses.map(bus => {
    const status = fleetStatus(bus), active = status === 'active', level = busCrowd(bus);
    const label = status === 'stale' || stale ? 'Stale · Last known reading' : active ? 'Reported in latest pull' : 'Not in latest pull';
    return `<article class="bus-card ${!active || stale ? 'bus-card-inactive' : ''}" data-plate="${escapeHtml(bus.vehplate)}" tabindex="0" role="button" aria-label="Open vehicle dashboard for ${escapeHtml(bus.vehplate)}"><div class="bus-card-top"><span class="bus-route-badge" style="background-color:${routeColor(bus.route_code)}">${escapeHtml(bus.route_code)}</span><span class="bus-plate">${escapeHtml(bus.vehplate)}</span></div><div class="bus-card-status"><span class="badge ${active && !stale ? 'badge-info' : 'badge-secondary'}">${label}</span><span class="badge ${level.badge}">${level.label} occupancy</span></div>${busReadingsMarkup(bus)}${!active ? '<p class="form-hint">Retained observation; current service status unknown.</p>' : ''}<span class="bus-card-click-hint">Click to view bus dashboard →</span></article>`;
  }).join('');
}

// Campus reference locations; these do not describe current service patterns.
const NUS_BUS_STOPS = [
  { name: 'University Town (UTown)', lat: 1.3038, lng: 103.7738 },
  { name: 'NUS Museum', lat: 1.3015, lng: 103.7733 },
  { name: 'Kent Vale', lat: 1.3015, lng: 103.7688 },
  { name: 'Yusof Ishak House (YIH)', lat: 1.2989, lng: 103.7744 },
  { name: 'Opposite YIH', lat: 1.2987, lng: 103.7749 },
  { name: 'Central Library (CLB)', lat: 1.2965, lng: 103.7725 },
  { name: 'Information Technology (IT)', lat: 1.2974, lng: 103.7728 },
  { name: 'Lecture Theatre 13 (LT13)', lat: 1.2944, lng: 103.7712 },
  { name: 'Faculty of Arts (AS5)', lat: 1.2938, lng: 103.7718 },
  { name: 'Business School (BIZ 2)', lat: 1.2934, lng: 103.7749 },
  { name: 'Ventus (Opp LT13)', lat: 1.2952, lng: 103.7709 },
  { name: 'Opp Hon Sui Sen Library', lat: 1.2928, lng: 103.7752 },
  { name: 'Opp NUSS Guild House', lat: 1.2933, lng: 103.7725 },
  { name: 'School of Computing (COM 3)', lat: 1.2941, lng: 103.7758 },
  { name: "Prince George's Park (PGP)", lat: 1.2917, lng: 103.7806 },
  { name: 'Kent Ridge MRT (Exit A)', lat: 1.2949, lng: 103.7845 },
  { name: 'Faculty of Science (LT27)', lat: 1.2974, lng: 103.7811 },
  { name: 'University Health Centre (UHC)', lat: 1.2988, lng: 103.7761 },
  { name: 'Kent Ridge Bus Terminal', lat: 1.2939, lng: 103.7699 }
];

// Road-aligned normal route paths for Kent Ridge campus routes
const NUS_ROUTE_PATHS = {
  A1: [
    [1.29173, 103.78056], [1.29171, 103.78037], [1.2914, 103.7805], [1.29118, 103.78075],
    [1.29112, 103.78099], [1.29127, 103.7817], [1.29196, 103.78318], [1.2916, 103.78353],
    [1.29302, 103.78499], [1.29339, 103.78505], [1.29419, 103.78488], [1.29536, 103.78413],
    [1.29543, 103.78401], [1.29557, 103.78404], [1.29557, 103.78421], [1.29494, 103.78455],
    [1.29439, 103.78493], [1.29423, 103.78486], [1.29536, 103.78413], [1.29543, 103.78401],
    [1.29596, 103.78377], [1.2965, 103.78331], [1.2969, 103.78271], [1.29696, 103.78221],
    [1.29738, 103.78152], [1.29744, 103.7811], [1.29743, 103.78039], [1.29716, 103.77958],
    [1.29713, 103.77909], [1.29763, 103.77768], [1.29809, 103.77706], [1.29866, 103.77658],
    [1.29879, 103.77637], [1.29888, 103.77596], [1.2988, 103.77597], [1.29879, 103.7761],
    [1.2988, 103.77597], [1.29888, 103.77596], [1.2989, 103.77525], [1.29916, 103.77487],
    [1.29891, 103.77486], [1.29873, 103.77497], [1.29891, 103.77486], [1.2992, 103.77482],
    [1.29926, 103.77462], [1.29915, 103.77444], [1.29849, 103.77398], [1.29786, 103.77316],
    [1.29682, 103.77274], [1.29653, 103.77247], [1.29635, 103.7722], [1.29626, 103.77183],
    [1.29627, 103.77091], [1.29588, 103.77087], [1.29506, 103.77058], [1.29478, 103.77098],
    [1.2947, 103.7713], [1.29439, 103.77145], [1.29431, 103.77128], [1.2944, 103.77119],
    [1.29431, 103.77128], [1.29439, 103.77145], [1.2947, 103.7713], [1.29491, 103.77075],
    [1.2941, 103.77094], [1.29372, 103.77151], [1.29366, 103.77171], [1.29381, 103.77176],
    [1.29366, 103.77171], [1.29358, 103.77215], [1.29343, 103.77211], [1.29324, 103.7727],
    [1.29295, 103.77317], [1.29241, 103.77376], [1.29215, 103.77444], [1.2931, 103.7751],
    [1.29333, 103.77517], [1.29343, 103.77491], [1.29333, 103.77517], [1.29363, 103.77526],
    [1.29372, 103.77555], [1.29299, 103.77551], [1.29276, 103.77521], [1.29299, 103.77551],
    [1.29372, 103.77555], [1.29377, 103.77684], [1.29305, 103.77801], [1.29284, 103.77904],
    [1.29212, 103.7802], [1.29171, 103.78037], [1.29173, 103.78056]
  ],
  A2: [
    [1.29173, 103.78056], [1.29171, 103.78037], [1.29212, 103.7802], [1.29284, 103.77904],
    [1.29305, 103.77801], [1.29377, 103.77684], [1.29372, 103.77555], [1.29299, 103.77551],
    [1.29276, 103.77521], [1.29299, 103.77551], [1.29372, 103.77555], [1.29363, 103.77526],
    [1.29333, 103.77517], [1.29343, 103.77491], [1.29333, 103.77517], [1.29288, 103.77498],
    [1.29215, 103.77444], [1.2922, 103.77411], [1.292, 103.77391], [1.29241, 103.77376],
    [1.29268, 103.77348], [1.29308, 103.77298], [1.2933, 103.7725], [1.29308, 103.77298],
    [1.29334, 103.77247], [1.29355, 103.77143], [1.2939, 103.77091], [1.29417, 103.77071],
    [1.29479, 103.77055], [1.29497, 103.77056], [1.29505, 103.77074], [1.29522, 103.77085],
    [1.29505, 103.77074], [1.29509, 103.77058], [1.29588, 103.77087], [1.2964, 103.77094],
    [1.29637, 103.77161], [1.29644, 103.77205], [1.29683, 103.77243], [1.29727, 103.77244],
    [1.29717, 103.77268], [1.29739, 103.77282], [1.29698, 103.77257], [1.29743, 103.7729],
    [1.29789, 103.7731], [1.2986, 103.77398], [1.29918, 103.77435], [1.29957, 103.77448],
    [1.29963, 103.77459], [1.29957, 103.77467], [1.29935, 103.7747], [1.29915, 103.77444],
    [1.29889, 103.77428], [1.29889, 103.77441], [1.29888, 103.7743], [1.29912, 103.77444],
    [1.2992, 103.77461], [1.29909, 103.77484], [1.29916, 103.77487], [1.2989, 103.77525],
    [1.29888, 103.77596], [1.2988, 103.77597], [1.29879, 103.7761], [1.2988, 103.77597],
    [1.29888, 103.77596], [1.29879, 103.77637], [1.29866, 103.77658], [1.29809, 103.77706],
    [1.29768, 103.7776], [1.29713, 103.77909], [1.29716, 103.77958], [1.29749, 103.78068],
    [1.2975, 103.78121], [1.29744, 103.7811], [1.29748, 103.78143], [1.29704, 103.78223],
    [1.29692, 103.783], [1.29619, 103.78373], [1.29557, 103.78421], [1.29494, 103.78455],
    [1.29439, 103.78493], [1.29354, 103.78509], [1.29325, 103.78537], [1.29153, 103.7836],
    [1.29196, 103.78318], [1.29127, 103.7817], [1.29112, 103.78099], [1.29118, 103.78075],
    [1.2914, 103.7805], [1.29171, 103.78037], [1.29173, 103.78056]
  ],
  D1: [
    [1.3039, 103.77394], [1.30365, 103.77411], [1.30328, 103.77409], [1.30288, 103.77389],
    [1.3026, 103.77389], [1.30145, 103.77439], [1.30099, 103.77438], [1.30081, 103.7742],
    [1.30123, 103.77318], [1.30153, 103.77323], [1.30119, 103.77315], [1.30104, 103.77368],
    [1.30074, 103.77427], [1.30022, 103.77456], [1.29941, 103.77471], [1.29889, 103.77428],
    [1.29889, 103.77441], [1.29889, 103.77428], [1.29835, 103.77385], [1.29791, 103.77321],
    [1.29682, 103.77274], [1.29653, 103.77247], [1.29635, 103.7722], [1.29626, 103.77183],
    [1.29627, 103.77091], [1.29588, 103.77087], [1.29506, 103.77058], [1.29478, 103.77098],
    [1.2947, 103.7713], [1.29439, 103.77145], [1.29431, 103.77128], [1.2944, 103.77119],
    [1.29431, 103.77128], [1.29439, 103.77145], [1.2947, 103.7713], [1.29491, 103.77075],
    [1.2941, 103.77094], [1.29372, 103.77151], [1.29366, 103.77171], [1.29381, 103.77176],
    [1.29366, 103.77171], [1.29358, 103.77215], [1.29343, 103.77211], [1.29324, 103.7727],
    [1.29295, 103.77317], [1.29241, 103.77376], [1.29215, 103.77444], [1.2931, 103.7751],
    [1.29333, 103.77517], [1.29343, 103.77491], [1.29333, 103.77517], [1.29363, 103.77526],
    [1.29372, 103.77555], [1.29299, 103.77551], [1.29276, 103.77521], [1.29221, 103.77543],
    [1.2919, 103.77627], [1.29179, 103.77628], [1.29159, 103.77612], [1.29169, 103.77565],
    [1.29221, 103.77425], [1.2922, 103.77411], [1.292, 103.77391], [1.29241, 103.77376],
    [1.29268, 103.77348], [1.29308, 103.77298], [1.2933, 103.7725], [1.29308, 103.77298],
    [1.29334, 103.77247], [1.29355, 103.77143], [1.2939, 103.77091], [1.29417, 103.77071],
    [1.29479, 103.77055], [1.29497, 103.77056], [1.29505, 103.77074], [1.29522, 103.77085],
    [1.29505, 103.77074], [1.29509, 103.77058], [1.29588, 103.77087], [1.2964, 103.77094],
    [1.29637, 103.77161], [1.29644, 103.77205], [1.29683, 103.77243], [1.29727, 103.77244],
    [1.29717, 103.77268], [1.29739, 103.77282], [1.29698, 103.77257], [1.29743, 103.7729],
    [1.29789, 103.7731], [1.29845, 103.77385], [1.2987, 103.77405], [1.29961, 103.77452],
    [1.29957, 103.77467], [1.29873, 103.77497], [1.29891, 103.77486], [1.29916, 103.77487],
    [1.2993, 103.77444], [1.29991, 103.77452], [1.30046, 103.77431], [1.3009, 103.77358],
    [1.30104, 103.77314], [1.30137, 103.77314], [1.30153, 103.77323], [1.30119, 103.77315],
    [1.30104, 103.77368], [1.30078, 103.77414], [1.30099, 103.77438], [1.30145, 103.77439],
    [1.3026, 103.77389], [1.30288, 103.77389], [1.30328, 103.77409], [1.30365, 103.77411],
    [1.3039, 103.77394]
  ],
  D2: [
    [1.3039, 103.77394], [1.30365, 103.77411], [1.30328, 103.77409], [1.30288, 103.77389],
    [1.3026, 103.77389], [1.30145, 103.77439], [1.30099, 103.77438], [1.30081, 103.7742],
    [1.30123, 103.77318], [1.30153, 103.77323], [1.30119, 103.77315], [1.30104, 103.77368],
    [1.30072, 103.77429], [1.30009, 103.77462], [1.29941, 103.77471], [1.29916, 103.77487],
    [1.2989, 103.77525], [1.29888, 103.77596], [1.2988, 103.77597], [1.29879, 103.7761],
    [1.2988, 103.77597], [1.29888, 103.77596], [1.29879, 103.77637], [1.29866, 103.77658],
    [1.29809, 103.77706], [1.29768, 103.7776], [1.29713, 103.77909], [1.29716, 103.77958],
    [1.29749, 103.78068], [1.2975, 103.78121], [1.29744, 103.7811], [1.29748, 103.78143],
    [1.29704, 103.78223], [1.29692, 103.783], [1.29619, 103.78373], [1.29557, 103.78421],
    [1.29494, 103.78455], [1.29439, 103.78493], [1.29354, 103.78509], [1.29325, 103.78537],
    [1.29153, 103.7836], [1.29196, 103.78318], [1.29127, 103.7817], [1.29112, 103.78099],
    [1.29118, 103.78075], [1.2914, 103.7805], [1.29171, 103.78037], [1.29173, 103.78056],
    [1.29171, 103.78037], [1.2914, 103.7805], [1.29118, 103.78075], [1.29112, 103.78099],
    [1.29127, 103.7817], [1.29196, 103.78318], [1.2916, 103.78353], [1.29302, 103.78499],
    [1.29339, 103.78505], [1.29419, 103.78488], [1.29536, 103.78413], [1.29543, 103.78401],
    [1.29557, 103.78404], [1.29557, 103.78421], [1.29494, 103.78455], [1.29439, 103.78493],
    [1.29423, 103.78486], [1.29536, 103.78413], [1.29543, 103.78401], [1.29596, 103.78377],
    [1.2965, 103.78331], [1.2969, 103.78271], [1.29696, 103.78221], [1.29738, 103.78152],
    [1.29744, 103.7811], [1.29743, 103.78039], [1.29716, 103.77958], [1.29713, 103.77909],
    [1.29763, 103.77768], [1.29809, 103.77706], [1.29866, 103.77658], [1.29879, 103.77637],
    [1.29888, 103.77596], [1.2988, 103.77597], [1.29879, 103.7761], [1.2988, 103.77597],
    [1.29888, 103.77596], [1.2989, 103.77525], [1.29916, 103.77487], [1.29891, 103.77486],
    [1.29873, 103.77497], [1.29891, 103.77486], [1.29916, 103.77487], [1.2993, 103.77444],
    [1.29991, 103.77452], [1.30046, 103.77431], [1.3009, 103.77358], [1.30104, 103.77314],
    [1.30137, 103.77314], [1.30153, 103.77323], [1.30119, 103.77315], [1.30104, 103.77368],
    [1.30078, 103.77414], [1.30099, 103.77438], [1.30145, 103.77439], [1.3026, 103.77389],
    [1.30288, 103.77389], [1.30328, 103.77409], [1.30365, 103.77411], [1.3039, 103.77394]
  ],
  E: [
    [1.3039, 103.77394], [1.30365, 103.77411], [1.30328, 103.77409], [1.30288, 103.77389],
    [1.3026, 103.77389], [1.30145, 103.77439], [1.30099, 103.77438], [1.30081, 103.7742],
    [1.30123, 103.77318], [1.30153, 103.77323], [1.30119, 103.77315], [1.30104, 103.77368],
    [1.3007, 103.77431], [1.30009, 103.77462], [1.29935, 103.7747], [1.29915, 103.77444],
    [1.29835, 103.77385], [1.29786, 103.77316], [1.29682, 103.77274], [1.29653, 103.77247],
    [1.29635, 103.7722], [1.29626, 103.77183], [1.29627, 103.77091], [1.29588, 103.77087],
    [1.29518, 103.7706], [1.29506, 103.77058], [1.29491, 103.77075], [1.2941, 103.77094],
    [1.29372, 103.77151], [1.29366, 103.77171], [1.29381, 103.77176], [1.29366, 103.77171],
    [1.29358, 103.77215], [1.29343, 103.77211], [1.29324, 103.7727], [1.29295, 103.77317],
    [1.29241, 103.77376], [1.29215, 103.77444], [1.2931, 103.7751], [1.29333, 103.77517],
    [1.29343, 103.77491], [1.29333, 103.77517], [1.29363, 103.77526], [1.29372, 103.77555],
    [1.29299, 103.77551], [1.29276, 103.77521], [1.29221, 103.77543], [1.2919, 103.77627],
    [1.29179, 103.77628], [1.29159, 103.77612], [1.29169, 103.77565], [1.29221, 103.77425],
    [1.2922, 103.77411], [1.292, 103.77391], [1.29241, 103.77376], [1.29268, 103.77348],
    [1.29308, 103.77298], [1.2933, 103.7725], [1.29308, 103.77298], [1.29334, 103.77247],
    [1.29355, 103.77143], [1.2939, 103.77091], [1.29417, 103.77071], [1.29479, 103.77055],
    [1.29497, 103.77056], [1.29505, 103.77074], [1.29522, 103.77085], [1.29505, 103.77074],
    [1.29509, 103.77058], [1.29588, 103.77087], [1.2964, 103.77094], [1.29637, 103.77161],
    [1.29644, 103.77205], [1.29683, 103.77243], [1.29727, 103.77244], [1.29717, 103.77268],
    [1.29739, 103.77282], [1.29698, 103.77257], [1.29743, 103.7729], [1.29789, 103.7731],
    [1.29845, 103.77385], [1.2987, 103.77405], [1.29961, 103.77452], [1.30007, 103.77449],
    [1.30046, 103.77431], [1.3009, 103.77358], [1.30104, 103.77314], [1.30137, 103.77314],
    [1.30153, 103.77323], [1.30119, 103.77315], [1.30104, 103.77368], [1.30078, 103.77414],
    [1.30099, 103.77438], [1.30145, 103.77439], [1.3026, 103.77389], [1.30288, 103.77389],
    [1.30328, 103.77409], [1.30365, 103.77411], [1.3039, 103.77394]
  ],
  K: [
    [1.29173, 103.78056], [1.29171, 103.78037], [1.2914, 103.7805], [1.29118, 103.78075],
    [1.29112, 103.78099], [1.29127, 103.7817], [1.29196, 103.78318], [1.2916, 103.78353],
    [1.29302, 103.78499], [1.29339, 103.78505], [1.29419, 103.78488], [1.29536, 103.78413],
    [1.29543, 103.78401], [1.29557, 103.78404], [1.29557, 103.78421], [1.29494, 103.78455],
    [1.29439, 103.78493], [1.29423, 103.78486], [1.29536, 103.78413], [1.29543, 103.78401],
    [1.29596, 103.78377], [1.2965, 103.78331], [1.2969, 103.78271], [1.29696, 103.78221],
    [1.29738, 103.78152], [1.29744, 103.7811], [1.29743, 103.78039], [1.29716, 103.77958],
    [1.29713, 103.77909], [1.29763, 103.77768], [1.29809, 103.77706], [1.29866, 103.77658],
    [1.29879, 103.77637], [1.29888, 103.77596], [1.2988, 103.77597], [1.29879, 103.7761],
    [1.2988, 103.77597], [1.29888, 103.77596], [1.2989, 103.77525], [1.29916, 103.77487],
    [1.29891, 103.77486], [1.29873, 103.77497], [1.29891, 103.77486], [1.2992, 103.77482],
    [1.29926, 103.77462], [1.29915, 103.77444], [1.29849, 103.77398], [1.29786, 103.77316],
    [1.29682, 103.77274], [1.29653, 103.77247], [1.29635, 103.7722], [1.29626, 103.77183],
    [1.29627, 103.77091], [1.29588, 103.77087], [1.29506, 103.77058], [1.29478, 103.77098],
    [1.2947, 103.7713], [1.29439, 103.77145], [1.29431, 103.77128], [1.2944, 103.77119],
    [1.29431, 103.77128], [1.29439, 103.77145], [1.2947, 103.7713], [1.29491, 103.77075],
    [1.29506, 103.77058], [1.29518, 103.7706], [1.29511, 103.7704], [1.29472, 103.77037],
    [1.29426, 103.77046], [1.29395, 103.77063], [1.2934, 103.77112], [1.29333, 103.77105],
    [1.29391, 103.77042], [1.29377, 103.77], [1.29403, 103.77035], [1.29443, 103.77022],
    [1.29492, 103.7702], [1.29514, 103.77041], [1.29518, 103.7706], [1.29506, 103.77058],
    [1.29502, 103.77066], [1.29522, 103.77085], [1.29505, 103.77074], [1.29509, 103.77058],
    [1.29588, 103.77087], [1.2964, 103.77094], [1.29637, 103.77161], [1.29644, 103.77205],
    [1.29683, 103.77243], [1.29727, 103.77244], [1.29717, 103.77268], [1.29739, 103.77282],
    [1.29698, 103.77257], [1.29743, 103.7729], [1.29789, 103.7731], [1.2986, 103.77398],
    [1.29918, 103.77435], [1.29957, 103.77448], [1.29963, 103.77459], [1.29957, 103.77467],
    [1.29935, 103.7747], [1.29915, 103.77444], [1.29889, 103.77428], [1.29889, 103.77441],
    [1.29888, 103.7743], [1.29912, 103.77444], [1.2992, 103.77461], [1.29909, 103.77484],
    [1.29916, 103.77487], [1.2989, 103.77525], [1.29888, 103.77596], [1.2988, 103.77597],
    [1.29879, 103.7761], [1.2988, 103.77597], [1.29888, 103.77596], [1.29879, 103.77637],
    [1.29866, 103.77658], [1.29809, 103.77706], [1.29768, 103.7776], [1.29713, 103.77909],
    [1.29716, 103.77958], [1.29749, 103.78068], [1.2975, 103.78121], [1.29744, 103.7811],
    [1.29748, 103.78143], [1.29704, 103.78223], [1.29692, 103.783], [1.29619, 103.78373],
    [1.29557, 103.78421], [1.29494, 103.78455], [1.29439, 103.78493], [1.29354, 103.78509],
    [1.29325, 103.78537], [1.29153, 103.7836], [1.29196, 103.78318], [1.29127, 103.7817],
    [1.29112, 103.78099], [1.29118, 103.78075], [1.2914, 103.7805], [1.29171, 103.78037],
    [1.29173, 103.78056]
  ]
};

const NUS_ROUTE_STOPS = {
  A1: new Set([
    "Prince George's Park (PGP)", 'Kent Ridge MRT (Exit A)', 'Faculty of Science (LT27)',
    'University Health Centre (UHC)', 'Opposite YIH', 'Central Library (CLB)',
    'Lecture Theatre 13 (LT13)', 'Faculty of Arts (AS5)', 'Business School (BIZ 2)',
    'Opp Hon Sui Sen Library'
  ]),
  A2: new Set([
    "Prince George's Park (PGP)", 'Opp Hon Sui Sen Library', 'Business School (BIZ 2)',
    'Opp NUSS Guild House', 'Ventus (Opp LT13)', 'Information Technology (IT)',
    'Yusof Ishak House (YIH)', 'University Health Centre (UHC)',
    'Faculty of Science (LT27)', 'Kent Ridge MRT (Exit A)'
  ]),
  D1: new Set([
    'University Town (UTown)', 'NUS Museum', 'Yusof Ishak House (YIH)',
    'Central Library (CLB)', 'Lecture Theatre 13 (LT13)', 'Faculty of Arts (AS5)',
    'Business School (BIZ 2)', 'Opp Hon Sui Sen Library', 'Opp NUSS Guild House',
    'Ventus (Opp LT13)', 'Information Technology (IT)', 'Opposite YIH'
  ]),
  D2: new Set([
    'University Town (UTown)', 'NUS Museum', 'University Health Centre (UHC)',
    'Faculty of Science (LT27)', 'Kent Ridge MRT (Exit A)', "Prince George's Park (PGP)",
    'Opposite YIH'
  ]),
  E: new Set([
    'University Town (UTown)', 'NUS Museum', 'Central Library (CLB)',
    'Faculty of Arts (AS5)', 'Business School (BIZ 2)', 'Opp Hon Sui Sen Library',
    'Opp NUSS Guild House', 'Ventus (Opp LT13)', 'Information Technology (IT)'
  ]),
  K: new Set([
    "Prince George's Park (PGP)", 'Kent Ridge MRT (Exit A)', 'Faculty of Science (LT27)',
    'University Health Centre (UHC)', 'Opposite YIH', 'Central Library (CLB)',
    'Lecture Theatre 13 (LT13)', 'Kent Ridge Bus Terminal', 'Ventus (Opp LT13)',
    'Information Technology (IT)', 'Yusof Ishak House (YIH)'
  ])
};

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
    const isStopOnRoute = !hasRouteFilter || activeStops.has(stop.name);
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
    const routeStatusHtml = hasRouteFilter
      ? `<p class="map-popup-sub"><span style="color:${routeClr};font-weight:700">Service ${escapeHtml(activeRoute)}</span>: ${isStopOnRoute ? 'Serviced Stop' : 'Not Serviced'}</p>`
      : '<p>Campus reference location</p>';
    marker.bindPopup(`<div class="map-popup-card"><strong>${escapeHtml(stop.name)}</strong>${routeStatusHtml}</div>`);
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
    for (const [code, coords] of Object.entries(NUS_ROUTE_PATHS)) {
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

  renderVehicleDetailMap(bus);
  renderVehicleDetailChart(bus);
  renderVehicleHourlyBarChart(bus);
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
  const routeCoords = NUS_ROUTE_PATHS[routeCode];
  const color = routeColor(routeCode);

  if (!STATE.vehicleDetailMap) {
    STATE.vehicleDetailMap = L.map(container, {
      zoomControl: true,
      attributionControl: false
    });
    if (L.tileLayer) {
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, TomTom',
        maxZoom: 19,
        className: 'map-tiles-dark'
      }).addTo(STATE.vehicleDetailMap);
    }
  }

  STATE.vehicleDetailMap?.invalidateSize?.();

  if (STATE.vehicleRouteTraceGroup) {
    STATE.vehicleDetailMap.removeLayer(STATE.vehicleRouteTraceGroup);
    STATE.vehicleRouteTraceGroup = null;
  }
  if (STATE.vehicleMarker) {
    STATE.vehicleDetailMap.removeLayer(STATE.vehicleMarker);
    STATE.vehicleMarker = null;
  }

  const layers = [];

  if (routeCoords) {
    const glow = L.polyline(routeCoords, {
      color,
      weight: 8,
      opacity: 0.35,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false
    });
    const line = L.polyline(routeCoords, {
      color,
      weight: 3.5,
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
    const isServiced = servicedStops && servicedStops.has(stop.name);
    const stopIcon = L.divIcon({
      className: 'bus-stop-pin-wrapper',
      html: `<div class="bus-stop-pin ${isServiced ? 'active-route-stop' : 'dimmed-route-stop'}" style="--c:${color}" title="${escapeHtml(stop.name)}"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });
    const marker = L.marker([stop.lat, stop.lng], { icon: stopIcon });
    marker.bindPopup?.(`<div class="map-popup-card"><strong>${escapeHtml(stop.name)}</strong><p class="map-popup-sub">${isServiced ? `Serviced by Service ${escapeHtml(routeCode)}` : 'Not on this service route'}</p></div>`);
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
  const chart = chartContext('vehicleTimelineChart', 240);
  if (!chart) return;
  const { canvas, ctx, width, height } = chart;
  const padding = { top: 24, right: 18, bottom: 42, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  if (chartW <= 0 || chartH <= 0) return;

  const rolling = STATE.timeMode === 'rolling';
  const range = STATE.history24h.queryRange || {};
  const start = rolling
    ? Math.floor((range.end || Date.now()) / BUCKET_MS) * BUCKET_MS - 143 * BUCKET_MS
    : new Date(`${STATE.selectedDate}T00:00:00+08:00`).getTime();
  const buckets = Array.from({ length: 144 }, (_, i) => ({
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

  const vehicleValues = Array(144).fill(null);
  const vehicleOccupancies = Array(144).fill(null);
  const routeValues = Array(144).fill(null);
  const routeOccupancies = Array(144).fill(null);

  for (const row of vehicleRows) {
    const idx = Math.floor((row.bucket_ts - start) / BUCKET_MS);
    if (idx >= 0 && idx < 144) {
      vehicleValues[idx] = numeric(row.avg_ridership);
      vehicleOccupancies[idx] = numeric(row.avg_occupancy_pct);
    }
  }

  for (const row of routeRows) {
    const idx = Math.floor((row.bucket_ts - start) / BUCKET_MS);
    if (idx >= 0 && idx < 144) {
      routeValues[idx] = numeric(row.avg_ridership);
      routeOccupancies[idx] = numeric(row.avg_occupancy_pct);
    }
  }

  // Include latest live observation into timeline if not yet in aggregated bucket
  const busLastTime = lastSeen(bus);
  if (busLastTime && busLastTime >= start && busLastTime < start + 144 * BUCKET_MS) {
    const liveIdx = Math.floor((busLastTime - start) / BUCKET_MS);
    if (liveIdx >= 0 && liveIdx < 144 && vehicleOccupancies[liveIdx] === null) {
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

  const xAt = index => padding.left + (index / 143) * chartW;
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

  const step = chartW < 450 ? 48 : 24;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#64748b';
  for (let i = 0; i < 144; i += step) {
    ctx.fillText(formatTime(buckets[i].timestamp), xAt(i), height - 12);
  }
  ctx.textAlign = 'right';
  ctx.fillText(`${formatTime(buckets[143].timestamp)} SGT`, xAt(143), height - 12);

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
  primaryData.forEach((val, i) => {
    if (val === null) return;
    const isHovered = STATE.vehicleHoveredIndex === i;
    const radius = isHovered ? 5.5 : validVehicleData.length < 20 ? 3.5 : 2.5;
    ctx.beginPath();
    ctx.arc(xAt(i), yAt(val), radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  });

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
    canvas.addEventListener('mousemove', event => {
      const meta = canvas._chartMeta;
      if (!meta) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (x < meta.padding.left || x > meta.padding.left + meta.chartW) {
        if (tooltip) tooltip.style.display = 'none';
        STATE.vehicleHoveredIndex = null;
        const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                    STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
        if (bus) renderVehicleDetailChart(bus);
        return;
      }
      const index = Math.max(0, Math.min(143, Math.round(((x - meta.padding.left) / meta.chartW) * 143)));
      STATE.vehicleHoveredIndex = index;
      const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                  STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
      if (bus) renderVehicleDetailChart(bus);

      if (tooltip) {
        const primary = meta.primaryData[index];
        const baseline = meta.baselineData[index];
        const timeLabel = meta.buckets[index]?.label || '';
        const unit = meta.metric === 'crowd' ? '%' : ' pax';
        tooltip.style.display = 'block';
        tooltip.style.left = `${Math.min(x + 12, meta.chartW - 40)}px`;
        tooltip.style.top = '20px';
        tooltip.innerHTML = `<strong>${escapeHtml(timeLabel)} SGT</strong>` +
          (primary !== null ? `<div class="tooltip-row"><span style="color:${meta.color}">Bus ${escapeHtml(meta.plate)}</span><span>${numberLabel(primary)}${unit}</span></div>` : `<div>No reading for ${escapeHtml(meta.plate)}</div>`) +
          (baseline !== null ? `<div class="tooltip-row"><span style="color:#94a3b8">Route ${escapeHtml(meta.routeCode)} Avg</span><span>${numberLabel(baseline)}${unit}</span></div>` : '');
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (tooltip) tooltip.style.display = 'none';
      STATE.vehicleHoveredIndex = null;
      const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                  STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
      if (bus) renderVehicleDetailChart(bus);
    });
  }

  const hourlyCanvas = $('vehicleHourlyBarChart');
  const hourlyTooltip = $('vehicleHourlyTooltip');
  if (hourlyCanvas) {
    hourlyCanvas.addEventListener('mousemove', event => {
      const meta = hourlyCanvas._hourlyMeta;
      if (!meta) return;
      const rect = hourlyCanvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (x < meta.padding.left || x > meta.padding.left + meta.chartW) {
        if (hourlyTooltip) hourlyTooltip.style.display = 'none';
        STATE.vehicleHourlyHoveredIndex = null;
        const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                    STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
        if (bus) renderVehicleHourlyBarChart(bus);
        return;
      }
      const hour = Math.max(0, Math.min(23, Math.floor((x - meta.padding.left) / meta.slotW)));
      STATE.vehicleHourlyHoveredIndex = hour;
      const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                  STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
      if (bus) renderVehicleHourlyBarChart(bus);

      if (hourlyTooltip) {
        const val = meta.hourlyValues[hour];
        const count = meta.hourlyCounts[hour];
        const timeLabel = `${String(hour).padStart(2, '0')}:00 - ${String(hour).padStart(2, '0')}:59 SGT`;
        hourlyTooltip.style.display = 'block';
        hourlyTooltip.style.left = `${Math.min(x + 12, meta.chartW - 60)}px`;
        hourlyTooltip.style.top = '15px';
        hourlyTooltip.innerHTML = `<strong>${escapeHtml(timeLabel)}</strong>` +
          (val !== null ? `<div class="tooltip-row"><span style="color:${crowd(val).color}">Bus ${escapeHtml(meta.plate)}</span><span>${numberLabel(val)}% (${count} reading${count === 1 ? '' : 's'})</span></div>` : `<div>No readings for ${escapeHtml(meta.plate)}</div>`);
      }
    });

    hourlyCanvas.addEventListener('mouseleave', () => {
      if (hourlyTooltip) hourlyTooltip.style.display = 'none';
      STATE.vehicleHourlyHoveredIndex = null;
      const bus = STATE.allFleet.find(b => b.vehplate === STATE.selectedVehiclePlate) ||
                  STATE.liveBuses.find(b => b.vehplate === STATE.selectedVehiclePlate);
      if (bus) renderVehicleHourlyBarChart(bus);
    });
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
    ['fleetStatusGroup', 'fleetStatus', 'fleetStatusFilter', renderFleetGrid], ['viewToggleGroup', 'view', 'currentView', renderTimelineChart]
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

async function pollUnivusApi() {
  if (STATE.polling) return;
  STATE.polling = true;
  renderStatus();
  try {
    const data = await requestJson('/api/cron');
    showAction(`Live collection complete: ${numberLabel(data.recordsCount ?? data.polledCount)} vehicle readings.`);
  } catch {
    // Background polling updates status silently
  } finally {
    STATE.polling = false;
    if (STATE.refreshPromise) await STATE.refreshPromise;
    await refreshAllData();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs(); setupFilters(); setupActionButtons(); setupChartInteractivity(); setupVehicleDashboardInteractivity();
  await refreshAllData();
  if (telemetryStale()) {
    void pollUnivusApi();
  }
  // Automatically poll uNivUS API every 10 minutes in JavaScript without authentication
  setInterval(() => { if (!document.hidden) pollUnivusApi(); }, 10 * 60 * 1000);
  setInterval(() => { if (!document.hidden) refreshAllData(); }, 30000);
  setInterval(() => { if (!document.hidden) { renderCountdown(); if (telemetryStale()) { renderStatus(); renderSummaryCards(); } } }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAllData(); });
});
