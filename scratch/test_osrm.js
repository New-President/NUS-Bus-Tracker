async function testOSRM() {
  // Let's test routing between COM3 and Opp HSSML and Ventus
  // COM3: [1.294431, 103.775217], Opp HSSML: [1.292798, 103.774978]
  const p1 = '103.775217,1.294431';
  const p2 = '103.774978,1.292798';
  
  // Test driving profile
  const driveUrl = `https://router.project-osrm.org/route/v1/driving/${p1};${p2}?overview=full&geometries=geojson`;
  const driveRes = await fetch(driveUrl);
  const driveJson = await driveRes.json();
  console.log('Driving result code:', driveJson.code);
  if (driveJson.routes && driveJson.routes[0]) {
    console.log('Driving distance:', driveJson.routes[0].distance, 'coords count:', driveJson.routes[0].geometry.coordinates.length);
  }

  // Test bicycle profile
  const bikeUrl = `https://router.project-osrm.org/route/v1/bicycle/${p1};${p2}?overview=full&geometries=geojson`;
  const bikeRes = await fetch(bikeUrl);
  const bikeJson = await bikeRes.json();
  console.log('Bicycle result code:', bikeJson.code);
  if (bikeJson.routes && bikeJson.routes[0]) {
    console.log('Bicycle distance:', bikeJson.routes[0].distance, 'coords count:', bikeJson.routes[0].geometry.coordinates.length);
  }
}

testOSRM().catch(console.error);

