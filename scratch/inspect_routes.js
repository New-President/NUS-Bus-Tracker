import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('scratch/generated_routes.json', 'utf8'));
for (const [k, v] of Object.entries(data)) {
  console.log(`${k}: ${v.length} points`);
}
const text = JSON.stringify(data);
console.log('Total JSON length:', text.length);

