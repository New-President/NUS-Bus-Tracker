import { readFileSync, writeFileSync } from 'fs';

const rawStops = JSON.parse(readFileSync('scratch/univus_bus_stops.json', 'utf8')).busstops;
const pickupData = JSON.parse(readFileSync('scratch/univus_pickup_points.json', 'utf8'));
const genRoutes = JSON.parse(readFileSync('scratch/generated_routes.json', 'utf8'));

// Filter out off-campus stops (Bukit Timah Campus: CG, OTH, BG-MRT)
const campusStops = rawStops.filter(s => s.latitude < 1.31);

console.log(`Kent Ridge campus stops count: ${campusStops.length}`);

// Map of code to standard display name
const stopDisplayNames = {
  'COM3': 'COM 3 (School of Computing)',
  'TCOMS-OPP': 'Opp TCOMS',
  'PGP': "Prince George's Park (PGP)",
  'KR-MRT': 'Kent Ridge MRT (Exit A)',
  'LT27': 'Faculty of Science (LT27)',
  'UHALL': 'University Hall',
  'UHC-OPP': 'Opp University Health Centre',
  'MUSEUM': 'NUS Museum',
  'UTOWN': 'University Town (UTown)',
  'UHC': 'University Health Centre (UHC)',
  'UHALL-OPP': 'Opp University Hall',
  'S17': 'Faculty of Science (S17)',
  'KR-MRT-OPP': 'Opp Kent Ridge MRT',
  'PGPR': "Prince George's Park Residences (PGPR)",
  'TCOMS': 'TCOMS',
  'HSSML-OPP': 'Opp Hon Sui Sen Memorial Library',
  'NUSS-OPP': 'Opp NUSS Guild House',
  'LT13-OPP': 'Ventus (Opp LT13)',
  'IT': 'Information Technology (IT)',
  'YIH-OPP': 'Opp Yusof Ishak House (Opp YIH)',
  'YIH': 'Yusof Ishak House (YIH)',
  'CLB': 'Central Library (CLB)',
  'LT13': 'Lecture Theatre 13 (LT13)',
  'AS5': 'Faculty of Arts (AS5)',
  'BIZ2': 'Business School (BIZ 2)',
  'KRB': 'Kent Ridge Bus Terminal',
  'SDE3-OPP': 'Opp SDE 3',
  'JP-SCH-16151': 'The Japanese Primary School',
  'KV': 'Kent Vale',
  'RAFFLES': 'Raffles Hall'
};

const busStopsArray = campusStops.map(s => ({
  name: stopDisplayNames[s.name] || s.caption,
  code: s.name,
  lat: Number(s.latitude.toFixed(6)),
  lng: Number(s.longitude.toFixed(6))
}));

// Route stops sets
const routeStopsMap = {};
for (const [routeCode, data] of Object.entries(pickupData)) {
  const points = data.pickuppoint || [];
  const stopCodes = new Set();
  for (const pt of points) {
    // Determine the base stop code
    let baseCode = pt.busstopcode;
    if (baseCode.startsWith('KRB-')) baseCode = 'KRB';
    if (baseCode.startsWith('COM3-')) baseCode = 'COM3';
    stopCodes.add(baseCode);
  }
  routeStopsMap[routeCode] = Array.from(stopCodes);
}

// For E, add UTown, Museum, YIH, CLB, LT13, AS5, BIZ2, COM3
routeStopsMap.E = ['UTOWN', 'MUSEUM', 'YIH', 'CLB', 'LT13', 'AS5', 'BIZ2', 'COM3'];

console.log('Route stops mapping:', Object.keys(routeStopsMap).map(k => `${k}: ${routeStopsMap[k].length} stops`).join(', '));

writeFileSync('scratch/bus_stops_formatted.json', JSON.stringify(busStopsArray, null, 2));
writeFileSync('scratch/route_stops_formatted.json', JSON.stringify(routeStopsMap, null, 2));

