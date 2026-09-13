import { readFileSync, writeFileSync } from 'fs';

const pickupData = JSON.parse(readFileSync('scratch/univus_pickup_points.json', 'utf8'));

async function routeLeg(p1, p2) {
  // Format: lng,lat
  const coordStr = `${p1.lng},${p1.lat};${p2.lng},${p2.lat}`;
  // Try driving first
  try {
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`);
    const json = await res.json();
    if (json.code === 'Ok' && json.routes && json.routes[0]) {
      const coords = json.routes[0].geometry.coordinates.map(c => [Number(c[1].toFixed(5)), Number(c[0].toFixed(5))]);
      return { coords, distance: json.routes[0].distance, profile: 'driving' };
    }
  } catch {}
  
  // Try bicycle if driving fails or detours
  try {
    const res = await fetch(`https://router.project-osrm.org/route/v1/bicycle/${coordStr}?overview=full&geometries=geojson`);
    const json = await res.json();
    if (json.code === 'Ok' && json.routes && json.routes[0]) {
      const coords = json.routes[0].geometry.coordinates.map(c => [Number(c[1].toFixed(5)), Number(c[0].toFixed(5))]);
      return { coords, distance: json.routes[0].distance, profile: 'bicycle' };
    }
  } catch {}

  // Fallback direct line
  return {
    coords: [[Number(p1.lat.toFixed(5)), Number(p1.lng.toFixed(5))], [Number(p2.lat.toFixed(5)), Number(p2.lng.toFixed(5))]],
    distance: 0,
    profile: 'direct'
  };
}

async function buildRoute(routeCode) {
  const points = pickupData[routeCode]?.pickuppoint;
  if (!points || !points.length) {
    console.log(`No points for ${routeCode}`);
    return [];
  }
  console.log(`\n=== Processing ${routeCode} (${points.length} stops) ===`);
  const fullPath = [];
  
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const leg = await routeLeg(from, to);
    console.log(`Leg ${i + 1}: ${from.ShortName} -> ${to.ShortName} | dist: ${leg.distance.toFixed(0)}m | profile: ${leg.profile} | pts: ${leg.coords.length}`);
    
    // Check if distance is suspiciously long (e.g. detoured off campus > 2000m)
    if (leg.distance > 2200) {
      console.warn(`  WARNING: Leg ${from.ShortName} -> ${to.ShortName} is ${leg.distance}m, checking bicycle profile!`);
      const bikeLeg = await (await fetch(`https://router.project-osrm.org/route/v1/bicycle/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`)).json();
      if (bikeLeg.routes?.[0] && bikeLeg.routes[0].distance < leg.distance) {
        console.log(`  Bicycle distance: ${bikeLeg.routes[0].distance}m! Using bicycle profile.`);
        leg.coords = bikeLeg.routes[0].geometry.coordinates.map(c => [Number(c[1].toFixed(5)), Number(c[0].toFixed(5))]);
      }
    }

    if (fullPath.length === 0) {
      fullPath.push(...leg.coords);
    } else {
      // Append without duplicating the junction point
      fullPath.push(...leg.coords.slice(1));
    }
    // Small pause to be gentle on OSRM demo server
    await new Promise(r => setTimeout(r, 200));
  }
  return fullPath;
}

async function main() {
  const result = {};
  for (const code of ['A1', 'A2', 'D1', 'D2', 'K']) {
    result[code] = await buildRoute(code);
    console.log(`Finished ${code}: total ${result[code].length} polyline coordinates`);
  }
  writeFileSync('scratch/generated_routes.json', JSON.stringify(result, null, 2));
}

main().catch(console.error);

