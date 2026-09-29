import fs from 'node:fs';
import vm from 'node:vm';

const content = fs.readFileSync('public/app.js', 'utf8');

const s = content.indexOf('const NUS_ROUTE_PATHS = ');
const e = content.indexOf('const NUS_ROUTE_STOPS = ');
const code = content.slice(s, e) + '; NUS_ROUTE_PATHS;';
const NUS_ROUTE_PATHS = vm.runInNewContext(code);

function getDistanceToStop(lat1, lon1, lat2, lon2) {
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) return Infinity;
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

function projectPointToSegment(plat, plng, alat, alng, blat, blng) {
  const cosLat = Math.cos((alat + blat) * 0.5 * Math.PI / 180);
  const dx = (blng - alng) * cosLat;
  const dy = blat - alat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-14) return { lat: alat, lng: alng, t: 0 };
  const px = (plng - alng) * cosLat;
  const py = plat - alat;
  let t = (px * dx + py * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return { lat: alat + t * (blat - alat), lng: alng + t * (blng - alng), t };
}

function snapToRoute(lat, lng, routeCode, maxSnapDistance = 2500) {
  const coords = NUS_ROUTE_PATHS[routeCode];
  if (!Array.isArray(coords) || coords.length < 2) return { lat, lng, dist: 0, snapped: false };
  let minD = Infinity;
  let best = { lat, lng };
  for (let i = 0; i < coords.length - 1; i++) {
    const p = projectPointToSegment(lat, lng, coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
    const d = getDistanceToStop(lat, lng, p.lat, p.lng);
    if (d < minD) {
      minD = d;
      best = p;
    }
  }
  if (minD <= maxSnapDistance) {
    return { lat: best.lat, lng: best.lng, dist: minD, snapped: true };
  }
  return { lat, lng, dist: minD, snapped: false };
}

// Test coordinates from screenshot:
const testCases = [
  { name: 'PD576U', lat: 1.297, lng: 103.769, route: 'A1' },
  { name: 'PC3954Y', lat: 1.2955, lng: 103.770, route: 'A1' },
  { name: 'PD629B', lat: 1.2935, lng: 103.7850, route: 'A1' }
];

for (const tc of testCases) {
  const snap150 = snapToRoute(tc.lat, tc.lng, tc.route, 150);
  const snap2500 = snapToRoute(tc.lat, tc.lng, tc.route, 2500);
  console.log(`${tc.name}:`);
  console.log(`  Raw: (${tc.lat}, ${tc.lng})`);
  console.log(`  With 150m: snapped=${snap150.snapped}, dist=${Math.round(snap150.dist)}m, pos=(${snap150.lat.toFixed(5)}, ${snap150.lng.toFixed(5)})`);
  console.log(`  With 2500m: snapped=${snap2500.snapped}, dist=${Math.round(snap2500.dist)}m, pos=(${snap2500.lat.toFixed(5)}, ${snap2500.lng.toFixed(5)})`);
}
