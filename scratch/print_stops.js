import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('scratch/univus_bus_stops.json', 'utf8'));
console.log(`Total bus stops: ${data.busstops.length}`);
for (const stop of data.busstops) {
  console.log(`${stop.name.padEnd(16)} | ${stop.caption.padEnd(30)} | [${stop.latitude}, ${stop.longitude}]`);
}

