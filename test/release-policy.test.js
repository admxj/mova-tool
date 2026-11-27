const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyRelease, normalizeVersionMetadata } = require('../scripts/release-policy');

test('patch releases allow renderer changes and reject runtime or build changes', () => {
  assert.equal(classifyRelease('v1.2.3', 'v1.2.4', ['renderer/app.js', 'package.json']), 'renderer');
  for (const name of ['main.js', 'preload.js', 'updater.js', 'new-runtime.js', 'binding.node', '.github/workflows/release-macos.yml']) {
    assert.throws(() => classifyRelease('v1.2.3', 'v1.2.4', ['renderer/app.js', name]), /desktop/);
  }
  assert.throws(() => classifyRelease('v1.2.3', 'v1.2.4', ['package.json']), /renderer/);
});

test('desktop release increments the base and resets patch to zero', () => {
  assert.equal(classifyRelease('v1.2.3', 'v1.3.0', ['preload.js']), 'desktop');
  assert.throws(() => classifyRelease('v1.2.3', 'v1.3.1', ['main.js']), /version/);
  assert.throws(() => classifyRelease('v1.2.3', 'v2.0.0', ['main.js']), /version/);
  assert.throws(() => classifyRelease('v1.2.3', 'v1.2.3', []), /version/);
});

test('only root version metadata can differ for package manifests', () => {
  const base = { name: 'tmc-tool', version: '1.2.3', packages: { '': { version: '1.2.3' }, 'node_modules/electron': { version: '45' } } };
  const patch = structuredClone(base);
  patch.version = patch.packages[''].version = '1.2.4';
  assert.deepEqual(normalizeVersionMetadata('package-lock.json', base), normalizeVersionMetadata('package-lock.json', patch));
  patch.packages['node_modules/electron'].version = '46';
  assert.notDeepEqual(normalizeVersionMetadata('package-lock.json', base), normalizeVersionMetadata('package-lock.json', patch));
});
