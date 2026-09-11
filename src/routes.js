// Route identifiers shared by live providers; colors are presentation metadata.
const configured = (process.env.FMS_ROUTES || 'A1,A2,D1,D2,E,K')
  .split(',').map(code => code.trim().toUpperCase()).filter(Boolean);
if (!configured.length || configured.length > 20 || configured.some(code => !/^[A-Z0-9-]{1,12}$/.test(code))) {
  throw new Error('FMS_ROUTES must contain 1 to 20 comma-separated route identifiers.');
}
export const ROUTE_CODES = [...new Set(configured)];
const COLORS = { A1: '#FB0101', A2: '#FBAE17', D1: '#9E005D', D2: '#6A1B9A', E: '#00838F', K: '#2E7D32' };
export const NUS_ROUTES = Object.fromEntries(ROUTE_CODES.map(code => [code, {
  code, name: `Service ${code}`, color: COLORS[code] || '#3b82f6', fontColor: code === 'A2' ? '#000000' : '#FFFFFF'
}]));
