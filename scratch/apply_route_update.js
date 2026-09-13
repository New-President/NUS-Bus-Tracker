import { readFileSync, writeFileSync } from 'fs';
import vm from 'node:vm';

const originalApp = readFileSync('scratch/app_backup.js', 'utf8');
const busStops = JSON.parse(readFileSync('scratch/bus_stops_formatted.json', 'utf8'));
const routeStops = JSON.parse(readFileSync('scratch/route_stops_formatted.json', 'utf8'));
const routePaths = JSON.parse(readFileSync('scratch/generated_routes.json', 'utf8'));

// Format BUS_STOPS code
const busStopsCode = `// Official NUS Kent Ridge campus bus stops (synced with uNivUS ESB API)
const NUS_BUS_STOPS = ${JSON.stringify(busStops, null, 2)};`;

// Format ROUTE_PATHS code
const routePathsCode = `// High-precision road-aligned route geometries derived from official uNivUS stop sequences
const NUS_ROUTE_PATHS = ${JSON.stringify(routePaths)};`;

// Format ROUTE_STOPS code
const routeStopsEntries = Object.entries(routeStops).map(([route, codes]) => {
  const allIdentifiers = [...codes];
  for (const stop of busStops) {
    if (codes.includes(stop.code)) {
      allIdentifiers.push(stop.name);
    }
  }
  return `  ${route}: new Set(${JSON.stringify(allIdentifiers)})`;
}).join(',\n');

const routeStopsCode = `const NUS_ROUTE_STOPS = {\n${routeStopsEntries}\n};`;

const newBlock = `${busStopsCode}\n\n${routePathsCode}\n\n${routeStopsCode}`;

// Find start and end of the old block
const startMarker = '// Campus reference locations; these do not describe current service patterns.';
const endMarker = 'const NUS_ROUTE_STOPS = {';
const startIndex = originalApp.indexOf(startMarker);
if (startIndex === -1) throw new Error('Could not find start marker in app.js');

const routeStopsIndex = originalApp.indexOf(endMarker, startIndex);
if (routeStopsIndex === -1) throw new Error('Could not find routeStops marker in app.js');

const endIndex = originalApp.indexOf('function initLeafletMap()', routeStopsIndex);
if (endIndex === -1) throw new Error('Could not find initLeafletMap marker in app.js');

let updatedApp = originalApp.slice(0, startIndex) + newBlock + '\n\n' + originalApp.slice(endIndex);

// Also add R1, R2 to ROUTE_COLORS if missing
updatedApp = updatedApp.replace(
  "E: '#00838F', K: '#2E7D32'",
  "E: '#00838F', K: '#2E7D32', R1: '#10B981', R2: '#8B5CF6'"
);

// Update renderBusStopsOnMap to check stop.code as well as stop.name
updatedApp = updatedApp.replace(
  'const isStopOnRoute = !hasRouteFilter || activeStops.has(stop.name);',
  'const isStopOnRoute = !hasRouteFilter || activeStops.has(stop.name) || (stop.code && activeStops.has(stop.code));'
);

// Update renderRouteTraceOnMap for 'all' to iterate all 6 core campus routes
const oldAllLoop = `    for (const [code, coords] of Object.entries(NUS_ROUTE_PATHS)) {`;
const newAllLoop = `    const allCampusRoutes = ['A1', 'A2', 'D1', 'D2', 'E', 'K'];
    for (const code of allCampusRoutes) {
      const coords = NUS_ROUTE_PATHS[code];
      if (!coords) continue;`;

if (!updatedApp.includes(oldAllLoop)) {
  console.warn('Warning: oldAllLoop string not found exactly!');
} else {
  updatedApp = updatedApp.replace(oldAllLoop, newAllLoop);
}

// Test parsing with VM
try {
  new vm.Script(updatedApp, { filename: 'public/app.js' });
  console.log('Successfully validated updated app.js syntax with vm.Script!');
  writeFileSync('public/app.js', updatedApp);
} catch (err) {
  console.error('Syntax error in updated app.js:', err);
  process.exit(1);
}

