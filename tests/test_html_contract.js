import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

export function testHtmlContract() {
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML element IDs must be unique');

  const referencedIds = [...app.matchAll(/(?:getElementById|\$|setText)\(['"]([^'"]+)['"]/g)].map(match => match[1]);
  for (const id of referencedIds) assert.ok(ids.includes(id), `Missing application element: ${id}`);

  const tabs = [...html.matchAll(/data-tab=["']([^"']+)["']/g)].map(match => match[1]);
  assert.ok(tabs.length >= 4, 'History, map, analytics, and fleet views remain available');
  for (const tab of tabs) assert.ok(ids.includes(tab), `Missing tab panel: ${tab}`);
  for (const id of ['timelineChart', 'hourlyBarChart', 'leafletMap']) {
    assert.ok(ids.includes(id), `Missing chart or map: ${id}`);
  }
  for (const id of ['sourceLink', 'coverageSummary', 'providerWarning', 'diagTokenExpiry']) {
    assert.ok(ids.includes(id), `Missing source, coverage, or renewal disclosure: ${id}`);
  }
  assert.ok(html.indexOf('id="coverageSummary"') < html.indexOf('id="statActiveBuses"'), 'Source coverage is disclosed beside the dashboard counts');
  assert.doesNotMatch(html, /Reported \/ Known Fleet|Campus Hourly Occupancy/, 'Count and chart labels describe observed vehicles');
  for (const match of html.matchAll(/<label\b[^>]*\bfor=["']([^"']+)["']/g)) {
    assert.ok(ids.includes(match[1]), `Label refers to missing input: ${match[1]}`);
  }
  assert.ok(/leaflet[^"']*\.css/.test(html), 'The map stylesheet is loaded');
  assert.ok(/leaflet[^"']*\.js/.test(html), 'The map script is loaded');
  assert.doesNotThrow(() => new vm.Script(app, { filename: 'public/app.js' }), 'Browser script parses');
}

test('dashboard DOM, navigation, labels, and browser script stay consistent', testHtmlContract);
