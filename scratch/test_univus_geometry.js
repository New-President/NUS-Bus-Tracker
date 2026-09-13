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

  const paths = [
    '/univus/api/bus-proxy/checkpoint',
    '/univus/api/bus-proxy/route-checkpoint',
    '/univus/api/bus-proxy/route-map',
    '/univus/api/bus-proxy/route-path',
    '/univus/api/bus-proxy/route-info',
    '/univus/api/bus-proxy/route-geometry',
    '/univus/api/bus-proxy/routes',
    '/univus/api/bus-proxy/bus-routes',
    '/univus/api/bus-proxy/service-description',
    '/univus/api/bus-proxy/route-min-max-time'
  ];

  for (const p of paths) {
    const res = await esbPost({ methodpath: p, route_code: 'D1' });
    if (res && res.code === '00000') {
      console.log(`SUCCESS [${p}]:`, Object.keys(res.data || {}));
    } else {
      console.log(`FAILED [${p}]:`, res?.code, res?.msg);
    }
  }
}

main().catch(console.error);

