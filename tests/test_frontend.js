import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-10T16:05:00Z');
const INTERVAL = 1 * 60 * 1000;

function canvasContext() {
  const records = { paths: [], dots: [], text: [], rectangles: [] };
  let currentPath = [];
  const ctx = {
    records,
    scale() {}, setLineDash() {}, clearRect() {},
    save() {}, restore() {}, rect() {}, clip() {},
    beginPath() { currentPath = []; },
    moveTo(x, y) { currentPath.push({ operation: 'move', x, y }); },
    lineTo(x, y) { currentPath.push({ operation: 'line', x, y }); },
    stroke() { records.paths.push({ color: this.strokeStyle, points: [...currentPath] }); },
    arc(x, y, radius) { records.dots.push({ x, y, radius }); },
    fill() {},
    fillText(text, x, y) { records.text.push({ text: String(text), x, y }); },
    fillRect(x, y, width, height) { records.rectangles.push({ x, y, width, height }); },
    strokeRect(x, y, width, height) { records.rectangles.push({ stroke: true, x, y, width, height }); }
  };
  return ctx;
}

function dashboard() {
  const elements = new Map();
  const contexts = new Map();
  const documentListeners = new Map();
  for (const [, id] of html.matchAll(/\bid=["']([^"']+)["']/g)) {
    const listeners = new Map();
    const classes = new Set();
    const element = {
      id, innerHTML: '', textContent: '', value: '',
      style: {
        setProperty(name, value) { this[name] = value; },
        removeProperty(name) { delete this[name]; }
      },
      dataset: {}, hidden: false,
      disabled: false, parentElement: { clientWidth: 1100 }, offsetWidth: 240, offsetHeight: 120,
      classList: {
        toggle(name, enabled) { if (enabled ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
        add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      click() { return this.dispatch('click'); },
      async dispatch(type, event = {}) {
        for (const listener of listeners.get(type) || []) {
          await listener({ target: element, preventDefault() {}, ...event });
        }
      },
      closest() { return this; },
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
  const polylines = [];
  const layerGroups = [];
  let mapInstance = null;
  const leaflet = {
    divIcon(options) { return options; },
    marker(location, { icon } = {}) {
      const marker = {
        location, icon,
        addTo() { markers.push(this); return this; },
        bindPopup(popup) { this.popup = popup; return this; },
        setLatLng(value) { this.location = value; return this; },
        setIcon(value) { this.icon = value; return this; },
        setPopupContent(value) { this.popup = value; return this; },
        on(event, handler) { this._events = this._events || {}; this._events[event] = handler; return this; },
        isPopupOpen() { return this._popupOpen || false; },
        openPopup() { this._popupOpen = true; if (this._events?.popupopen) this._events.popupopen(); return this; }
      };
      return marker;
    },
    polyline(latlngs, options = {}) {
      const poly = {
        latlngs, options,
        addTo() { polylines.push(this); return this; },
        bindTooltip(tooltip, opts) { this.tooltip = tooltip; this.tooltipOpts = opts; return this; },
        getBounds() { return { isValid() { return true; } }; }
      };
      polylines.push(poly);
      return poly;
    },
    layerGroup(layers = []) {
      const group = {
        layers: [...layers],
        addTo() { layerGroups.push(this); return this; },
        clearLayers() {
          if (mapInstance) {
            for (const l of this.layers) mapInstance.removeLayer(l);
          }
          this.layers = [];
          return this;
        }
      };
      return group;
    },
    map() {
      mapInstance = {
        center: null, zoom: null,
        setView(c, z) { this.center = c; this.zoom = z; return this; },
        fitBounds(b, opts) { this.bounds = b; this.fitBoundsOpts = opts; return this; },
        removeLayer(l) {
          if (Array.isArray(l?.layers)) {
            for (const child of [...l.layers]) this.removeLayer(child);
          }
          const mIdx = markers.indexOf(l);
          if (mIdx !== -1) markers.splice(mIdx, 1);
          const pIdx = polylines.indexOf(l);
          if (pIdx !== -1) polylines.splice(pIdx, 1);
          const gIdx = layerGroups.indexOf(l);
          if (gIdx !== -1) layerGroups.splice(gIdx, 1);
          return this;
        },
        invalidateSize() { return this; }
      };
      return mapInstance;
    },
    tileLayer() {
      return { on() { return this; }, addTo() { return this; } };
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
      addEventListener(type, listener) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push(listener);
      },
      async dispatch(type, event = {}) {
        for (const listener of documentListeners.get(type) || []) {
          await listener({ preventDefault() {}, ...event });
        }
      }
    },
    window: { devicePixelRatio: 1, addEventListener() {} },
    L: leaflet,
    fetch: async () => { throw new Error('Unexpected browser network request'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(app + `\n;globalThis.dashboard = {
    STATE, renderTimelineChart, renderHourlyBarChart, renderSummaryCards,
    renderFleetGrid, renderMapBuses, renderRouteFilters, renderStatus,
    initLeafletMap, renderBusStopsOnMap, renderRouteTraceOnMap,
    formatLocalDate, formatTime, setupActionButtons, setupFilters, setupTabs,
    setupChartInteractivity, fetchHistory24h,
    openVehicleDashboard, closeVehicleDashboard, renderVehicleDetailMap,
    renderVehicleDetailChart, setupVehicleDashboardInteractivity,
    smoothSeries, inactiveReason, nearestTerminal, positionChartTooltip,
    getDistanceToStop, getServicedRoutesForStop, isBusApproachingOrAtStop,
    getBusesNearStop, renderStopPopupHtml, renderVehicleStopProgression,
    updateMapStopSelectDropdown, updateTimelineVehicleDropdown, fetchStopEtas,
    promptSetStopCrowd, recordVehicleStopCrowd, updateLiveStopsCrowdReadings,
    processSnapshotsIntoStopCrowd, calculateBearing, angleDifference, getVehicleBearing,
    updateVehicleMovement, resolveVehicleRouteProgression,
    navigateTimeline, zoomTimeline, resetTimelineZoom, getCachedTimelineSeries
  };`, sandbox, { filename: 'public/app.js' });
  return {
    ...sandbox.dashboard, sandbox, markers, polylines, layerGroups,
    get mapInstance() { return mapInstance; },
    element: id => { assert.ok(elements.has(id), `Expected DOM element ${id}`); return elements.get(id); },
    drawing: id => contexts.get(id)?.records,
    dispatchDocument: (type, event) => sandbox.document.dispatch(type, event)
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
  for (const currentView of ['exact', 'crowd']) {
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
  ui.STATE.smoothing = 'raw';
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

test('smoothSeries reduces variance and bridges isolated single gaps while keeping multi-interval downtime null', () => {
  const ui = dashboard();
  const noisy = [10, 60, 10, 50, 10];
  const smoothed = ui.smoothSeries(noisy);
  assert.equal(smoothed[1], 35.0, 'Peak 60 dampened to weighted average 35.0');
  assert.equal(smoothed[2], 32.5, 'Trough 10 smoothed to 32.5');

  // Single gap bridging
  const singleGap = [20, null, 40];
  const bridged = ui.smoothSeries(singleGap);
  assert.ok(bridged[1] !== null, 'Isolated single gap is bridged');
  assert.equal(bridged[1], 30.0);

  // Multi-interval downtime (e.g. overnight) is preserved as null
  const overnight = [25, null, null, null, 30];
  const overnightSmoothed = ui.smoothSeries(overnight);
  assert.equal(overnightSmoothed[1], null);
  assert.equal(overnightSmoothed[2], null);
  assert.equal(overnightSmoothed[3], null);
});

test('smoothing toggle button switches between smoothed and raw view modes', async () => {
  const ui = dashboard();
  ui.setupFilters();
  const end = Math.floor(NOW / INTERVAL) * INTERVAL;
  ui.STATE.history24h = { queryRange: { end: NOW }, routeData: [], campusData: [
    { bucket_ts: end - 2 * INTERVAL, avg_ridership: 10, avg_occupancy_pct: null },
    { bucket_ts: end - 1 * INTERVAL, avg_ridership: null, avg_occupancy_pct: null },
    { bucket_ts: end, avg_ridership: 30, avg_occupancy_pct: null }
  ] };

  // Default is smoothed
  assert.equal(ui.STATE.smoothing, 'smoothed');
  ui.renderTimelineChart();
  assert.match(ui.element('panelTimelineSubtitle').textContent, /30-minute rolling average/);

  // Switch to raw
  await ui.element('smoothingToggleGroup').dispatch('click', {
    target: {
      dataset: { smoothing: 'raw' },
      closest: selector => selector === 'button' ? { dataset: { smoothing: 'raw' } } : null
    }
  });
  assert.equal(ui.STATE.smoothing, 'raw');
  assert.match(ui.element('panelTimelineSubtitle').textContent, /1-minute intervals/);

  // Switch back to smoothed
  await ui.element('smoothingToggleGroup').dispatch('click', {
    target: {
      dataset: { smoothing: 'smoothed' },
      closest: selector => selector === 'button' ? { dataset: { smoothing: 'smoothed' } } : null
    }
  });
  assert.equal(ui.STATE.smoothing, 'smoothed');
  assert.match(ui.element('panelTimelineSubtitle').textContent, /30-minute rolling average/);
});

test('timeline chart scales responsively and avoids X-axis label collision on mobile', async () => {
  const ui = dashboard();
  const canvas = ui.element('timelineChart');
  canvas.parentElement.clientWidth = 340; // Mobile viewport
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 312, height: 240 });
  ui.renderTimelineChart();

  // Canvas height scales down to 240 on mobile instead of fixed 420
  assert.equal(canvas.style.height, '240px');

  // Verify X-axis labels drawn
  const drawing = ui.drawing('timelineChart');
  const timeLabels = drawing.text.filter(t => /\b\d{2}:\d{2}\b/.test(t.text));
  assert.ok(timeLabels.length >= 3, 'Multiple time labels rendered on mobile');

  // Verify distance between adjacent labels is >= 50px to guarantee no collision
  timeLabels.sort((a, b) => a.x - b.x);
  for (let i = 1; i < timeLabels.length; i++) {
    const gap = timeLabels[i].x - timeLabels[i - 1].x;
    assert.ok(gap >= 50, `Adjacent labels "${timeLabels[i-1].text}" and "${timeLabels[i].text}" have gap ${gap}px >= 50px`);
  }

  // Test touch interaction
  ui.setupChartInteractivity();
  await canvas.dispatch('touchstart', {
    touches: [{ clientX: 100, clientY: 100 }]
  });
  assert.ok(ui.STATE.hoveredIndex !== null, 'Touchstart sets hoveredIndex');
  assert.equal(ui.element('chartTooltip').style.display, 'block', 'Touchstart reveals tooltip');

  await canvas.dispatch('touchend');
  assert.equal(ui.STATE.hoveredIndex, null, 'Touchend resets hoveredIndex');
  assert.equal(ui.element('chartTooltip').style.display, 'none', 'Touchend hides tooltip');
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
  assert.match(ui.element('panelTimelineSubtitle').textContent, /11 Sept.*00:00.*23:59.*SGT/);
  assert.ok(ui.drawing('timelineChart').text.some(item => item.text === '00:00'));
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

test('selecting a specific route filter traces out the route path on the Leaflet map with active stop highlights', () => {
  const ui = dashboard();
  reportedFleet(ui, [
    bus({ vehplate: 'PC1234A', route_code: 'A1', lat: 1.2917, lng: 103.7806 }),
    bus({ vehplate: 'PC5678B', route_code: 'D1', lat: 1.3038, lng: 103.7738 })
  ]);
  ui.initLeafletMap();
  assert.ok(ui.polylines.length >= 12, 'Default map load traces all routes across campus');

  // Switch to route A1
  ui.STATE.mapRouteFilter = 'A1';
  ui.renderMapBuses();

  // Polyline trace should be added (inner line + outer glow)
  assert.ok(ui.polylines.length >= 2, 'Route polylines should be created for A1');
  const innerLine = ui.polylines.find(p => p.options.weight === 3.5);
  assert.ok(innerLine, 'Inner polyline exists');
  assert.equal(innerLine.options.color, '#FB0101', 'Uses A1 official red color');
  assert.match(innerLine.tooltip, /Service A1/);

  // Stops served by A1 should be active, others dimmed
  const activeStops = ui.markers.filter(m => typeof m.icon?.html === 'string' && m.icon.html.includes('active-route-stop'));
  const dimmedStops = ui.markers.filter(m => typeof m.icon?.html === 'string' && m.icon.html.includes('dimmed-route-stop'));
  assert.ok(activeStops.length > 0, 'Serviced stops are highlighted');
  assert.ok(dimmedStops.length > 0, 'Non-serviced stops are dimmed');

  // Legend trace indicator should be shown
  assert.equal(ui.element('legendRouteTrace').hidden, false);
  assert.match(ui.element('legendRouteName').textContent, /Service A1 path/);
  assert.match(ui.element('mapDataMessage').textContent, /Traced normal route path for A1/);
});

test('switching map route filter back to all traces all routes across campus and restores standard stop pins', () => {
  const ui = dashboard();
  reportedFleet(ui, [bus({ vehplate: 'PC1234A', route_code: 'A1', lat: 1.2917, lng: 103.7806 })]);
  ui.initLeafletMap();

  ui.STATE.mapRouteFilter = 'A1';
  ui.renderMapBuses();
  assert.ok(ui.STATE.routeTraceGroup !== null);

  // Switch back to 'all'
  ui.STATE.mapRouteFilter = 'all';
  ui.renderMapBuses();
  assert.ok(ui.STATE.routeTraceGroup !== null, 'Route trace group exists for all routes');
  assert.ok(ui.polylines.length >= 12, 'All campus routes (A1, A2, D1, D2, E, K) are traced');
  assert.equal(ui.element('legendRouteTrace').hidden, true);
  assert.match(ui.element('mapDataMessage').textContent, /All campus routes traced/);

  // All stop pins should be standard pins (neither active nor dimmed)
  const nonStandardStops = ui.markers.filter(m => typeof m.icon?.html === 'string' && (m.icon.html.includes('active-route-stop') || m.icon.html.includes('dimmed-route-stop')));
  assert.equal(nonStandardStops.length, 0);
});

test('openVehicleDashboard populates telemetry details, route badge, and displays modal', () => {
  const ui = dashboard();
  const testBus = bus({
    vehplate: 'PD658S',
    route_code: 'A1',
    lat: 1.2965,
    lng: 103.7725,
    speed: 25,
    occupancy: 0.16,
    ridership: 14,
    capacity: 88,
    timestamp: NOW
  });
  reportedFleet(ui, [testBus]);

  ui.openVehicleDashboard('PD658S');

  assert.equal(ui.element('vehicleDashboardModal').hidden, false);
  assert.equal(ui.STATE.selectedVehiclePlate, 'PD658S');
  assert.equal(ui.element('vehicleModalTitle').textContent, 'PD658S');
  assert.equal(ui.element('vehicleModalRouteBadge').textContent, 'A1');
  assert.match(ui.element('vehicleModalSubtitle').textContent, /Service A1 · Telemetry & 24-Hour Crowd Analytics/);
  assert.match(ui.element('vehicleMetricRoute').textContent, /Service A1/);
  assert.match(ui.element('vehicleMetricCrowd').textContent, /Low \(16%\)/);
  assert.match(ui.element('vehicleMetricRidership').textContent, /14 \/ 88 pax/);
  assert.match(ui.element('vehicleMetricSpeed').textContent, /25 km\/h/);
  assert.match(ui.element('vehicleMetricGps').textContent, /1\.2965, 103\.7725/);
});

test('openVehicleDashboard initializes vehicle map and traces route path with pulsing marker', () => {
  const ui = dashboard();
  const testBus = bus({
    vehplate: 'PD964H',
    route_code: 'A2',
    lat: 1.2989,
    lng: 103.7744,
    speed: 18,
    occupancy: 0.85,
    ridership: 75,
    capacity: 88,
    timestamp: NOW
  });
  reportedFleet(ui, [testBus]);

  ui.openVehicleDashboard('PD964H');

  assert.ok(ui.STATE.vehicleDetailMap !== null, 'Vehicle detail map instance initialized');
  assert.ok(ui.STATE.vehicleMarker !== null, 'Vehicle marker created');
  assert.ok(ui.STATE.vehicleRouteTraceGroup !== null, 'Route trace group created for bus route');
  assert.ok(ui.polylines.length >= 2, 'Route polyline drawn (glow + main line)');
  assert.match(ui.STATE.vehicleMarker.icon.html, /PD964H/);
  assert.match(ui.STATE.vehicleMarker.icon.className, /bus-marker-detail-pulsing/);
});

test('openVehicleDashboard renders 24-hour crowd analytics chart with peak and avg stats', () => {
  const ui = dashboard();
  const testBus = bus({
    vehplate: 'PD788A',
    route_code: 'D1',
    lat: 1.295,
    lng: 103.778,
    occupancy: 0.45,
    ridership: 36,
    capacity: 80,
    timestamp: NOW
  });
  reportedFleet(ui, [testBus]);

  const bucketTs = Math.floor(NOW / INTERVAL) * INTERVAL;
  ui.STATE.history24h = {
    queryRange: { end: NOW },
    routeData: [
      { bucket_ts: bucketTs, route_code: 'D1', avg_ridership: 40, avg_occupancy_pct: 50 },
      { bucket_ts: bucketTs - INTERVAL, route_code: 'D1', avg_ridership: 60, avg_occupancy_pct: 75 }
    ],
    vehicleData: [
      { bucket_ts: bucketTs, vehplate: 'PD788A', route_code: 'D1', avg_ridership: 36, avg_occupancy_pct: 45, sample_count: 1 }
    ],
    campusData: [
      { bucket_ts: bucketTs, avg_ridership: 30, avg_occupancy_pct: 40 }
    ]
  };

  ui.openVehicleDashboard('PD788A');

  const records = ui.drawing('vehicleTimelineChart');
  assert.ok(records !== undefined, 'Canvas drawing context accessed');
  assert.ok(records.paths.length > 0, 'Paths drawn on vehicle timeline chart');
  assert.match(ui.element('vehicleStatPeak').textContent, /Peak:/);
  assert.match(ui.element('vehicleStatAvg').textContent, /24h Bus Avg:/);
  assert.match(ui.element('vehicleStatActiveCount').textContent, /Observed: 1 interval/);
});

test('openVehicleDashboard renders observed hourly occupancy bar chart and stats', () => {
  const ui = dashboard();
  const testBus = bus({
    vehplate: 'PD658S',
    route_code: 'A1',
    occupancy: 0.60,
    ridership: 48,
    capacity: 80,
    timestamp: NOW
  });
  reportedFleet(ui, [testBus]);

  const bucketTs = Math.floor(NOW / INTERVAL) * INTERVAL;
  ui.STATE.history24h = {
    queryRange: { end: NOW },
    routeData: [],
    vehicleData: [
      { bucket_ts: bucketTs, vehplate: 'PD658S', route_code: 'A1', avg_ridership: 48, avg_occupancy_pct: 60, sample_count: 1 }
    ],
    campusData: []
  };

  ui.openVehicleDashboard('PD658S');

  const hourlyRecords = ui.drawing('vehicleHourlyBarChart');
  assert.ok(hourlyRecords !== undefined, 'Hourly canvas drawing context accessed');
  assert.ok(hourlyRecords.rectangles.length > 0, 'Hourly bars drawn for vehicle');
  assert.match(ui.element('vehicleHourlyPeak').textContent, /Peak Hour:/);
  assert.match(ui.element('vehicleHourlyAvg').textContent, /Active Avg:/);
  assert.match(ui.element('vehicleHourlyActiveHours').textContent, /Operating: 1 of 24 hrs/);
});

test('closeVehicleDashboard hides modal and resets selected vehicle plate', () => {
  const ui = dashboard();
  reportedFleet(ui, [bus({ vehplate: 'PD778D', route_code: 'D2' })]);

  ui.openVehicleDashboard('PD778D');
  assert.equal(ui.element('vehicleDashboardModal').hidden, false);
  assert.equal(ui.STATE.selectedVehiclePlate, 'PD778D');

  ui.closeVehicleDashboard();
  assert.equal(ui.element('vehicleDashboardModal').hidden, true);
  assert.equal(ui.STATE.selectedVehiclePlate, null);
});

test('setupVehicleDashboardInteractivity allows toggling metrics between crowd and pax', async () => {
  const ui = dashboard();
  reportedFleet(ui, [bus({ vehplate: 'PD658S', route_code: 'A1' })]);
  ui.openVehicleDashboard('PD658S');
  ui.setupVehicleDashboardInteractivity();

  assert.equal(ui.STATE.vehicleDetailMetric, 'crowd');

  await ui.element('btnVehicleMetricPax').dispatch('click');
  assert.equal(ui.STATE.vehicleDetailMetric, 'exact');
  assert.equal(ui.element('btnVehicleMetricPax').classList.contains('active'), true);

  await ui.element('btnVehicleMetricCrowd').dispatch('click');
  assert.equal(ui.STATE.vehicleDetailMetric, 'crowd');
});

test('setupVehicleDashboardInteractivity jump buttons change filters and switch tabs', async () => {
  const ui = dashboard();
  reportedFleet(ui, [bus({ vehplate: 'PD658S', route_code: 'A1' })]);
  ui.openVehicleDashboard('PD658S');
  ui.setupVehicleDashboardInteractivity();

  // Jump to map
  await ui.element('btnVehicleJumpToMap').dispatch('click');
  assert.equal(ui.element('vehicleDashboardModal').hidden, true);
  assert.equal(ui.STATE.mapRouteFilter, 'A1');
  assert.equal(ui.STATE.mapBusFilter, 'PD658S');

  // Re-open and jump to analytics
  ui.openVehicleDashboard('PD658S');
  await ui.element('btnVehicleJumpToAnalytics').dispatch('click');
  assert.equal(ui.element('vehicleDashboardModal').hidden, true);
  assert.ok(ui.STATE.activeRoutes.has('A1'));
});

test('btnCloseBanner dismisses the connection banner alert', async () => {
  const ui = dashboard();
  ui.setupActionButtons();
  assert.equal(ui.element('connectionBanner').hidden, false);

  await ui.element('btnCloseBanner').dispatch('click');
  assert.equal(ui.element('connectionBanner').hidden, true);
});

test('chkMapRouteHighlights toggles route trace polylines on the map', async () => {
  const ui = dashboard();
  ui.setupFilters();
  ui.initLeafletMap();
  assert.ok(ui.polylines.length >= 12, 'Route polylines present by default');

  // Toggle off
  await ui.element('checkShowRouteHighlights').dispatch('change', { target: { checked: false } });
  assert.equal(ui.STATE.mapShowHighlights, false);
  assert.equal(ui.polylines.length, 0, 'Route polylines removed when unchecked');

  // Toggle back on
  await ui.element('checkShowRouteHighlights').dispatch('change', { target: { checked: true } });
  assert.equal(ui.STATE.mapShowHighlights, true);
  assert.ok(ui.polylines.length >= 12, 'Route polylines restored when checked');
});

test('dashboard DOM, navigation, labels, and browser script stay consistent', () => {
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML element IDs must be unique');

  const referencedIds = [...app.matchAll(/(?:getElementById|\$|setText)\(['"]([^'"]+)['"]/g)].map(match => match[1]);
  for (const id of referencedIds) assert.ok(ids.includes(id), `Missing application element: ${id}`);

  const tabs = [...html.matchAll(/data-tab=["']([^"']+)["']/g)].map(match => match[1]);
  assert.ok(tabs.length >= 4, 'History, map, analytics, and fleet views remain available');
  for (const tab of tabs) assert.ok(ids.includes(tab), `Missing tab panel: ${tab}`);
  for (const id of ['timelineChart', 'hourlyBarChart', 'leafletMap']) {
    assert.ok(ids.includes(id), `Missing chart or map: ${id}`);
  }
  for (const id of ['sourceLink', 'coverageSummary', 'providerWarning', 'diagTokenExpiry']) {
    assert.ok(ids.includes(id), `Missing source, coverage, or renewal disclosure: ${id}`);
  }
  assert.ok(html.indexOf('id="coverageSummary"') < html.indexOf('id="statActiveBuses"'), 'Source coverage is disclosed beside the dashboard counts');
  assert.doesNotMatch(html, /Reported \/ Known Fleet|Campus Hourly Occupancy/, 'Count and chart labels describe observed vehicles');
  for (const match of html.matchAll(/<label\b[^>]*\bfor=["']([^"']+)["']/g)) {
    assert.ok(ids.includes(match[1]), `Label refers to missing input: ${match[1]}`);
  }
  assert.ok(/leaflet[^"']*\.css/.test(html), 'The map stylesheet is loaded');
  assert.ok(/leaflet[^"']*\.js/.test(html), 'The map script is loaded');
  assert.ok(/_vercel\/insights\/script\.js/.test(html), 'Vercel Analytics script is loaded');
  assert.ok(/_vercel\/speed-insights\/script\.js/.test(html), 'Vercel Speed Insights script is loaded');
  assert.doesNotThrow(() => new vm.Script(app, { filename: 'public/app.js' }), 'Browser script parses');
});

test('inactiveReason correctly diagnoses parked, booster, turnaround, overnight, route, and signal gap reasons', () => {
  const ui = dashboard();

  // 1. Overnight shutdown (>5h elapsed or late night)
  const overnightBus = bus({
    vehplate: 'PD964H', route_code: 'A1',
    last_seen_at: Date.parse('2026-09-10T15:20:00Z') // 23:20 SGT
  });
  const overnightRes = ui.inactiveReason(overnightBus, Date.parse('2026-09-11T02:10:00Z'));
  assert.equal(overnightRes.type, 'overnight');
  assert.match(overnightRes.title, /Overnight shutdown/);

  // 2. Peak-hour route window closed (R1 or R2 >= 20m elapsed)
  const peakRouteBus = bus({
    vehplate: 'PD660J', route_code: 'R1',
    last_seen_at: Date.parse('2026-09-11T00:20:00Z') // 08:20 SGT
  });
  const peakRouteRes = ui.inactiveReason(peakRouteBus, Date.parse('2026-09-11T02:10:00Z'));
  assert.equal(peakRouteRes.type, 'peak_route');
  assert.match(peakRouteRes.detail, /peak lecture transition/);

  // 3. Completed trip & parked at terminal (0 pax, near COM3)
  const parkedBus = bus({
    vehplate: 'PC3957P', route_code: 'D1',
    lat: 1.294431, lng: 103.775217, speed: 0, ridership: 0, occupancy: 0,
    last_seen_at: Date.parse('2026-09-11T01:50:00Z') // 09:50 SGT
  });
  const parkedRes = ui.inactiveReason(parkedBus, Date.parse('2026-09-11T02:10:00Z'));
  assert.equal(parkedRes.type, 'parked');
  assert.match(parkedRes.detail, /COM 3/);

  // 4. Peak booster shift ended (tail of morning rush 09:35 - 10:20 SGT with high load)
  const boosterBus = bus({
    vehplate: 'PD1022U', route_code: 'A1',
    lat: 1.296, lng: 103.776, speed: 20, ridership: 45, occupancy: 0.75,
    last_seen_at: Date.parse('2026-09-11T01:51:00Z') // 09:51 SGT
  });
  const boosterRes = ui.inactiveReason(boosterBus, Date.parse('2026-09-11T02:10:00Z'));
  assert.equal(boosterRes.type, 'peak_booster');
  assert.match(boosterRes.detail, /Morning lecture rush concluded/);

  // 5. Short turnaround layover (<=25m elapsed at terminal)
  const turnaroundBus = bus({
    vehplate: 'PD629B', route_code: 'A1',
    lat: 1.294536, lng: 103.77, speed: 0, ridership: 10, occupancy: 0.15,
    last_seen_at: Date.parse('2026-09-11T02:00:00Z') // 10:00 SGT (10m ago)
  });
  const turnaroundRes = ui.inactiveReason(turnaroundBus, Date.parse('2026-09-11T02:10:00Z'));
  assert.equal(turnaroundRes.type, 'turnaround');
  assert.match(turnaroundRes.detail, /Kent Ridge Bus Terminal/);

  // 6. Transponder signal gap mid-route (recently active, moving at speed in transit)
  const movingBus = bus({
    vehplate: 'PD516T', route_code: 'A2',
    lat: 1.298, lng: 103.774, speed: 33, ridership: 20, occupancy: 0.33,
    last_seen_at: Date.parse('2026-09-11T02:00:00Z') // 10:00 SGT (10m ago)
  });
  const movingRes = ui.inactiveReason(movingBus, Date.parse('2026-09-11T02:10:00Z'));
  assert.equal(movingRes.type, 'signal_gap');
  assert.match(movingRes.detail, /33 km\/h/);
});

test('renderFleetGrid and vehicle dashboard modal display inactive reasons', () => {
  const ui = dashboard();
  const testBus = bus({
    vehplate: 'PC3957P', route_code: 'D1', status: 'stale',
    lat: 1.294431, lng: 103.775217, speed: 0, ridership: 0, occupancy: 0,
    last_seen_at: NOW - 3600000
  });
  ui.STATE.allFleet = [testBus];
  ui.renderFleetGrid();

  const gridHtml = ui.element('fleetGrid').innerHTML;
  assert.match(gridHtml, /bus-inactive-reason/);
  assert.match(gridHtml, /Overnight shutdown \/ past shift/);
  assert.match(gridHtml, /Service concluded for the night/);

  // Open modal for inactive bus
  ui.openVehicleDashboard('PC3957P');
  const banner = ui.element('vehicleModalInactiveBanner');
  assert.equal(banner.hidden, false);
  assert.match(banner.innerHTML, /Overnight shutdown \/ past shift/);
  assert.match(banner.className, /reason-overnight/);

  // Active bus hides the inactive banner
  const activeBus = bus({
    vehplate: 'PD888Z', route_code: 'A1', status: 'active',
    last_seen_at: NOW
  });
  ui.STATE.allFleet = [testBus, activeBus];
  ui.STATE.liveBuses = [activeBus];
  ui.openVehicleDashboard('PD888Z');
  assert.equal(banner.hidden, true);
});

test('chart tooltips flip and clamp inside container view when hovering near right edge', async () => {
  const ui = dashboard();
  const testBus = bus({
    vehplate: 'PD760D', route_code: 'D2', status: 'active',
    last_seen_at: '2026-09-14T10:30:00+08:00'
  });
  ui.STATE.allFleet = [testBus];
  ui.STATE.liveBuses = [testBus];

  // Open modal which renders charts and sets up interactivity
  ui.openVehicleDashboard('PD760D');
  ui.setupVehicleDashboardInteractivity();

  const canvas = ui.element('vehicleTimelineChart');
  const tooltip = ui.element('vehicleChartTooltip');
  const hourlyCanvas = ui.element('vehicleHourlyBarChart');
  const hourlyTooltip = ui.element('vehicleHourlyTooltip');

  // Configure container geometry
  canvas.parentElement = { clientWidth: 540, clientHeight: 240 };
  canvas.offsetWidth = 512;
  canvas.offsetHeight = 220;
  canvas.offsetLeft = 14;
  canvas.offsetTop = 14;
  canvas.getBoundingClientRect = () => ({ left: 14, top: 14, width: 512, height: 220 });

  tooltip.offsetWidth = 180;
  tooltip.offsetHeight = 60;

  // Simulate hover near right edge (e.g. clientX: 500, near 10:30 SGT)
  await canvas.dispatch('mousemove', { clientX: 500, clientY: 100 });
  assert.equal(tooltip.style.display, 'block');

  const leftValue = parseInt(tooltip.style.left, 10);
  assert.ok(!isNaN(leftValue), 'tooltip.style.left should be numeric');
  // Tooltip must flip to the left of pointerX (500) and fit within parent width (540)
  assert.ok(leftValue + tooltip.offsetWidth <= 540 - 8, `Right edge (${leftValue + tooltip.offsetWidth}px) must be <= 532px within 540px view`);
  assert.ok(leftValue < 500 - 14, `Tooltip should be placed to the left of pointer (got ${leftValue}px, pointer at 500px)`);
  assert.ok(leftValue >= 8, `Tooltip left (${leftValue}px) must be >= 8px`);

  // Simulate hover near left edge (e.g. clientX: 60)
  await canvas.dispatch('mousemove', { clientX: 60, clientY: 100 });
  const leftEdgeValue = parseInt(tooltip.style.left, 10);
  assert.ok(leftEdgeValue >= 60, 'Tooltip on left edge should be placed to the right of pointer');
  assert.ok(leftEdgeValue + tooltip.offsetWidth <= 540 - 8, 'Tooltip on left edge should stay in view');

  // Verify vehicleHourlyTooltip also flips and stays in view
  hourlyCanvas.parentElement = { clientWidth: 540, clientHeight: 140 };
  hourlyCanvas.offsetWidth = 512;
  hourlyCanvas.offsetHeight = 120;
  hourlyCanvas.offsetLeft = 14;
  hourlyCanvas.offsetTop = 14;
  hourlyCanvas.getBoundingClientRect = () => ({ left: 14, top: 14, width: 512, height: 120 });
  hourlyTooltip.offsetWidth = 180;
  hourlyTooltip.offsetHeight = 50;

  await hourlyCanvas.dispatch('mousemove', { clientX: 480, clientY: 50 });
  assert.equal(hourlyTooltip.style.display, 'block');
  const hourlyLeft = parseInt(hourlyTooltip.style.left, 10);
  assert.ok(hourlyLeft + hourlyTooltip.offsetWidth <= 540 - 8, `Hourly tooltip right edge (${hourlyLeft + hourlyTooltip.offsetWidth}px) must stay within 540px`);
  assert.ok(hourlyLeft < 480, 'Hourly tooltip should flip to left of pointer when near right edge');

  // Also test positionChartTooltip directly with edge clamping
  const testTip = { style: {}, offsetWidth: 200, offsetHeight: 60 };
  const testCanvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
    parentElement: { clientWidth: 300, clientHeight: 200 },
    offsetLeft: 0, offsetTop: 0
  };
  ui.positionChartTooltip(testTip, testCanvas, 290, 50);
  const clampedPos = parseInt(testTip.style.left, 10);
  assert.ok(clampedPos + 200 <= 300 - 8, 'Extreme right edge pointer clamps within narrow container');
  assert.ok(clampedPos >= 8, 'Extreme right edge pointer maintains minimum left margin');
});

test('per-bus-stop crowd data, progression cards, stop selection, and arrival popups', async () => {
  const ui = dashboard();
  const utownStop = { name: 'University Town (UTown)', code: 'UTOWN', lat: 1.303876, lng: 103.774621 };
  const museumStop = { name: 'NUS Museum', code: 'MUSEUM', lat: 1.301081, lng: 103.77369 };

  // 1. Distance and proximity detection
  const distSame = ui.getDistanceToStop(utownStop.lat, utownStop.lng, utownStop.lat, utownStop.lng);
  assert.equal(Math.round(distSame), 0, 'Distance to identical coordinates should be 0');

  const distNear = ui.getDistanceToStop(1.3039, 103.7746, utownStop.lat, utownStop.lng);
  assert.ok(distNear < 100, `Close coordinate should be < 100m, got ${distNear}`);

  // Test bus right at UTown stop
  const busAtUtown = {
    vehplate: 'PC1234A', route_code: 'D1', ridership: 45, capacity: 60,
    occupancy: 0.75, lat: 1.303876, lng: 103.774621, speed: 0,
    last_seen_epoch_ms: NOW
  };
  const proxAt = ui.isBusApproachingOrAtStop(busAtUtown, utownStop);
  assert.equal(proxAt.isAtStop, true, 'Bus at stop coordinates should report isAtStop: true');
  assert.equal(proxAt.isApproaching, false);

  // Test bus 300m away approaching UTown stop
  // Roughly 300m south
  const busApproaching = {
    vehplate: 'PC5678B', route_code: 'D1', ridership: 12, capacity: 60,
    occupancy: 0.20, lat: 1.3012, lng: 103.7737, speed: 25,
    last_seen_epoch_ms: NOW
  };
  const proxAppr = ui.isBusApproachingOrAtStop(busApproaching, utownStop);
  assert.equal(proxAppr.isAtStop, false);
  assert.equal(proxAppr.isApproaching, true, 'Bus ~300m away should report isApproaching: true');

  // 2. Serviced routes for stop
  const utownRoutes = ui.getServicedRoutesForStop('UTOWN', 'University Town (UTown)');
  assert.ok(utownRoutes.includes('D1'), 'UTown should be serviced by D1');
  assert.ok(utownRoutes.includes('D2'), 'UTown should be serviced by D2');
  assert.ok(utownRoutes.includes('E'), 'UTown should be serviced by E');

  // 3. Stop popup rendering with buses and ETAs
  ui.STATE.liveBuses = [busAtUtown, busApproaching];
  const popupHtml = ui.renderStopPopupHtml(utownStop);
  assert.ok(popupHtml.includes('University Town (UTown)'), 'Popup should display stop title');
  assert.ok(popupHtml.includes('PC1234A'), 'Popup should list bus at stop');
  assert.ok(popupHtml.includes('At Stop'), 'Popup should indicate At Stop status');
  assert.ok(popupHtml.includes('PC5678B'), 'Popup should list approaching bus');
  assert.ok(popupHtml.includes('Approaching'), 'Popup should indicate Approaching status');
  assert.ok(popupHtml.includes('45 pax'), 'Popup should display ridership for arriving bus');
  assert.ok(popupHtml.includes('btn-open-bus-dashboard'), 'Popup should include quick action to inspect dashboard');

  // Fallback when no buses are approaching
  ui.STATE.liveBuses = [];
  const emptyPopupHtml = ui.renderStopPopupHtml(utownStop);
  assert.ok(emptyPopupHtml.includes('No buses currently approaching this stop'), 'Popup displays clean fallback when no buses are active');

  // Stop popup with live API ETAs
  const mockEtas = {
    busStopName: 'University Town',
    timings: [
      { name: 'D1', arrivalTime: 'Arr', arrivalTime_veh_plate: 'PC1234A', nextArrivalTime: '8', nextArrivalTime_veh_plate: 'PC9999Z' },
      { name: 'D2', arrivalTime: '4', arrivalTime_veh_plate: 'PC8888Y', nextArrivalTime: '12', nextArrivalTime_veh_plate: null }
    ]
  };
  const etaPopupHtml = ui.renderStopPopupHtml(utownStop, mockEtas);
  assert.ok(etaPopupHtml.includes('PC8888Y'), 'Popup displays live ETA vehicle plate');
  assert.ok(etaPopupHtml.includes('4 min'), 'Popup displays scheduled arrival minutes');

  // 4. Vehicle Stop Progression Card rendering
  ui.STATE.liveBuses = [busAtUtown];
  ui.renderVehicleStopProgression(busAtUtown);
  const progList = ui.sandbox.document.getElementById('vehicleStopProgressionList');
  assert.ok(progList.innerHTML.includes('stop-progression-card'), 'Renders stop progression cards');
  assert.ok(progList.innerHTML.includes('📍 At Stop'), 'Marks current stop with At Stop badge');
  assert.ok(progList.innerHTML.includes('45 / 60 pax'), 'Shows bus crowd occupancy along route progression');
  assert.ok(ui.sandbox.document.getElementById('vehicleStopsTotalCount').textContent.includes('stops'), 'Displays total stop count');
  assert.ok(ui.sandbox.document.getElementById('vehicleStopsCurrentNearest').textContent.includes('University Town'), 'Identifies nearest stop');

  // 5. Dropdown selectors
  ui.STATE.allFleet = [busAtUtown, busApproaching];
  ui.updateMapStopSelectDropdown();
  const selectStop = ui.sandbox.document.getElementById('selectMapStop');
  assert.ok(selectStop.innerHTML.includes('University Town (UTown)'), 'Bus stop dropdown contains campus bus stops');

  ui.updateTimelineVehicleDropdown();
  const selectVeh = ui.sandbox.document.getElementById('selectTimelineVehicle');
  assert.ok(selectVeh.innerHTML.includes('PC1234A'), 'Timeline vehicle dropdown lists vehicle plate');
  assert.ok(selectVeh.innerHTML.includes('PC5678B'), 'Timeline vehicle dropdown lists vehicle plate');

  // 6. Interactive full analytics jump with vehicle filter
  ui.setupVehicleDashboardInteractivity();
  ui.STATE.selectedVehiclePlate = 'PC1234A';
  const jumpBtn = ui.sandbox.document.getElementById('btnVehicleJumpToAnalytics');
  assert.ok(jumpBtn, 'Jump to analytics button exists');
  await jumpBtn.dispatch('click');
  assert.equal(ui.STATE.selectedTimelineVehicle, 'PC1234A', 'Jump to analytics sets selectedTimelineVehicle');
});

test('observed hourly occupancy and vehicle hourly charts display hover stats in tooltips', async () => {
  const ui = dashboard();
  ui.STATE.analytics = {
    campusHourly: [
      { hour: 8, avg_occupancy_pct: 64.2, avg_ridership: 38.5, sample_count: 15, occupancy_sample_count: 15, crowd_level: 'medium' },
      { hour: 14, avg_occupancy_pct: 82.0, avg_ridership: 49.2, sample_count: 22, occupancy_sample_count: 22, crowd_level: 'high' }
    ]
  };

  ui.renderHourlyBarChart();
  const canvas = ui.sandbox.document.getElementById('hourlyBarChart');
  const tooltip = ui.sandbox.document.getElementById('hourlyChartTooltip');
  assert.ok(canvas, 'hourlyBarChart canvas exists');
  assert.ok(tooltip, 'hourlyChartTooltip element exists');
  assert.ok(canvas._hourlyMeta, 'canvas._hourlyMeta is populated');

  ui.setupChartInteractivity();

  // Simulate mousemove over hour 8
  const meta = canvas._hourlyMeta;
  const targetX = meta.left + 8 * meta.slotW + meta.slotW / 2;
  await canvas.dispatch('mousemove', { clientX: targetX, clientY: 100 });

  assert.equal(ui.STATE.campusHourlyHoveredIndex, 8, 'campusHourlyHoveredIndex should be hour 8');
  assert.equal(tooltip.style.display, 'block', 'Tooltip should be visible');
  assert.ok(tooltip.innerHTML.includes('08:00 - 08:59 SGT'), 'Tooltip should contain Singapore hour label');
  assert.ok(tooltip.innerHTML.includes('64.2%'), 'Tooltip should contain occupancy percent');
  assert.ok(tooltip.innerHTML.includes('38.5 pax / bus'), 'Tooltip should contain avg passenger load');
  assert.ok(tooltip.innerHTML.includes('15 readings'), 'Tooltip should contain observation sample count');

  // Simulate mouseleave
  await canvas.dispatch('mouseleave');
  assert.equal(ui.STATE.campusHourlyHoveredIndex, null, 'Hovered index resets on mouseleave');
  assert.equal(tooltip.style.display, 'none', 'Tooltip hides on mouseleave');
});

test('vehicle route progression shows distinct per-stop crowd data, updates when at stop, and updates on revisit', async () => {
  const ui = dashboard();
  const utownStop = { name: 'University Town (UTown)', code: 'UTOWN', lat: 1.303781, lng: 103.774431 };
  const yihStop = { name: 'Yusof Ishak House (YIH)', code: 'YIH', lat: 1.298885, lng: 103.774377 };
  const clbStop = { name: 'Central Library (CLB)', code: 'CLB', lat: 1.296544, lng: 103.772569 };

  // 1. Bus initially at UTown with 80 pax
  const busAtUtown = {
    vehplate: 'PC9999Z',
    route_code: 'D1',
    lat: utownStop.lat,
    lng: utownStop.lng,
    ridership: 80,
    occupancy: 0.91,
    capacity: 88,
    speed: 0
  };

  ui.STATE.allFleet = [busAtUtown];
  ui.STATE.liveBuses = [busAtUtown];
  ui.renderVehicleStopProgression(busAtUtown);

  const progList = ui.sandbox.document.getElementById('vehicleStopProgressionList');
  assert.ok(progList.innerHTML.includes('📍 At Stop'), 'UTown displays At Stop badge');
  assert.ok(progList.innerHTML.includes('80 / 88 pax'), 'UTown displays 80 pax');
  assert.ok(progList.innerHTML.includes('Live at stop · Updated now'), 'UTown displays Live at stop label');
  assert.ok(progList.innerHTML.includes('Awaiting stop'), 'Unvisited stops show awaiting stop badge');
  assert.ok(progList.innerHTML.includes('-- / 88 pax'), 'Unvisited stops show placeholder pax');

  // Verify UTown was recorded in storage
  assert.equal(ui.STATE.stopCrowdStorage.byVehicle['PC9999Z']?.['UTOWN']?.ridership, 80);

  // 2. Bus moves to YIH with 65 pax (passenger drop-off/board)
  const busAtYih = {
    ...busAtUtown,
    lat: yihStop.lat,
    lng: yihStop.lng,
    ridership: 65,
    occupancy: 0.74
  };

  ui.STATE.liveBuses = [busAtYih];
  ui.renderVehicleStopProgression(busAtYih);

  // Both stops now have DISTINCT crowd data!
  assert.ok(progList.innerHTML.includes('65 / 88 pax'), 'YIH displays 65 pax live at stop');
  assert.ok(progList.innerHTML.includes('80 / 88 pax'), 'UTown retains its distinct recorded 80 pax');
  assert.equal(ui.STATE.stopCrowdStorage.byVehicle['PC9999Z']?.['YIH']?.ridership, 65);
  assert.equal(ui.STATE.stopCrowdStorage.byVehicle['PC9999Z']?.['UTOWN']?.ridership, 80);

  // 3. Bus loops around and revisits UTown with 42 pax
  const busRevisitUtown = {
    ...busAtUtown,
    lat: utownStop.lat,
    lng: utownStop.lng,
    ridership: 42,
    occupancy: 0.48
  };

  ui.STATE.liveBuses = [busRevisitUtown];
  ui.renderVehicleStopProgression(busRevisitUtown);

  // UTown is updated with the new 42 pax observation!
  assert.equal(ui.STATE.stopCrowdStorage.byVehicle['PC9999Z']?.['UTOWN']?.ridership, 42);
  assert.ok(progList.innerHTML.includes('42 / 88 pax'), 'UTown is updated with new 42 pax on revisit');
  assert.ok(progList.innerHTML.includes('65 / 88 pax'), 'YIH retains its 65 pax from previous stop');

  // 4. Manual set via promptSetStopCrowd
  ui.sandbox.window.prompt = () => '25';
  ui.promptSetStopCrowd('PC9999Z', 'CLB', 'Central Library (CLB)', 88);
  assert.equal(ui.STATE.stopCrowdStorage.byVehicle['PC9999Z']?.['CLB']?.ridership, 25);
  assert.equal(ui.STATE.stopCrowdStorage.byVehicle['PC9999Z']?.['CLB']?.isManual, true);

  ui.renderVehicleStopProgression(busRevisitUtown);
  assert.ok(progList.innerHTML.includes('25 / 88 pax'), 'CLB reflects manually calibrated 25 pax');

  // 5. Historical snapshots reconstruction
  const mockSnapshots = [
    {
      vehplate: 'PC9999Z',
      route_code: 'D1',
      lat: clbStop.lat,
      lng: clbStop.lng,
      ridership: 55,
      occupancy: 0.62,
      capacity: 88,
      timestamp: Date.now() + 10000
    }
  ];
  // Clear manual flag and process
  delete ui.STATE.stopCrowdStorage.byVehicle['PC9999Z']['CLB'];
  ui.processSnapshotsIntoStopCrowd('PC9999Z', 'D1', mockSnapshots);
  assert.equal(ui.STATE.stopCrowdStorage.byVehicle['PC9999Z']?.['CLB']?.ridership, 55, 'Snapshot reconstructs CLB reading');
});

test('direction tracking, route progression, and vehicle stop crowd isolation', () => {
  const ui = dashboard();

  // 1. Bearing and angle difference calculations
  assert.equal(ui.calculateBearing(1.0, 103.0, 1.0, 103.0), null, 'Identical coordinates have no bearing');
  const bearingNorth = ui.calculateBearing(1.2900, 103.7700, 1.3000, 103.7700);
  assert.ok(Math.abs(bearingNorth - 0) < 0.5, 'Northward bearing should be ~0 degrees');
  const bearingEast = ui.calculateBearing(1.2900, 103.7700, 1.2900, 103.7800);
  assert.ok(Math.abs(bearingEast - 90) < 0.5, 'Eastward bearing should be ~90 degrees');

  assert.equal(ui.angleDifference(0, 10), 10);
  assert.equal(ui.angleDifference(350, 10), 20);
  assert.equal(ui.angleDifference(90, 270), 180);
  assert.equal(ui.angleDifference(null, 90), 180);

  // 2. Vehicle movement tracking updates heading
  const testBus = { vehplate: 'PC1234A', lat: 1.2950, lng: 103.7700, heading: null };
  ui.updateVehicleMovement(testBus);
  assert.equal(ui.getVehicleBearing(testBus), null, 'Initial position has no bearing yet');

  // Move Northward 50m
  testBus.lat = 1.2955;
  testBus.lng = 103.7700;
  ui.updateVehicleMovement(testBus);
  const detectedBearing = ui.getVehicleBearing(testBus);
  assert.ok(detectedBearing !== null, 'Should detect bearing after movement');
  assert.ok(Math.abs(detectedBearing - 0) < 1, 'Detected bearing should be ~0 degrees (North)');

  // 3. Direction-aware route progression on Service A2 (the user scenario)
  // Stops sequence for A2:
  // Index 3: Opp NUSS (OPPNUSS)
  // Index 4: Ventus (LT13-OPP)
  // Index 5: Information Technology (IT)
  const a2BusAtVentus = {
    vehplate: 'PC7777T',
    route_code: 'A2',
    lat: 1.2953, // Ventus (LT13-OPP) is ~1.2953, 103.7706
    lng: 103.7706,
    heading: 75, // Heading East towards IT
    ridership: 30,
    capacity: 90
  };

  const a2Progression = ui.resolveVehicleRouteProgression(a2BusAtVentus, [
    'PGP', 'TCOMS', 'OPP-HSSML', 'OPPNUSS', 'LT13-OPP', 'IT', 'YIH', 'MUSEUM'
  ]);

  // Exactly 1 At Stop and at most 1 Approaching
  const atStopCount = a2Progression.stops.filter(s => s.isAtStop).length;
  const approachingCount = a2Progression.stops.filter(s => s.isApproaching).length;
  assert.equal(atStopCount, 1, 'Should have exactly 1 stop marked as At Stop');
  assert.equal(approachingCount, 1, 'Should have exactly 1 stop marked as Approaching');

  // Ventus (LT13-OPP) is At Stop
  const ventusStop = a2Progression.stops.find(s => s.code === 'LT13-OPP');
  assert.ok(ventusStop, 'Ventus stop exists');
  assert.equal(ventusStop.isAtStop, true, 'Ventus should be marked At Stop');
  assert.equal(ventusStop.isApproaching, false, 'Ventus should NOT be marked Approaching');

  // IT is Approaching
  const itStop = a2Progression.stops.find(s => s.code === 'IT');
  assert.ok(itStop, 'IT stop exists');
  assert.equal(itStop.isApproaching, true, 'IT should be marked Approaching');
  assert.equal(itStop.isAtStop, false, 'IT should NOT be marked At Stop');

  // Opp NUSS (behind the bus) is NOT approaching and NOT at stop
  const oppNussStop = a2Progression.stops.find(s => s.code === 'OPPNUSS');
  assert.ok(oppNussStop, 'Opp NUSS stop exists');
  assert.equal(oppNussStop.isAtStop, false, 'Opp NUSS must not be At Stop');
  assert.equal(oppNussStop.isApproaching, false, 'Opp NUSS in opposite direction must not be Approaching');

  // 4. Opposing stops disambiguation (e.g. LT13 vs LT13-OPP on opposite sides of the road)
  // When heading East (75 deg) towards IT, LT13-OPP is forward route, LT13 is opposing route
  const opposingBus = {
    vehplate: 'PC8888S',
    route_code: 'D1',
    lat: 1.2953,
    lng: 103.7706,
    heading: 75,
    ridership: 15,
    capacity: 88
  };
  const d1Progression = ui.resolveVehicleRouteProgression(opposingBus, [
    'OPP-HSSML', 'OPPNUSS', 'LT13-OPP', 'IT', 'YIH-OPP', 'UTOWN', 'RAFFLES', 'EA', 'S17', 'LT13', 'AS5', 'BIZ2'
  ]);
  const d1AtStops = d1Progression.stops.filter(s => s.isAtStop);
  assert.equal(d1AtStops.length, 1, 'Must disambiguate to only 1 At Stop');
  assert.equal(d1AtStops[0].code, 'LT13-OPP', 'Disambiguates to LT13-OPP aligned with heading');
  const d1Lt13 = d1Progression.stops.find(s => s.code === 'LT13');
  assert.equal(d1Lt13.isAtStop, false, 'Opposing LT13 across the road must NOT be At Stop');
  assert.equal(d1Lt13.isApproaching, false, 'Opposing LT13 across the road must NOT be Approaching');

  // 5. Vehicle progression DOM rendering:
  // - No "✎ Set" button in HTML
  // - Strictly vehicle-specific crowd isolation (no fleet fallback)
  ui.STATE.stopCrowdStorage = {
    byVehicle: {
      'OTHER_BUS': {
        'IT': { ridership: 75, capacity: 88, timestamp: Date.now() - 3600000, occupancy: 0.85 }
      }
    },
    byRoute: {
      'A2': {
        'IT': { ridership: 75, capacity: 88, timestamp: Date.now() - 3600000, occupancy: 0.85 }
      }
    }
  };

  ui.renderVehicleStopProgression(a2BusAtVentus);
  const progList = ui.element('vehicleStopProgressionList');

  // Verify Set button is completely removed
  assert.ok(!progList.innerHTML.includes('stop-card-set-btn'), 'Set button must be removed from stop progression cards');
  assert.ok(!progList.innerHTML.includes('✎ Set'), '✎ Set text must not appear on stop progression cards');

  // Verify vehicle isolation: IT was only visited by OTHER_BUS, so for a2BusAtVentus it shows Awaiting stop
  assert.ok(!progList.innerHTML.includes('75 / 88 pax'), 'Must NOT inherit crowd data from other buses on the route');
  assert.ok(progList.innerHTML.includes('Awaiting stop'), 'Unvisited stops by this bus must display Awaiting stop');
  assert.ok(progList.innerHTML.includes('No reading for this vehicle yet') || progList.innerHTML.includes('No reading at stop yet'),
    'Unvisited stops by this bus must indicate no reading for this vehicle');

  // Exactly 1 At Stop and 1 Approaching badge in rendered HTML
  const atStopMatches = (progList.innerHTML.match(/📍 At Stop/g) || []).length;
  const approachingMatches = (progList.innerHTML.match(/⚡ Approaching \(Next Stop\)/g) || []).length;
  assert.equal(atStopMatches, 1, 'HTML must contain exactly 1 "📍 At Stop" badge');
  assert.equal(approachingMatches, 1, 'HTML must contain exactly 1 "⚡ Approaching (Next Stop)" badge');
});

test('timeline chart renders vertical lines dividing the view into 24 parts and does not render hour slice dropdown', () => {
  const ui = dashboard();
  ui.STATE.timeMode = 'date';
  ui.STATE.selectedDate = '2026-09-10';
  ui.renderTimelineChart();
  assert.equal(ui.STATE.timelineZoom.startIndex, 0);
  assert.equal(ui.STATE.timelineZoom.endIndex, 1439);
  assert.equal(ui.element('timelineWindowBadge').textContent, 'All 24 Hours');

  // Verify hour slice select dropdown is removed from DOM
  assert.ok(!ui.sandbox.document.getElementById('selectHourSlice'), 'selectHourSlice dropdown must not exist');

  // Canvas drawing has vertical divider lines dividing the 24 hours
  const drawing = ui.drawing('timelineChart');
  const verticalGridPaths = drawing.paths.filter(p => p.color === '#1e2b45');
  // 24 hourly marks (00:00 to 23:00) + right boundary at 24:00 (index 1439) = 25 lines (24 parts)
  assert.ok(verticalGridPaths.length >= 24, `Expected at least 24 vertical divider lines, got ${verticalGridPaths.length}`);
});

test('timeline chart left and right navigation steps through the timeline and clamps at boundaries', async () => {
  const ui = dashboard();
  ui.STATE.timeMode = 'date';
  ui.STATE.selectedDate = '2026-09-10';
  ui.renderTimelineChart();
  ui.setupChartInteractivity();

  // Zoom in first to create a sub-window
  ui.zoomTimeline(0.25);
  const initialStart = ui.STATE.timelineZoom.startIndex;
  const initialEnd = ui.STATE.timelineZoom.endIndex;
  const initialSpan = initialEnd - initialStart;
  assert.ok(initialSpan < 500);

  // Navigate Right (Next) via button click -> shifts forward
  await ui.element('btnTimelineNext').click();
  assert.ok(ui.STATE.timelineZoom.startIndex > initialStart);

  // Navigate Left (Prev) via button click -> shifts backward
  await ui.element('btnTimelinePrev').click();
  assert.equal(ui.STATE.timelineZoom.startIndex, initialStart);

  // Navigate Left repeatedly to start boundary
  for (let i = 0; i < 20; i++) {
    await ui.element('btnTimelinePrev').click();
  }
  assert.equal(ui.STATE.timelineZoom.startIndex, 0, 'Clamps at start boundary 0');

  // Navigate Right repeatedly to end boundary
  for (let i = 0; i < 30; i++) {
    await ui.element('btnTimelineNext').click();
  }
  assert.equal(ui.STATE.timelineZoom.endIndex, 1439, 'Clamps at end boundary 1439');
});

test('timeline chart zoom in, zoom out, and reset adjust window span', async () => {
  const ui = dashboard();
  ui.renderTimelineChart();
  ui.setupChartInteractivity();

  assert.equal(ui.STATE.timelineZoom.endIndex - ui.STATE.timelineZoom.startIndex, 1439);

  // Zoom In: halves window span
  await ui.element('btnTimelineZoomIn').click();
  const span1 = ui.STATE.timelineZoom.endIndex - ui.STATE.timelineZoom.startIndex;
  assert.ok(span1 < 1000, `Zoom in decreased span: ${span1}`);

  // Zoom In again
  await ui.element('btnTimelineZoomIn').click();
  const span2 = ui.STATE.timelineZoom.endIndex - ui.STATE.timelineZoom.startIndex;
  assert.ok(span2 < span1, `Zoom in decreased span again: ${span2}`);

  // Zoom Out: doubles window span
  await ui.element('btnTimelineZoomOut').click();
  const span3 = ui.STATE.timelineZoom.endIndex - ui.STATE.timelineZoom.startIndex;
  assert.ok(span3 > span2, `Zoom out increased span: ${span3}`);

  // Zoom Reset: restores full 24h
  await ui.element('btnTimelineZoomReset').click();
  assert.equal(ui.STATE.timelineZoom.startIndex, 0);
  assert.equal(ui.STATE.timelineZoom.endIndex, 1439);
  assert.equal(ui.element('timelineWindowBadge').textContent, 'All 24 Hours');
});

test('timeline chart drag panning shifts visible window and hovered index respects slice', async () => {
  const ui = dashboard();
  ui.STATE.timeMode = 'date';
  ui.STATE.selectedDate = '2026-09-10';
  ui.STATE.timelineZoom = { startIndex: 96, endIndex: 108 };
  ui.renderTimelineChart();
  ui.setupChartInteractivity();

  // Hover at left edge maps to start index (96)
  const canvas = ui.element('timelineChart');
  await canvas.dispatch('mousemove', { clientX: 60, clientY: 200 }); // padding.left = 60
  assert.equal(ui.STATE.hoveredIndex, 96, 'Left edge hover corresponds to start index 96');

  // Hover at right edge maps to end index (108)
  await canvas.dispatch('mousemove', { clientX: 1048, clientY: 200 }); // width = 1072, padding.right = 24
  assert.equal(ui.STATE.hoveredIndex, 108, 'Right edge hover corresponds to end index 108');

  // Test mouse drag pan
  await canvas.dispatch('mousedown', { clientX: 500, clientY: 200 });
  await canvas.dispatch('mousemove', { clientX: 200, clientY: 200 }); // Dragging left by 300px
  await canvas.dispatch('mouseup', { clientX: 200, clientY: 200 });

  assert.ok(ui.STATE.timelineZoom.startIndex > 96, 'Dragging left shifted the window forward in time');
});

test('timeline series caching memoizes repeated renders and fast smoothing optimizes calculation', () => {
  const ui = dashboard();
  ui.STATE.activeRoutes = new Set(['CAMPUS_AVG', 'A1']);
  const end = Math.floor(NOW / 60000) * 60000;
  const start = end - 1439 * 60000;
  ui.STATE.history24h = {
    queryRange: { end: NOW },
    routeData: [
      { route_code: 'A1', bucket_ts: end - 10 * 60000, avg_ridership: 15, avg_occupancy_pct: 30 }
    ],
    campusData: [
      { bucket_ts: end - 10 * 60000, avg_ridership: 15, avg_occupancy_pct: 30 }
    ]
  };

  // First call computes series
  const res1 = ui.getCachedTimelineSeries(start, 1440, true);
  assert.ok(res1);
  assert.ok(res1.seriesMap.has('A1'));

  // Second call with same state returns exactly memoized instance (no re-calculation)
  const res2 = ui.getCachedTimelineSeries(start, 1440, true);
  assert.equal(res1, res2, 'Subsequent call returns memoized series result');

  // Verify smoothSeries produces accurate rounded values with precomputed weights
  const noisy = [10, 20, 30, 40, 50, 60, 50, 40, 30, 20, 10];
  const smoothed = ui.smoothSeries(noisy);
  assert.equal(smoothed.length, noisy.length);
  assert.ok(Number.isFinite(smoothed[5]));
  // Numbers are rounded to 1 decimal place without strings
  assert.equal(typeof smoothed[5], 'number');
  assert.equal(Math.round(smoothed[5] * 10) / 10, smoothed[5]);
});

