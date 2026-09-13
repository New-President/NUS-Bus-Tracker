import { GuestTokenProvider } from '../src/univus_auth.js';

async function testInitData() {
  const provider = new GuestTokenProvider();
  // We can access private methods or inspect what get-init-data returns
  // Let's do the exact fetch that univus_auth does
  const context = { deviceid: '921136b6-39a0-4354-9426-38ee0d20d4f2', ipaddr: '0.0.0.0', version: '3.2.14' };
  
  const tokenRes = await fetch('https://inetapps.nus.edu.sg/univus-public/mobile/get-access-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(context)
  });
  const tokenJson = await tokenRes.json();
  console.log('Access token response code:', tokenJson.code);
  const access = tokenJson.data;
  
  const initRes = await fetch('https://inetapps.nus.edu.sg/univus/mobile/buswidget/get-init-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...context,
      domain: access.domain,
      token: access.token,
      userid: access.userid
    })
  });
  const initJson = await initRes.json();
  console.log('Init data response code:', initJson.code);
  console.log('Init data keys:', Object.keys(initJson.data || {}));
  
  // Let's print out what is inside initJson.data!
  if (initJson.data) {
    for (const [k, v] of Object.entries(initJson.data)) {
      if (k === 'tokens') {
        console.log(`Key ${k}: tokens present`);
      } else {
        console.log(`Key ${k}:`, typeof v, Array.isArray(v) ? `Array(${v.length})` : v);
        if (Array.isArray(v) && v.length > 0) {
          console.log(`  Sample ${k}[0]:`, JSON.stringify(v[0]).slice(0, 300));
        }
      }
    }
  }
}

testInitData().catch(console.error);

