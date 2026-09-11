import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-10T16:05:00Z');
const INTERVAL = 10 * 60 * 1000;

function canvasContext() {
  const records = { paths: [], dots: [], text: [], rectangles: [] };
  let currentPath = [];
  const ctx = {
    records,
    scale() {}, setLineDash() {}, clearRect() {},
    beginPath() { currentPath = []; },
    moveTo(x, y) { currentPath.push({ operation: 'move', x, y }); },
    lineTo(x, y) { currentPath.push({ operation: 'line', x, y }); },
    stroke() { records.paths.push({ color: this.strokeStyle, points: [...currentPath] }); },
    arc(x, y, radius) { records.dots.push({ x, y, radius }); },
    fill() {},
    fillText(text, x, y) { records.text.push({ text: String(text), x, y }); },
    fillRect(x, y, width, height) { records.rectangles.push({ x, y, width, height }); }
  };
  return ctx;
}

function dashboard() {
  const elements = new Map();
  const contexts = new Map();
  for (const [, id] of html.matchAll(/\bid=["']([^"']+)["']/g)) {
    const listeners = new Map();
    const classes = new Set();
    const element = {
      id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, hidden: false,
      disabled: false, parentElement: { clientWidth: 1100 }, offsetWidth: 240, offsetHeight: 120,
      classList: {
        toggle(name, enabled) { if (enabled ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
        add(name) { classes.add(name); }, remove(name) { classes.delete(name); }
      },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      async dispatch(type, event = {}) {
        for (const listener of listeners.get(type) || []) {
          await listener({ target: element, preventDefault() {}, ...event });
        }
      },
      setAttribute(name, value) { this[name] = value; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 1072, height: 420 }; },
      getContext() {
        if (!contexts.has(id)) contexts.set(id, canvasContext());
        return contexts.get(id);
      }
    };
    elements.set(id, element);
  }
  const markers = [];
  const leaflet = {
    divIcon(options) { return options; },
    marker(location, { icon }) {
      const marker = {
        location, icon,
        addTo() { markers.push(this); return this; },
        bindPopup(popup) { this.popup = popup; return this; },
        setLatLng(value) { this.location = value; return this; },
        setIcon(value) { this.icon = value; return this; },
        setPopupContent(value) { this.popup = value; return this; }
      };
      return marker;
    }
  };
  class FixedDate extends Date {
    constructor(...values) { super(...(values.length ? values : [NOW])); }
    static now() { return NOW; }
  }
  const sandbox = {
    Date: FixedDate, Intl, console, AbortController,
    setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {},
    document: {
      hidden: false,
      getElementById(id) { return elements.get(id) ?? null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    },
    window: { devicePixelRatio: 1, addEventListener() {} },
    L: leaflet,
    fetch: async () => { throw new Error('Unexpected browser network request'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(app + `\n;globalThis.dashboard = {
    STATE, renderTimelineChart, renderHourlyBarChart, renderSummaryCards,
    renderFleetGrid, renderMapBuses, renderRouteFilters, renderStatus,
    formatLocalDate, formatTime, setupActionButtons, setupFilters,
    setupChartInteractivity, fetchHistory24h
  };`, sandbox, { filename: 'public/app.js' });
  return {
    ...sandbox.dashboard, sandbox, markers,
    element: id => { assert.ok(elements.has(id), `Expected DOM element ${id}`); return elements.get(id); },
    drawing: id => contexts.get(id)?.records
  };
}

function bus(overrides = {}) {
  return {
    vehplate: 'TEST-VEHICLE', route_code: 'A1', status: 'active',
    timestamp: NOW, last_seen_at: NOW, lat: 1.296, lng: 103.776,
    occupancy: null, ridership: null, capacity: null, speed: null,
    ...overrides
  };
}

function reportedFleet(ui, buses, { stale = false } = {}) {
  ui.STATE.status = { hasToken: true, canPoll: true, requiresToken: false, authMode: 'guest', tokenSource: 'guest', connectionState: 'healthy', lastPolledAt: NOW, isStale: stale };
  ui.STATE.live = { lastPolledAt: NOW, activeCount: buses.length, knownFleetCount: buses.length, inactiveCount: 0, isStale: stale };
  ui.STATE.liveBuses = buses;
  ui.STATE.allFleet = buses;
}

test('empty and null-only timeline views show missing readings without drawing invented observations', () => {
  for (const currentView of ['exact', 'occupancy', 'crowd']) {
    const ui = dashboard();
    ui.STATE.currentView = currentView;
    ui.STATE.history24h = {
      queryRange: { end: NOW }, routeData: [],
      campusData: [{ bucket_ts: Math.floor(NOW / INTERVAL) * INTERVAL, avg_ridership: null, avg_occupancy_pct: null }]
    };
    assert.doesNotThrow(ui.renderTimelineChart);
    const drawing = ui.drawing('timelineChart');
    assert.equal(drawing.dots.length, 0);
    assert.ok(drawing.text.some(item => /No reported readings/.test(item.text)));
    assert.match(ui.element('chartDescription').textContent, /0 plotted readings/);
  }
});

test('timeline draws measured zero and breaks the line at missing intervals', () => {
  const ui = dashboard();
  const end = Math.floor(NOW / INTERVAL) * INTERVAL;
  ui.STATE.history24h = { queryRange: { end: NOW }, routeData: [], campusData: [
    { bucket_ts: end - 4 * INTERVAL, avg_ridership: 0, avg_occupancy_pct: null },
    { bucket_ts: end - 3 * INTERVAL, avg_ridership: 10, avg_occupancy_pct: null },
    { bucket_ts: end - 2 * INTERVAL, avg_ridership: null, avg_occupancy_pct: null },
    { bucket_ts: end, avg_ridership: 20, avg_occupancy_pct: null }
  ] };
  ui.renderTimelineChart();
  const drawing = ui.drawing('timelineChart');
  assert.equal(drawing.dots.length, 3, 'Zero is an observed point; null is not');
  const dataPaths = drawing.paths.filter(path => path.points.length >= 3);
  assert.equal(dataPaths.length, 1);
  assert.deepEqual(dataPaths[0].points.map(point => point.operation), ['move', 'line', 'move']);
  assert.ok(drawing.dots.every(dot => Number.isFinite(dot.x) && Number.isFinite(dot.y)));
});

test('hourly occupancy chart distinguishes unmeasured hours from measured zero', () => {
  const ui = dashboard();
  ui.STATE.analytics = { campusHourly: [
    { hour: 8, avg_occupancy_pct: null }, { hour: 9, avg_occupancy_pct: 0 }, { hour: 10, avg_occupancy_pct: 50 }
  ] };
  ui.renderHourlyBarChart();
  const drawing = ui.drawing('hourlyBarChart');
  assert.equal(drawing.rectangles.length, 2, 'Only measured hours draw bars');
  assert.ok(drawing.rectangles.every(rect => rect.height > 0), 'Measured zero remains visible');
  assert.ok(drawing.text.some(item => item.text === '·'), 'Missing hours remain marked as missing');
});

test('summary cards distinguish no feed, unknown occupancy, and measured empty buses', () => {
  const ui = dashboard();
  ui.renderSummaryCards();
  assert.equal(ui.element('statActiveBuses').textContent, 'Unknown');
  reportedFleet(ui, [bus()]);
  ui.renderSummaryCards();
  assert.equal(ui.element('statCampusCrowd').textContent, 'Unknown');
  assert.match(ui.element('statCampusAvgOccupancy').textContent, /not been reported/);
  reportedFleet(ui, [bus({ occupancy: 0, ridership: 0 })]);
  ui.renderSummaryCards();
  assert.equal(ui.element('statCampusCrowd').textContent, 'Low');
  assert.match(ui.element('statCampusAvgOccupancy').textContent, /0% average/);
  reportedFleet(ui, []);
  ui.renderSummaryCards();
  assert.equal(ui.element('statActiveBuses').textContent, '0 / 0');
  assert.equal(ui.element('statCampusCrowd').textContent, 'Unknown');
});

test('stale fleet cards, summaries, and map markers visibly describe last known observations', () => {
  const ui = dashboard();
  reportedFleet(ui, [bus({ occupancy: 0.9, ridership: 63, capacity: 70 })], { stale: true });
  ui.STATE.leafletMap = { removeLayer() {} };
  ui.renderFleetGrid(); ui.renderSummaryCards(); ui.renderMapBuses();
  assert.match(ui.element('fleetGrid').innerHTML, /Last known|Stale/i);
  assert.doesNotMatch(ui.element('fleetGrid').innerHTML, /Reported in latest pull/);
  assert.match(ui.element('statActiveBusesSubtext').textContent, /Last known/i);
  assert.match(ui.element('mapDataMessage').textContent, /Last known/i);
  assert.equal(ui.markers.length, 1);
  assert.match(ui.markers[0].icon.html, /is-stale/);
  assert.match(ui.markers[0].popup, /Last known/i);
});

test('retained stale vehicles never appear as currently reported buses', () => {
  const ui = dashboard();
  reportedFleet(ui, []);
  ui.STATE.allFleet = [bus({ status: 'stale', timestamp: NOW - 3600000, last_seen_at: NOW - 3600000 })];
  ui.STATE.live.knownFleetCount = 1;
  ui.renderFleetGrid();
  const markup = ui.element('fleetGrid').innerHTML;
  assert.doesNotMatch(markup, /Reported in latest pull/);
  assert.match(markup, /unknown|Stale|Last known/i);
  assert.match(markup, /23:05/, 'Historical last-seen timestamp is shown in Singapore time');
});

test('provider text is escaped in fleet cards, map icons, tooltips, and route filters', async () => {
  const ui = dashboard();
  const route = '<svg onload="alert(1)">';
  const plate = '"><img src=x onerror="alert(1)">';
  reportedFleet(ui, [bus({ route_code: route, vehplate: plate, occupancy: 0.5 })]);
  ui.STATE.routesMeta = { [route]: { color: 'red;position:fixed' } };
  ui.STATE.leafletMap = { removeLayer() {} };
  ui.renderFleetGrid(); ui.renderMapBuses(); ui.renderRouteFilters();
  const end = Math.floor(NOW / INTERVAL) * INTERVAL;
  ui.STATE.history24h = { queryRange: { end: NOW }, campusData: [], routeData: [
    { route_code: route, bucket_ts: end, avg_ridership: null, avg_occupancy_pct: 50 }
  ] };
  ui.renderTimelineChart(); ui.setupChartInteractivity();
  await ui.element('timelineChart').dispatch('mousemove', { clientX: 1048, clientY: 200 });
  for (const markup of [
    ui.element('fleetGrid').innerHTML, ui.element('routeFilterPills').innerHTML,
    ui.element('chartTooltip').innerHTML, ui.markers[0].icon.html, ui.markers[0].popup
  ]) {
    assert.doesNotMatch(markup, /<img\b|<svg\b|position:fixed/);
    assert.match(markup, /&lt;(?:svg|img)/);
  }
});

test('dashboard date controls and chart labels use Singapore time across UTC midnight', () => {
  const ui = dashboard();
  assert.equal(ui.formatLocalDate(new Date(NOW)), '2026-09-11');
  assert.equal(ui.formatTime(NOW), '00:05');
  ui.STATE.timeMode = 'date';
  ui.STATE.selectedDate = '2026-09-11';
  ui.renderTimelineChart();
  assert.match(ui.element('panelTimelineSubtitle').textContent, /11 Sept.*00:00.*23:50.*SGT/);
  assert.ok(ui.drawing('timelineChart').text.some(item => item.text === '00:00'));
});

test('blank token submission leaves credentials unchanged and performs no request', async () => {
  const ui = dashboard();
  let calls = 0;
  ui.sandbox.fetch = async () => { calls++; throw new Error('Unexpected request'); };
  ui.setupActionButtons();
  ui.element('inputToken').value = '   ';
  await ui.element('settingsForm').dispatch('submit');
  assert.equal(calls, 0);
  assert.match(ui.element('actionMessage').textContent, /current access settings have not changed/i);
});

test('automatic guest access enables collection before any manual token or cached session exists', () => {
  const ui = dashboard();
  ui.STATE.status = {
    hasToken: false, canPoll: true, requiresToken: false, authMode: 'guest',
    tokenSource: 'guest', connectionState: 'pending', lastPolledAt: 0
  };
  ui.renderStatus();
  assert.equal(ui.element('btnPollNow').disabled, false);
  assert.equal(ui.element('btnSettingsPollNow').disabled, false);
  assert.match(ui.element('connectionMessage').textContent, /Automatic guest access/i);
  assert.match(ui.element('diagToken').textContent, /Automatic guest access/i);
  assert.doesNotMatch(ui.element('pollerCountdown').textContent, /Awaiting live token/i);
});

test('public arrivals source enables token-free collection and discloses monitored-stop coverage beside counts', () => {
  const ui = dashboard();
  reportedFleet(ui, [bus({ occupancy: 0.5 })]);
  ui.STATE.status = { ...ui.STATE.status, hasToken: false, authMode: 'public', tokenSource: 'none',
    dataProvider: 'community', coverage: 'stop-arrivals', sourceUrl: 'https://bus.hewliyang.com/',
    monitoredStops: ['UTOWN', 'KR-MRT'], coverageNote: 'Arriving vehicles at monitored stops only.' };
  ui.renderStatus(); ui.renderSummaryCards();
  assert.equal(ui.element('btnPollNow').disabled, false);
  assert.equal(ui.element('btnSettingsPollNow').disabled, false);
  assert.equal(ui.element('sourceLink').href, 'https://bus.hewliyang.com/');
  assert.match(ui.element('sourceLink').textContent, /community feed/);
  assert.match(ui.element('coverageSummary').textContent, /monitored stops only.*UTOWN, KR-MRT/);
  assert.match(ui.element('statActiveBusesSubtext').textContent, /Stop-arrival coverage/);
  assert.match(ui.element('connectionMessage').textContent, /at monitored stops/);
  assert.match(ui.element('diagToken').textContent, /No token required/);
  assert.equal(ui.element('diagTokenExpiry').textContent, 'Not applicable');
});

test('direct uNivUS source shows configured-route coverage, daily guest renewal, and reported GPS positions', () => {
  const ui = dashboard();
  const vehicle = bus({ occupancy: 0.5, ridership: 30, capacity: 60, lat: 1.3038, lng: 103.7738 });
  reportedFleet(ui, [vehicle]);
  ui.STATE.status = { ...ui.STATE.status, dataProvider: 'univus', coverage: 'route-fleet',
    sourceUrl: 'https://univus.nus.edu.sg/', monitoredStops: [],
    coverageNote: 'Vehicles reported directly by uNivUS for the configured routes.',
    tokenExpiresAt: null, sessionRenewAt: new Date(NOW + 86400000 - 15 * 60000).toISOString() };
  ui.STATE.leafletMap = { removeLayer() {} };
  ui.renderStatus(); ui.renderSummaryCards(); ui.renderMapBuses();
  assert.equal(ui.element('sourceLink').textContent, 'uNivUS (direct)');
  assert.equal(ui.element('sourceLink').href, 'https://univus.nus.edu.sg/');
  assert.match(ui.element('coverageSummary').textContent, /configured routes/);
  assert.doesNotMatch(ui.element('coverageSummary').textContent, /monitored stops/i);
  assert.doesNotMatch(ui.element('statActiveBusesSubtext').textContent, /Stop-arrival coverage/);
  assert.match(ui.element('connectionMessage').textContent, /uNivUS live feed connected/);
  assert.match(ui.element('diagToken').textContent, /Automatic guest access.*Daily renewal/);
  assert.match(ui.element('diagTokenExpiry').textContent, /Renews by 11 Sept.*23:50.*SGT/);
  assert.equal(ui.element('diagSessionTimingLabel').textContent, 'Guest session:');
  assert.doesNotMatch(ui.element('diagTokenExpiry').textContent, /expir|unknown/i);
  assert.match(ui.element('feedConfigurationText').textContent, /directly from uNivUS/);
  assert.doesNotMatch(ui.element('feedConfigurationText').textContent, /community|fallback/i);
  assert.equal(ui.element('providerWarning').hidden, true);
  assert.equal(ui.markers.length, 1);
  assert.equal(ui.markers[0].location[0], vehicle.lat);
  assert.equal(ui.markers[0].location[1], vehicle.lng);
  assert.match(ui.markers[0].popup, /50%/);
  assert.doesNotMatch(ui.element('mapDataMessage').textContent, /monitored-stop/);
  ui.STATE.status.sourceUrl = 'https://univus.nus.edu.sg.evil.example/';
  ui.renderStatus();
  assert.equal(ui.element('sourceLink').href, 'https://univus.nus.edu.sg/', 'Only the exact trusted provider URL is used');
});

test('guest renewal remains distinct from the community fallback data source and its warning', () => {
  const ui = dashboard();
  reportedFleet(ui, [bus()]);
  ui.STATE.status = { ...ui.STATE.status, dataProvider: 'community', coverage: 'stop-arrivals',
    sourceUrl: 'https://bus.hewliyang.com/', monitoredStops: ['UTOWN', 'KR-MRT'],
    providerWarning: 'Direct ConnectX access is unavailable; using community arrivals.', tokenExpiresAt: NOW + 86400000 };
  ui.renderStatus();
  assert.match(ui.element('sourceLink').textContent, /community feed/);
  assert.match(ui.element('diagToken').textContent, /Automatic guest access.*Daily renewal/);
  assert.match(ui.element('diagTokenExpiry').textContent, /12 Sept.*00:05.*SGT/);
  assert.equal(ui.element('providerWarning').hidden, false);
  assert.equal(ui.element('providerWarning').textContent, ui.STATE.status.providerWarning);
  assert.match(ui.element('feedConfigurationText').textContent, /guest access renews daily/);
  assert.equal(ui.element('btnPollNow').disabled, false);
});

test('source links reject unexpected targets and direct-feed errors remain visibly failed', () => {
  const ui = dashboard();
  ui.STATE.status = { hasToken: false, canPoll: true, authMode: 'guest', tokenSource: 'guest',
    dataProvider: 'connectx', coverage: 'route-fleet', sourceUrl: 'javascript:alert(1)',
    coverageNote: '<img src=x onerror=alert(1)>', connectionState: 'error', lastError: 'Provider returned application error 4' };
  ui.renderStatus();
  assert.equal(ui.element('sourceLink').href, 'https://fms.connectx.com.sg');
  assert.equal(ui.element('coverageSummary').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(ui.element('coverageSummary').innerHTML, '', 'Provider coverage is assigned as text, never HTML');
  assert.match(ui.element('connectionBanner').className, /is-error/);
  assert.match(ui.element('connectionMessage').textContent, /application error 4/);
  assert.doesNotMatch(ui.element('connectionMessage').textContent, /connected|returned no vehicles/i);
  assert.equal(ui.element('btnPollNow').disabled, false);
});

test('removing a manual override restores automatic guest access while preserving current source attribution', async () => {
  const ui = dashboard();
  reportedFleet(ui, []);
  ui.STATE.status.authMode = 'manual';
  ui.STATE.status.tokenSource = 'stored';
  const requests = [];
  ui.sandbox.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/settings') {
      ui.STATE.status = { ...ui.STATE.status, authMode: 'guest', tokenSource: 'guest', hasToken: false, connectionState: 'pending', dataProvider: 'community', coverage: 'stop-arrivals' };
      return { ok: true, status: 200, json: async () => ({ success: true, authMode: 'guest' }) };
    }
    const payload = url === '/api/status' ? ui.STATE.status : url === '/api/live' ? { ...ui.STATE.live, buses: [], allFleet: [] }
      : url.startsWith('/api/history') ? { routeData: [], campusData: [], availableDates: [] } : {};
    return { ok: true, status: 200, json: async () => payload };
  };
  ui.setupActionButtons();
  await ui.element('btnRemoveToken').dispatch('click');
  assert.equal(requests[0].url, '/api/settings');
  assert.deepEqual(JSON.parse(requests[0].options.body), { fms_token: '' });
  assert.match(ui.element('actionMessage').textContent, /automatic guest access/i);
  assert.doesNotMatch(ui.element('actionMessage').textContent, /fallback/i);
  assert.match(ui.element('diagToken').textContent, /Automatic guest access/i);
  assert.match(ui.element('diagSource').textContent, /community feed/i);
  assert.equal(ui.element('btnPollNow').disabled, false);
});

test('failed manual collection displays its error and sends the administrator credential only on the mutation', async () => {
  const ui = dashboard();
  reportedFleet(ui, []);
  ui.STATE.adminToken = 'browser-admin-token';
  const requests = [];
  ui.sandbox.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/poll-now') return { ok: false, status: 502, json: async () => ({ success: false, error: 'Provider unavailable' }) };
    const payload = url === '/api/status' ? ui.STATE.status : url === '/api/live' ? { ...ui.STATE.live, buses: [], allFleet: [] }
      : url.startsWith('/api/history') ? { routeData: [], campusData: [], availableDates: [] } : {};
    return { ok: true, status: 200, json: async () => payload };
  };
  ui.setupActionButtons();
  await ui.element('btnPollNow').dispatch('click');
  assert.match(ui.element('actionMessage').textContent, /Collection failed: Provider unavailable/);
  assert.match(ui.element('actionMessage').className, /is-error/);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer browser-admin-token');
  assert.ok(requests.slice(1).every(request => request.options.headers.Authorization === undefined));
  assert.equal(ui.element('btnPollNow').disabled, false, 'Poll control is restored after a failure');
});
