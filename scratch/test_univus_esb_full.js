import { writeFileSync } from 'fs';

async function main() {
  const ORIGIN = 'https://inetapps.nus.edu.sg';
  const WEB_BASE = `${ORIGIN}/univus/web/`;
  const LOGIN_URL = `${WEB_BASE}api/login/loginPublic`;

  const loginRes = await fetch(LOGIN_URL, {
    method: 'GET',
    redirect: 'manual',
    headers: { Accept: 'text/html', Referer: WEB_BASE }
  });

  const cookies = [];
  const setCookies = loginRes.headers.getSetCookie();
  for (const sc of setCookies) {
    const pair = sc.split(';')[0];
    cookies.push(pair);
  }

  let xsrf = '';
  for (const c of cookies) {
    if (c.startsWith('UNIVUS_WEB_XSRF_TOKEN=')) {
      xsrf = decodeURIComponent(c.slice('UNIVUS_WEB_XSRF_TOKEN='.length));
    }
  }

  console.log('Login status:', loginRes.status, 'XSRF found:', !!xsrf);

  async function esbPost(body) {
    const res = await fetch(`${ORIGIN}/univus/web/api/esb`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-XSRF-TOKEN': xsrf,
        Cookie: cookies.join('; '),
        Origin: ORIGIN,
        Referer: WEB_BASE
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // 1. Test bus-stops
  console.log('--- Testing /univus/api/bus-proxy/bus-stops ---');
  const stopsRes = await esbPost({ methodpath: '/univus/api/bus-proxy/bus-stops' });
  console.log('Stops code:', stopsRes.code, 'msg:', stopsRes.msg);
  if (stopsRes.data) {
    console.log('Stops keys:', Object.keys(stopsRes.data));
    writeFileSync('scratch/univus_bus_stops.json', JSON.stringify(stopsRes.data, null, 2));
  }

  // 2. Test pickup-points for each route
  const routes = ['A1', 'A2', 'D1', 'D2', 'E', 'K'];
  const allPickupPoints = {};
  for (const route of routes) {
    console.log(`--- Testing /univus/api/bus-proxy/pickup-point for ${route} ---`);
    const ppRes = await esbPost({ methodpath: '/univus/api/bus-proxy/pickup-point', route_code: route });
    console.log(`Route ${route} code:`, ppRes.code, 'data keys:', ppRes.data ? Object.keys(ppRes.data) : 'none');
    if (ppRes.data) {
      allPickupPoints[route] = ppRes.data;
    }
  }
  writeFileSync('scratch/univus_pickup_points.json', JSON.stringify(allPickupPoints, null, 2));

  // 3. Test service description
  console.log('--- Testing /univus/api/bus-proxy/service-description ---');
  const descRes = await esbPost({ methodpath: '/univus/api/bus-proxy/service-description' });
  console.log('Service description code:', descRes.code);
  if (descRes.data) {
    writeFileSync('scratch/univus_service_description.json', JSON.stringify(descRes.data, null, 2));
  }
}

main().catch(console.error);

