import { UnivusClient } from '../src/univus_client.js';
import { writeFileSync } from 'fs';

async function main() {
  const client = new UnivusClient();
  // Get session
  await client.fetchBuses();
  
  // We can use a test method or inspect proxy responses
  const session = client.getStatus();
  console.log('Session status:', session);
}

main().catch(console.error);

