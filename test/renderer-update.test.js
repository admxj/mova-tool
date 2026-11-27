const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { signRenderer, verifyRenderer, createRendererStore } = require('../renderer-update');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const files = new Map([['index.html', Buffer.from('<main>hello</main>')], ['assets/app.js', Buffer.from('void 0')]]);

test('round trips a signed full renderer for the exact release and desktop base', () => {
  const pack = signRenderer('1.2.3', files, privateKey);
  assert.deepEqual(verifyRenderer(pack, '1.2.3', publicKey), files);
  assert.throws(() => verifyRenderer(pack, '1.2.4', publicKey), /version/);
});

test('rejects tampered or untrusted renderer packages', () => {
  const pack = JSON.parse(signRenderer('1.2.3', files, privateKey));
  pack.payload = Buffer.from('altered').toString('base64');
  assert.throws(() => verifyRenderer(JSON.stringify(pack), '1.2.3', publicKey), /signature/);
  const otherKey = generateKeyPairSync('ed25519').publicKey;
  assert.throws(() => verifyRenderer(signRenderer('1.2.3', files, privateKey), '1.2.3', otherKey), /signature/);
});

test('persists only successful activation and recovers the last verified renderer', async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'tmc-renderer-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createRendererStore(dir, '1.2.0', publicKey);
  const calls = [];
  const load = async (patch) => {
    calls.push(patch?.version);
    if (patch?.version === '1.2.4') throw new Error('load failed');
  };
  await store.activate('1.2.3', signRenderer('1.2.3', files, privateKey), load);
  await assert.rejects(store.activate('1.2.4', signRenderer('1.2.4', files, privateKey), load), /load failed/);
  assert.deepEqual(calls, ['1.2.3', '1.2.4', '1.2.3']);
  assert.equal((await createRendererStore(dir, '1.2.0', publicKey).restore()).version, '1.2.3');
  assert.equal(await createRendererStore(dir, '1.3.0', publicKey).restore(), null);
  await assert.rejects(store.activate('1.2.2', signRenderer('1.2.2', files, privateKey), load), /version/);
  await fs.writeFile(path.join(dir, '1.2.json'), '{}');
  assert.equal(await createRendererStore(dir, '1.2.0', publicKey).restore(), null);
});

test('rejects unsafe paths and case-insensitive collisions', () => {
  for (const name of ['../escape', 'assets/../../escape', '/absolute', 'assets\\escape', 'INDEX.html']) {
    assert.throws(() => signRenderer('1.2.3', new Map([...files, [name, Buffer.from('bad')]]), privateKey), /path/);
  }
});
