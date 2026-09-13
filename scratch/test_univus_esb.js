import { UnivusClient } from '../src/univus_client.js';

async function main() {
  const client = new UnivusClient();
  // Get active buses first to test connection and session
  try {
    const buses = await client.fetchBuses();
    console.log('Active buses count:', buses.length);
    if (buses.length > 0) {
      console.log('Sample bus:', buses[0]);
    }
  } catch (err) {
    console.error('fetchBuses error:', err);
  }
}

main();

