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
  for (const sc of loginRes.headers.getSetCookie()) {
    cookies.push(sc.split(';')[0]);
  }
  let xsrf = '';
  for (const c of cookies) {
    if (c.startsWith('UNIVUS_WEB_XSRF_TOKEN=')) {
      xsrf = decodeURIComponent(c.slice('UNIVUS_WEB_XSRF_TOKEN='.length));
    }
  }

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
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  for (const route of ['R1', 'R2', 'BTC', 'P']) {
    const res = await esbPost({ methodpath: '/univus/api/bus-proxy/pickup-point', route_code: route });
    console.log(`Route ${route}:`, res?.code, res?.data?.pickuppoint?.length);
  }
}

main().catch(console.error);

