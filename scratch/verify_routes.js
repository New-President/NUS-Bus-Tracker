import { readFileSync } from 'fs';

const routes = JSON.parse(readFileSync('scratch/generated_routes.json', 'utf8'));
const pickupData = JSON.parse(readFileSync('scratch/univus_pickup_points.json', 'utf8'));

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

for (const [code, coords] of Object.entries(routes)) {
  console.log(`\n=== Verification for Route ${code} ===`);
  console.log(`Coordinate count: ${coords.length}`);
  
  // 1. Max jump between consecutive points
  let maxJump = 0;
  let totalLength = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = distanceMeters(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
    totalLength += d;
    if (d > maxJump) maxJump = d;
  }
  console.log(`Total circuit length: ${(totalLength / 1000).toFixed(2)} km`);
  console.log(`Max jump between polyline points: ${maxJump.toFixed(1)} m`);

  // 2. Check each stop proximity
  const stops = pickupData[code]?.pickuppoint || [];
  let maxStopDist = 0;
  for (const stop of stops) {
    let minDist = Infinity;
    for (const pt of coords) {
      const d = distanceMeters(stop.lat, stop.lng, pt[0], pt[1]);
      if (d < minDist) minDist = d;
    }
    if (minDist > maxStopDist) maxStopDist = minDist;
  }
  console.log(`Max distance from any stop to polyline: ${maxStopDist.toFixed(1)} m`);
}

