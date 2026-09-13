async function testBridge() {
  const p1 = '103.77369,1.301081'; // Museum
  const p2 = '103.774621,1.303876'; // UTown
  
  const driveRes = await (await fetch(`https://router.project-osrm.org/route/v1/driving/${p1};${p2}?overview=full&geometries=geojson`)).json();
  console.log('Museum -> UTown driving distance:', driveRes.routes?.[0]?.distance);

  const bikeRes = await (await fetch(`https://router.project-osrm.org/route/v1/bicycle/${p1};${p2}?overview=full&geometries=geojson`)).json();
  console.log('Museum -> UTown bicycle distance:', bikeRes.routes?.[0]?.distance);
}

testBridge().catch(console.error);

