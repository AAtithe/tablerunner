import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoPage as build } from '../scripts/build-static.js';

test('static build bundles the engine with no module imports left', () => {
  const html = build();
  assert.match(html, /window\.tableRunnerApi/);
  assert.match(html, /<title>Table Runner<\/title>/);
  const scripts = html.split('<script type="module">').slice(1).map((s) => s.split('</script>')[0]);
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.doesNotMatch(s, /^\s*(import|export)\s/m);
});
