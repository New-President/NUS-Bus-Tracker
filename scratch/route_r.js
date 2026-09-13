import { readFileSync, writeFileSync } from 'fs';

const pickupData = {
  R1: {
    pickuppoint: [
      { ShortName: "Kent Vale", lat: 1.301851, lng: 103.76955 },
      { ShortName: "Museum", lat: 1.301074, lng: 103.773659 },
      { ShortName: "UTown", lat: 1.303638, lng: 103.77472 },
      { ShortName: "YIH", lat: 1.298863, lng: 103.774321 },
      { ShortName: "CLB", lat: 1.296308, lng: 103.77216 },
      { ShortName: "LT 13", lat: 1.294814, lng: 103.770598 },
      { ShortName: "AS 5", lat: 1.293483, lng: 103.771779 },
      { ShortName: "BIZ 2", lat: 1.293367, lng: 103.775162 },
      { ShortName: "PGP", lat: 1.291805, lng: 103.78042 }
    ]
  },
  R2: {
    pickuppoint: [
      { ShortName: "PGP", lat: 1.291807, lng: 103.780418 },
      { ShortName: "Opp HSSML", lat: 1.292971, lng: 103.775081 },
      { ShortName: "Opp NUSS", lat: 1.293282, lng: 103.772437 },
      { ShortName: "Ventus", lat: 1.295353, lng: 103.770575 },
      { ShortName: "IT", lat: 1.297204, lng: 103.772688 },
      { ShortName: "Opp YIH", lat: 1.298961, lng: 103.774152 },
      { ShortName: "UTown", lat: 1.303667, lng: 103.774779 },
      { ShortName: "Raffles Hall", lat: 1.300946, lng: 103.772703 },
      { ShortName: "Kent Vale", lat: 1.301851, lng: 103.76955 }
    ]
  }
};

async function routeLeg(p1, p2) {
  const coordStr = `${p1.lng},${p1.lat};${p2.lng},${p2.lat}`;
  try {
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`);
    const json = await res.json();
    if (json.code === 'Ok' && json.routes && json.routes[0]) {
      const coords = json.routes[0].geometry.coordinates.map(c => [Number(c[1].toFixed(5)), Number(c[0].toFixed(5))]);
      return { coords, distance: json.routes[0].distance };
    }
  } catch {}
  return { coords: [[p1.lat, p1.lng], [p2.lat, p2.lng]], distance: 0 };
}

async function buildRoute(routeCode) {
  const points = pickupData[routeCode].pickuppoint;
  const fullPath = [];
  for (let i = 0; i < points.length - 1; i++) {
    const leg = await routeLeg(points[i], points[i + 1]);
    if (fullPath.length === 0) fullPath.push(...leg.coords);
    else fullPath.push(...leg.coords.slice(1));
    await new Promise(r => setTimeout(r, 200));
  }
  return fullPath;
}

async function main() {
  const existing = JSON.parse(readFileSync('scratch/generated_routes.json', 'utf8'));
  existing.R1 = await buildRoute('R1');
  existing.R2 = await buildRoute('R2');
  // For E, use UTown to COM 3 direct campus road
  existing.E = existing.D1.slice(0, 150); // E was UTown - BIZ express
  writeFileSync('scratch/generated_routes.json', JSON.stringify(existing, null, 2));
  console.log('R1 coords:', existing.R1.length, 'R2 coords:', existing.R2.length);
}

main().catch(console.error);

