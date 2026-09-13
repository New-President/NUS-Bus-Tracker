async function main() {
  const ORIGIN = 'https://inetapps.nus.edu.sg';
  const WEB_BASE = `${ORIGIN}/univus/web/`;
  const LOGIN_URL = `${WEB_BASE}api/login/loginPublic`;

  const loginRes = await fetch(LOGIN_URL, {
    method: 'GET',
    redirect: 'manual',
    headers: { Accept: 'text/html', Referer: WEB_BASE }
  });

  const cookies = loginRes.headers.getSetCookie().map(s => s.split(';')[0]);
  const xsrf = decodeURIComponent(cookies.find(c => c.startsWith('UNIVUS_WEB_XSRF_TOKEN='))?.slice('UNIVUS_WEB_XSRF_TOKEN='.length) || '');

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
    return res.json();
  }

  for (const r of ['R1', 'R2']) {
    const res = await esbPost({ methodpath: '/univus/api/bus-proxy/pickup-point', route_code: r });
    console.log(`\n=== ${r} ===`);
    for (const p of res.data?.pickuppoint || []) {
      console.log(`seq ${p.seq}: ${p.ShortName} [${p.lat}, ${p.lng}]`);
    }
  }
}

main().catch(console.error);

