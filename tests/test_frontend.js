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
      getAttribute(name) { return this[name] ?? null; },
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
      documentElement: {
        attributes: new Map(),
        setAttribute(k, v) { this.attributes.set(k, v); },
        removeAttribute(k) { this.attributes.delete(k); },
        getAttribute(k) { return this.attributes.get(k) || null; }
      },
      getElementById(id) { return elements.get(id) ?? null; },
      querySelector(selector) {
        if (selector === 'meta[name="theme-color"]') {
          return {
            content: '',
            setAttribute(k, v) { if (k === 'content') this.content = v; },
            getAttribute(k) { return k === 'content' ? this.content : null; }
          };
        }
        return null;
      },
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
    localStorage: {
      _data: new Map(),
      getItem(k) { return this._data.get(k) ?? null; },
      setItem(k, v) { this._data.set(k, String(v)); },
      removeItem(k) { this._data.delete(k); },
      clear() { this._data.clear(); }
    },
    window: {
      devicePixelRatio: 1,
      addEventListener() {},
      matchMedia(query) {
        return {
          matches: false,
          media: query,
          addEventListener() {},
          removeEventListener() {}
        };
      }
    },
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
    renderVehicleDetailChart, renderVehicleHourlyBarChart, setupVehicleDashboardInteractivity,
    smoothSeries, inactiveReason, nearestTerminal, positionChartTooltip,
    getDistanceToStop, getServicedRoutesForStop, isBusApproachingOrAtStop,
    getBusesNearStop, renderStopPopupHtml, renderVehicleStopProgression,
    updateMapStopSelectDropdown, updateTimelineVehicleDropdown, fetchStopEtas,
    promptSetStopCrowd, recordVehicleStopCrowd, updateLiveStopsCrowdReadings,
    processSnapshotsIntoStopCrowd, calculateBearing, angleDifference, getVehicleBearing,
    updateVehicleMovement, resolveVehicleRouteProgression,
    navigateTimeline, zoomTimeline, resetTimelineZoom, getCachedTimelineSeries,
    computeRouteHeadways, computeAllRouteHeadways, computeVehicleDutyCycle,
    getVehicleDutySummary, getSingaporeDayBounds, analyzeVehicleCycles, getStopDwellAndExchangeForVehicle,
    computeStopBottlenecksAndCorridors, detectLectureSurgeWindows, isCurrentTimeInRange,
    extractDwellSessionsFromSnapshots,
    renderOptimizerView, renderTransitInsights,
    getStoredThemePreference, resolveTheme, getChartThemeColors, applyTheme, toggleTheme, setupThemeControls
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

test('smoothing toggle button switches between smoothed (5m), trend (30m), and raw view modes', async () => {
  const ui = dashboard();
  ui.setupFilters();
  const end = Math.floor(NOW / INTERVAL) * INTERVAL;
  ui.STATE.history24h = { queryRange: { end: NOW }, routeData: [], campusData: [
    { bucket_ts: end - 2 * INTERVAL, avg_ridership: 10, avg_occupancy_pct: null },
    { bucket_ts: end - 1 * INTERVAL, avg_ridership: null, avg_occupancy_pct: null },
    { bucket_ts: end, avg_ridership: 30, avg_occupancy_pct: null }
  ] };

  // Default is smoothed (5m)
  assert.equal(ui.STATE.smoothing, 'smoothed');
  ui.renderTimelineChart();
  assert.match(ui.element('panelTimelineSubtitle').textContent, /5-minute responsive rolling average · Preserves peak capacity/);

  // Switch to trend (30m)
  await ui.element('smoothingToggleGroup').dispatch('click', {
    target: {
      dataset: { smoothing: 'trend' },
      closest: selector => selector === 'button' ? { dataset: { smoothing: 'trend' } } : null
    }
  });
  assert.equal(ui.STATE.smoothing, 'trend');
  assert.match(ui.element('panelTimelineSubtitle').textContent, /30-minute macro trend/);

  // Switch to raw (1m)
  await ui.element('smoothingToggleGroup').dispatch('click', {
    target: {
      dataset: { smoothing: 'raw' },
      closest: selector => selector === 'button' ? { dataset: { smoothing: 'raw' } } : null
    }
  });
  assert.equal(ui.STATE.smoothing, 'raw');
  assert.match(ui.element('panelTimelineSubtitle').textContent, /1-minute intervals/);

  // Switch back to smoothed (5m)
  await ui.element('smoothingToggleGroup').dispatch('click', {
    target: {
      dataset: { smoothing: 'smoothed' },
      closest: selector => selector === 'button' ? { dataset: { smoothing: 'smoothed' } } : null
    }
  });
  assert.equal(ui.STATE.smoothing, 'smoothed');
  assert.match(ui.element('panelTimelineSubtitle').textContent, /5-minute responsive rolling average · Preserves peak capacity/);
});

test('5-minute smoothing preserves 100% capacity crush load peaks while 30-minute macro smoothing heavily flattens them', () => {
  const ui = dashboard();
  // Simulate 60 minutes of data with a 4-minute 100% crush load peak surrounded by 40% load
  const rawOccupancy = Array(60).fill(40);
  for (let m = 28; m <= 31; m++) rawOccupancy[m] = 100;

  // 1. 5-minute smoothing (windowRadiusMinutes = 2)
  const smoothed5m = ui.smoothSeries(rawOccupancy, { windowRadiusMinutes: 2 });
  const peak5m = Math.max(...smoothed5m);
  // 5m smoothing preserves responsive peak >= 90% (specifically 93.3%)
  assert.ok(peak5m >= 90, `Expected 5m smoothed peak >= 90%, got ${peak5m}%`);

  // A 5-minute surge reaches full 100%
  const full5mOccupancy = Array(60).fill(40);
  for (let m = 28; m <= 32; m++) full5mOccupancy[m] = 100;
  const smoothedFull5m = ui.smoothSeries(full5mOccupancy, { windowRadiusMinutes: 2 });
  assert.equal(Math.max(...smoothedFull5m), 100, 'A 5-minute surge reaches full 100% on smoothed graph');

  // 2. 30-minute macro smoothing (windowRadiusMinutes = 15)
  const smoothed30m = ui.smoothSeries(rawOccupancy, { windowRadiusMinutes: 15 });
  const peak30m = Math.max(...smoothed30m);
  // 30m macro smoothing heavily flattens the peak to below 75%
  assert.ok(peak30m < 75, `Expected 30m smoothed peak < 75%, got ${peak30m}%`);
});

test('chart tooltip displays peak capacity alert when bus reaches full crowd level', () => {
  const ui = dashboard();
  ui.STATE.currentView = 'crowd';
  ui.STATE.activeRoutes = new Set(['A1']);
  const end = Math.floor(NOW / 60000) * 60000;
  const start = end - 1439 * 60000;
  const peakIdx = 500;
  const peakTs = start + peakIdx * 60000;
  ui.STATE.history24h = {
    queryRange: { end: NOW },
    routeData: [
      { route_code: 'A1', bucket_ts: peakTs, avg_ridership: 55, avg_occupancy_pct: 100 }
    ],
    campusData: []
  };

  ui.renderTimelineChart();
  const canvas = ui.element('timelineChart');
  const tooltip = ui.element('chartTooltip');
  assert.ok(canvas._chartMeta);
  // Directly simulate pointer hovering over the peak index
  ui.STATE.hoveredIndex = peakIdx;
  const series = canvas._chartMeta.seriesMap.get('A1');
  assert.ok(series);
  assert.equal(series.rawOccupancies[peakIdx], 100);
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

test('computeRouteHeadways detects normal headway vs bunching below 2.5 min threshold', () => {
  const ui = dashboard();

  // Test 1: Two buses well spaced along A1 loop
  // PGP (1.2917, 103.7804) and CLB (1.2965, 103.7725)
  const bus1 = bus({ vehplate: 'PC1001A', route_code: 'A1', lat: 1.291765, lng: 103.780419, speed: 20 });
  const bus2 = bus({ vehplate: 'PC1002B', route_code: 'A1', lat: 1.296534, lng: 103.772545, speed: 20 });

  const resultSpaced = ui.computeRouteHeadways([bus1, bus2], 'A1');
  assert.equal(resultSpaced.routeCode, 'A1');
  assert.equal(resultSpaced.buses.length, 2);
  assert.equal(resultSpaced.hasBunching, false, 'Well-spaced buses should not be flagged as bunched');
  assert.ok(resultSpaced.pairs.length >= 1);
  assert.ok(resultSpaced.pairs[0].timeGapMin >= 2.5);

  // Test 2: Two buses closely following each other (< 1.5 min / < 250m)
  const bunchedBus1 = bus({ vehplate: 'PC2001X', route_code: 'A1', lat: 1.29482, lng: 103.78441, speed: 15 }); // KR-MRT
  const bunchedBus2 = bus({ vehplate: 'PC2002Y', route_code: 'A1', lat: 1.29490, lng: 103.78450, speed: 15 }); // Right behind at KR-MRT

  const resultBunched = ui.computeRouteHeadways([bunchedBus1, bunchedBus2], 'A1');
  assert.equal(resultBunched.hasBunching, true, 'Buses right behind each other must trigger bunching alert');
  assert.ok(resultBunched.bunchedPlates.size > 0);
});

test('computeVehicleDutyCycle categorizes full-day workhorse vs peak booster and measures sequential Haversine mileage', () => {
  const ui = dashboard();

  // Simulate 500 snapshots (~8.3 hours of 1-minute telemetry)
  const fullDaySnaps = [];
  let baseLat = 1.2917;
  let baseLng = 103.7804;
  const startTs = NOW - 500 * 60000;

  for (let i = 0; i < 500; i++) {
    // Add small movement
    baseLat += (i % 2 === 0 ? 0.0005 : -0.0004);
    baseLng += (i % 2 === 0 ? 0.0004 : -0.0003);
    fullDaySnaps.push({
      timestamp: startTs + i * 60000,
      lat: baseLat,
      lng: baseLng,
      speed: 18,
      ridership: 25,
      occupancy: 0.35
    });
  }

  const fullDay = ui.computeVehicleDutyCycle(fullDaySnaps, 'PC-FULLDAY');
  assert.equal(fullDay.profile, 'Full-Day Workhorse');
  assert.equal(fullDay.badgeClass, 'badge-duty-full-day');
  assert.equal(fullDay.activeMinutes, 500);
  assert.ok(fullDay.distanceKm > 5, 'Calculates non-zero cumulative Haversine distance');

  // Simulate peak-only booster: 120 snapshots during morning peak (08:00 - 10:00 SGT)
  // Singapore 08:00 SGT is 00:00 UTC
  const morningPeakDate = new Date(Date.UTC(2026, 8, 17, 0, 30, 0)); // 08:30 SGT
  const peakSnaps = [];
  for (let i = 0; i < 120; i++) {
    peakSnaps.push({
      timestamp: morningPeakDate.getTime() + i * 60000,
      lat: 1.2917 + i * 0.0001,
      lng: 103.7804 + i * 0.0001,
      speed: 22,
      ridership: 45,
      occupancy: 0.6
    });
  }

  const peakBooster = ui.computeVehicleDutyCycle(peakSnaps, 'PC-PEAK');
  assert.equal(peakBooster.profile, 'Peak Booster');
  assert.equal(peakBooster.badgeClass, 'badge-duty-booster');
  assert.equal(peakBooster.activeMinutes, 120);
});

test('analyzeVehicleCycles detects loop completions, average cycle time, and terminal layovers', () => {
  const ui = dashboard();

  // Route A1 terminal: PGP (1.291765, 103.780419)
  const termLat = 1.291765;
  const termLng = 103.780419;
  const snaps = [];
  let t = NOW - 120 * 60000;

  // Visit 1 at PGP terminal (rest 6 min)
  for (let i = 0; i < 6; i++) {
    snaps.push({ timestamp: t, lat: termLat, lng: termLng, speed: 0 });
    t += 60000;
  }
  // Drive loop around campus (24 min)
  for (let i = 0; i < 24; i++) {
    snaps.push({ timestamp: t, lat: 1.2965, lng: 103.7725, speed: 20 });
    t += 60000;
  }
  // Visit 2 at PGP terminal (rest 6 min)
  for (let i = 0; i < 6; i++) {
    snaps.push({ timestamp: t, lat: termLat, lng: termLng, speed: 0 });
    t += 60000;
  }
  // Drive loop around campus (24 min)
  for (let i = 0; i < 24; i++) {
    snaps.push({ timestamp: t, lat: 1.2965, lng: 103.7725, speed: 20 });
    t += 60000;
  }
  // Visit 3 at PGP terminal
  for (let i = 0; i < 6; i++) {
    snaps.push({ timestamp: t, lat: termLat, lng: termLng, speed: 0 });
    t += 60000;
  }

  const cycleInfo = ui.analyzeVehicleCycles(snaps, 'A1');
  assert.ok(cycleInfo.loopCount >= 2, 'Detects completed loops between terminal visits');
  assert.ok(cycleInfo.avgLoopMin >= 20 && cycleInfo.avgLoopMin <= 30, 'Detects loop cycle duration around ~24m');
  assert.ok(cycleInfo.avgLayoverMin >= 4 && cycleInfo.avgLayoverMin <= 8, 'Detects average layover rest around ~6m');
});

test('getStopDwellAndExchangeForVehicle extracts stationary dwell durations and boarding deltas', () => {
  const ui = dashboard();

  // Simulate vehicle stopping at CLB stop (code 'CLB', lat 1.296534, lng 103.772545)
  // 3 consecutive 1-minute snapshots with speed = 0, ridership increasing from 20 to 52
  const dwellSnaps = [
    { timestamp: NOW - 180000, lat: 1.296534, lng: 103.772545, speed: 0, ridership: 20 },
    { timestamp: NOW - 120000, lat: 1.296534, lng: 103.772545, speed: 0, ridership: 40 },
    { timestamp: NOW - 60000, lat: 1.296534, lng: 103.772545, speed: 0, ridership: 52 }
  ];

  const dwellInfo = ui.getStopDwellAndExchangeForVehicle(dwellSnaps, 'CLB');
  assert.ok(dwellInfo);
  assert.equal(dwellInfo.dwellMin, 3, 'Calculates 3 minutes dwell duration');
  assert.equal(dwellInfo.deltaPax, 32, 'Calculates +32 net boarding passenger exchange');
});

test('renderMapHeadwaysAndTraffic and renderFleetGrid render headway pills, bunching badges, and duty profiles', () => {
  const ui = dashboard();

  // Create two bunched buses on A1
  const b1 = bus({ vehplate: 'PC9001A', route_code: 'A1', lat: 1.29482, lng: 103.78441, speed: 10 });
  const b2 = bus({ vehplate: 'PC9002B', route_code: 'A1', lat: 1.29490, lng: 103.78450, speed: 10 });
  reportedFleet(ui, [b1, b2]);

  // Render fleet grid
  ui.renderFleetGrid();
  const fleetHtml = ui.element('fleetGrid').innerHTML;
  assert.ok(fleetHtml.includes('badge-bunched'), 'Fleet card contains bunching warning badge');
  assert.ok(fleetHtml.includes('Today:'), 'Fleet card includes daily operating telemetry');

  // Render map headway bar
  ui.initLeafletMap();
  ui.renderMapBuses();
  const headwayHtml = ui.element('mapHeadwayBar').innerHTML;
  assert.ok(headwayHtml.includes('headway-route-group'), 'Map headway strip renders route group');
  assert.ok(headwayHtml.includes('PC9001A'));
  assert.ok(headwayHtml.includes('PC9002B'));
  assert.ok(headwayHtml.includes('is-bunched'), 'Map headway pill highlights bunched pair in amber/red');

  // Check map traffic index badge
  const trafficBadge = ui.element('mapTrafficIndexBadge');
  assert.ok(trafficBadge.textContent.includes('Traffic'));
});

test('renderTransitInsights renders stop dwell leaderboard, corridor travel times, and lecture transition waves', () => {
  const ui = dashboard();

  // Call renderOptimizerView which invokes renderTransitInsights
  ui.renderOptimizerView();

  const leaderboardHtml = ui.element('stopDwellLeaderboard').innerHTML;
  assert.ok(leaderboardHtml.includes('Central Library (CLB)'), 'Leaderboard includes top dwell stop');
  assert.ok(leaderboardHtml.includes('Avg Stop Dwell'), 'Leaderboard shows dwell metrics');

  const segmentsHtml = ui.element('segmentTravelTimesList').innerHTML;
  assert.ok(segmentsHtml.includes('Prince George'), 'Corridors list includes key campus segment');
  assert.ok(segmentsHtml.includes('Baseline:'), 'Corridors list compares baseline with observed timing');

  const surgeHtml = ui.element('lectureSurgeContainer').innerHTML;
  assert.ok(surgeHtml.includes('Morning Lecture Rush'), 'Lecture transition surges include morning wave');
  assert.ok(surgeHtml.includes('Commuter Tip:'), 'Includes commuter actionable boarding tip');
});

test('stop dwell leaderboard dynamically adapts to incoming live dwell sessions and snapshot history', () => {
  const ui = dashboard();

  // Initially baseline ranking
  const initial = ui.computeStopBottlenecksAndCorridors();
  assert.strictEqual(initial.topStops[0].code, 'CLB', 'CLB is top stop by baseline');

  // Simulate heavy surge dwell sessions observed at Computing COM3 (valid active boarding <= 300s)
  ui.STATE.stopDwellSessions.push(
    { stopCode: 'COM3', dwellSec: 295, deltaPax: 75, timestamp: NOW - 60000, vehplate: 'PC1001A' },
    { stopCode: 'COM3', dwellSec: 290, deltaPax: 80, timestamp: NOW - 120000, vehplate: 'PC1002B' },
    { stopCode: 'COM3', dwellSec: 285, deltaPax: 68, timestamp: NOW - 180000, vehplate: 'PC1003C' },
    { stopCode: 'COM3', dwellSec: 300, deltaPax: 72, timestamp: NOW - 240000, vehplate: 'PC1004D' },
    { stopCode: 'COM3', dwellSec: 290, deltaPax: 70, timestamp: NOW - 300000, vehplate: 'PC1005E' }
  );

  const updated = ui.computeStopBottlenecksAndCorridors();
  assert.strictEqual(updated.topStops[0].code, 'COM3', 'COM3 dynamically vaults to rank #1 due to observed dwell bottlenecks');
  assert.ok(updated.topStops[0].avgDwellSec >= 280, 'Dynamic average dwell reflects empirical observations');
  assert.strictEqual(updated.topStops[0].severity, 'Severe Dwell', 'Severity dynamically updates to Severe Dwell');

  // Verify UI re-render reflects the dynamic update
  ui.renderTransitInsights();
  const leaderboardHtml = ui.element('stopDwellLeaderboard').innerHTML;
  assert.ok(leaderboardHtml.includes('Computing (COM 3)'), 'Rendered UI reflects dynamic top bottleneck stop');
  assert.ok(leaderboardHtml.includes('#1'), 'Rank 1 badge rendered');
});

test('stop dwell leaderboard excludes resting, parked, and downtime buses exceeding 5 minutes', () => {
  const ui = dashboard();

  // Insert resting / downtime sessions (> 5 minutes or empty parked) for YIH and Opp Hon Sui Sen
  ui.STATE.stopDwellSessions.push(
    { stopCode: 'YIH', dwellSec: 632, deltaPax: 0, timestamp: NOW - 60000, vehplate: 'PC1009X' }, // 10m 32s resting
    { stopCode: 'HSSML-OPP', dwellSec: 396, deltaPax: 12, timestamp: NOW - 120000, vehplate: 'PC1010Y' } // 6m 36s downtime
  );

  // Also simulate active bus dwell currently parked for > 5 min
  ui.STATE.activeBusDwells.set('PC9999Z', {
    stopCode: 'YIH',
    startTime: NOW - 700000, // > 11 mins ago
    startPax: 0,
    lastPax: 0,
    lastSeen: NOW,
    isDowntime: true
  });

  const res = ui.computeStopBottlenecksAndCorridors();
  // Ensure YIH and HSSML-OPP are not at top with > 5min dwell
  const topStop = res.topStops[0];
  assert.notStrictEqual(topStop.code, 'YIH', 'YIH resting bus does not dominate leaderboard');
  for (const s of res.topStops) {
    assert.ok(s.avgDwellSec <= 300, `Average dwell for ${s.name} (${s.avgDwellSec}s) does not exceed 5 minutes`);
  }
});

test('detectLectureSurgeWindows falls back to baseline heuristics when telemetry is empty', () => {
  const ui = dashboard();
  const surges = ui.detectLectureSurgeWindows([], []);

  assert.equal(surges.length, 6, 'Six lecture windows defined');
  assert.equal(surges[0].timeRange, '08:25 – 08:45 SGT');
  assert.equal(surges[0].isEmpirical, false, 'Without telemetry, isEmpirical is false');
  assert.equal(surges[0].observedSummary, 'Baseline timetable schedule');
  assert.equal(surges[0].peakIncrease, '+38% crowd', 'Baseline heuristic preserved');
  assert.ok(surges[0].desc.includes('Morning Lecture Rush'));
  assert.ok(surges[0].tip.includes('Board before 08:20'));
});

test('detectLectureSurgeWindows dynamically computes empirical surge from campus telemetry', () => {
  const ui = dashboard();

  // Create daytime baseline readings (30% occupancy) across daytime hours
  const campusData = [];
  const baseDayTs = Date.parse('2026-09-10T01:00:00Z'); // 09:00 SGT
  for (let i = 0; i < 20; i++) {
    campusData.push({
      bucket_ts: baseDayTs + i * 5 * 60 * 1000,
      avg_occupancy_pct: 30,
      avg_ridership: 15
    });
  }

  // Inject intense surge readings (80% occupancy) during 08:25-08:45 SGT (00:25-00:45 UTC)
  const surgeTs = Date.parse('2026-09-10T00:30:00Z'); // 08:30 SGT
  for (let i = 0; i < 8; i++) {
    campusData.push({
      bucket_ts: surgeTs + i * 60 * 1000,
      avg_occupancy_pct: 80,
      avg_ridership: 45
    });
  }

  const surges = ui.detectLectureSurgeWindows([], campusData);
  const morningRush = surges[0];

  assert.equal(morningRush.isEmpirical, true, 'Surge is marked empirical when readings match window');
  assert.equal(morningRush.sampleCount, 8, '8 readings detected in morning rush window');
  assert.equal(morningRush.observedAvgOccupancy, 80, 'Observed average occupancy is 80%');
  assert.ok(morningRush.observedSummary.includes('80% avg load · 8 readings'), 'Summary reports empirical load and count');

  // Verify dynamic surge percentage reflects the empirical spike over 30% baseline
  const surgeNum = parseInt(morningRush.peakIncrease.replace(/[^\d]/g, ''), 10);
  assert.ok(surgeNum > 50, `Dynamic surge percentage (${surgeNum}%) reflects empirical spike`);
});

test('detectLectureSurgeWindows dynamically detects active window, live fleet load, and headway alerts', () => {
  const ui = dashboard();

  // Reference time: 10:00 SGT (02:00 UTC), inside 09:50 - 10:15 window
  const simTime = Date.parse('2026-09-10T02:00:00Z');

  ui.STATE.liveBuses = [
    { route_code: 'A1', occupancy: 0.85, lat: 1.295, lng: 103.774 },
    { route_code: 'D1', occupancy: 0.75, lat: 1.296, lng: 103.775 }
  ];

  // Simulate bunching detected on Service A1
  ui.STATE.routeHeadways = new Map([
    ['A1', { bunchedPlates: new Set(['PC1001A']) }]
  ]);

  const surges = ui.detectLectureSurgeWindows([], [], simTime);
  const transition1000 = surges[1];

  assert.equal(transition1000.isActive, true, '10:00 window is active at 10:00 SGT');
  assert.equal(transition1000.liveOccupancy, 80, 'Live fleet occupancy accurately calculated (average of 85% and 75%)');
  assert.ok(transition1000.tip.includes('Active Surge Alert: Bunching detected on Service A1'), 'Dynamic commuter tip reflects active bunching advisory');

  // Other window should be inactive
  assert.equal(surges[0].isActive, false, 'Morning rush is not active at 10:00 SGT');
});

test('renderTransitInsights renders dynamic metric strips and updates panel header badge', () => {
  const ui = dashboard();

  ui.STATE.analytics = { campusHourly: [] };
  ui.STATE.history24h = { campusData: [] };

  ui.renderTransitInsights();

  const surgeHtml = ui.element('lectureSurgeContainer').innerHTML;
  assert.ok(surgeHtml.includes('surge-metric-strip'), 'Contains metric strip element');
  assert.ok(surgeHtml.includes('pill-baseline'), 'Renders baseline indicator pill when no telemetry');

  const alertBadge = ui.element('lectureSurgeAlertBadge');
  assert.ok(alertBadge.textContent.length > 0, 'Header badge text is populated');
  assert.ok(alertBadge.className.includes('badge'), 'Header badge class applied');
});

test('getSingaporeDayBounds correctly computes 12:00 AM midnight SGT boundaries', () => {
  const ui = dashboard();
  const bounds = ui.getSingaporeDayBounds('2026-09-18');
  assert.equal(bounds.dateStr, '2026-09-18');
  // 2026-09-18T00:00:00+08:00 is 2026-09-17T16:00:00Z
  const expectedStart = Date.parse('2026-09-17T16:00:00Z');
  assert.equal(bounds.startMs, expectedStart);
  assert.equal(bounds.endMs, expectedStart + 86400000);
});

test('getVehicleDutySummary resets active minutes and distance at 12:00 AM midnight SGT', () => {
  const ui = dashboard();
  const targetDate = '2026-09-18';
  const midnightSgt = Date.parse('2026-09-17T16:00:00Z'); // 12:00 AM SGT on Sept 18

  // Telemetry from yesterday evening (2026-09-17 18:00 to 22:00 SGT) -> 100 buckets
  // Telemetry from today morning (2026-09-18 07:00 to 08:00 SGT) -> 60 buckets
  const yesterdayTs = midnightSgt - 4 * 3600 * 1000;
  const todayTs = midnightSgt + 7 * 3600 * 1000;

  ui.STATE.history24h = {
    vehicleData: [
      ...Array.from({ length: 100 }, (_, i) => ({
        bucket_ts: yesterdayTs + i * 60000,
        vehplate: 'PC9999Z',
        route_code: 'A1'
      })),
      ...Array.from({ length: 60 }, (_, i) => ({
        bucket_ts: todayTs + i * 60000,
        vehplate: 'PC9999Z',
        route_code: 'A1'
      }))
    ]
  };

  // When querying for today (targetDate), only 60 buckets should be counted (not 160)
  const duty = ui.getVehicleDutySummary('PC9999Z', targetDate);
  assert.equal(duty.activeMinutes, 60, 'Only counts minutes after 12:00 AM midnight');
  assert.equal(duty.activeHoursLabel, '1h 0m');
  assert.equal(duty.distanceKm, Math.round(60 * 0.18 * 10) / 10, 'Distance only includes today telemetry');

  // If vehicle only operated yesterday
  ui.STATE.history24h = {
    vehicleData: [
      ...Array.from({ length: 100 }, (_, i) => ({
        bucket_ts: yesterdayTs + i * 60000,
        vehplate: 'PC8888Y',
        route_code: 'D1'
      }))
    ]
  };
  const offDuty = ui.getVehicleDutySummary('PC8888Y', targetDate);
  assert.equal(offDuty.activeMinutes, 0, 'Resets to 0 active minutes for today');
  assert.equal(offDuty.distanceKm, 0, 'Resets to 0 km distance for today');
  assert.equal(offDuty.profile, 'Standby / Off-duty');
});

test('getVehicleDutySummary with snapshots cache excludes snapshots prior to 12:00 AM midnight SGT', () => {
  const ui = dashboard();
  const targetDate = '2026-09-18';
  const midnightSgt = Date.parse('2026-09-17T16:00:00Z');

  // Cache snapshots: 50 yesterday, 30 today
  const snaps = [
    ...Array.from({ length: 50 }, (_, i) => ({
      timestamp: midnightSgt - (50 - i) * 60000,
      lat: 1.296 + i * 0.0001,
      lng: 103.776 + i * 0.0001
    })),
    ...Array.from({ length: 30 }, (_, i) => ({
      timestamp: midnightSgt + (i + 1) * 60000,
      lat: 1.296 + i * 0.0001,
      lng: 103.776 + i * 0.0001
    }))
  ];

  ui.STATE.vehicleSnapshotsCache = new Map([['PC7777X', snaps]]);
  const duty = ui.getVehicleDutySummary('PC7777X', targetDate);
  assert.equal(duty.activeMinutes, 30, 'Only includes 30 snapshots recorded after midnight');
  assert.equal(duty.activeHoursLabel, '0h 30m');
  assert.ok(duty.distanceKm > 0, 'Calculates non-zero distance for today');
});

test('theme management: initializes default theme preference and resolves correctly', () => {
  const ui = dashboard();
  assert.equal(ui.getStoredThemePreference(), 'system');
  assert.equal(ui.resolveTheme('system'), 'dark');
  assert.equal(ui.resolveTheme('light'), 'light');
  assert.equal(ui.resolveTheme('dark'), 'dark');
});

test('theme management: applying theme updates documentElement attribute and localStorage', () => {
  const ui = dashboard();
  ui.applyTheme('light', true);
  assert.equal(ui.STATE.theme, 'light');
  assert.equal(ui.STATE.resolvedTheme, 'light');
  assert.equal(ui.sandbox.document.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(ui.sandbox.localStorage.getItem('nus_theme'), 'light');

  ui.applyTheme('dark', true);
  assert.equal(ui.STATE.theme, 'dark');
  assert.equal(ui.STATE.resolvedTheme, 'dark');
  assert.equal(ui.sandbox.document.documentElement.getAttribute('data-theme'), null);
  assert.equal(ui.sandbox.localStorage.getItem('nus_theme'), 'dark');
});

test('theme management: toggleTheme switches between light and dark', () => {
  const ui = dashboard();
  ui.applyTheme('dark', true);
  ui.toggleTheme();
  assert.equal(ui.STATE.theme, 'light');
  assert.equal(ui.STATE.resolvedTheme, 'light');
  assert.equal(ui.sandbox.document.documentElement.getAttribute('data-theme'), 'light');

  ui.toggleTheme();
  assert.equal(ui.STATE.theme, 'dark');
  assert.equal(ui.STATE.resolvedTheme, 'dark');
  assert.equal(ui.sandbox.document.documentElement.getAttribute('data-theme'), null);
});

test('theme management: getChartThemeColors returns adapted palettes for dark and light', () => {
  const ui = dashboard();
  ui.applyTheme('dark', false);
  const darkColors = ui.getChartThemeColors();
  assert.equal(darkColors.isLight, false);
  assert.equal(darkColors.grid, '#273553');

  ui.applyTheme('light', false);
  const lightColors = ui.getChartThemeColors();
  assert.equal(lightColors.isLight, true);
  assert.equal(lightColors.grid, '#e2e8f0');
});

test('theme management: controls wire up button and select dropdown', () => {
  const ui = dashboard();
  const toggleBtn = ui.element('btnThemeToggle');
  const selectTheme = ui.element('selectThemeSetting');

  ui.setupThemeControls();

  // Test clicking toggle button
  toggleBtn.dispatch('click');
  assert.equal(ui.STATE.theme, 'light');
  assert.equal(ui.STATE.resolvedTheme, 'light');
  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'true');

  // Test selecting dark from dropdown
  selectTheme.value = 'dark';
  selectTheme.dispatch('change', { target: { value: 'dark' } });
  assert.equal(ui.STATE.theme, 'dark');
  assert.equal(ui.STATE.resolvedTheme, 'dark');
  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'false');
});




