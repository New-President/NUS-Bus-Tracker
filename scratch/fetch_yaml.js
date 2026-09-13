import { writeFileSync } from 'fs';

async function fetchYaml() {
  const res = await fetch('https://raw.githubusercontent.com/SuibianP/nus-nextbus-new-api/master/NextBus.yaml');
  const text = await res.text();
  console.log('Fetched NextBus.yaml length:', text.length);
  writeFileSync('scratch/NextBus_full.yaml', text);
}

fetchYaml().catch(console.error);

