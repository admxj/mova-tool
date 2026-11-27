const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { selectUpdate, downloadUpdate, createUpdateCheck, selectUpdateTracks, listReleases } = require('../updater');

const data = 'sample disk image';
const asset = { name: 'TMC.-1.10.0-arm64.dmg', size: Buffer.byteLength(data),
  browser_download_url: 'https://github.com/admxj/mova-tool/releases/download/v1.10.0/TMC.-1.10.0-arm64.dmg',
  digest: `sha256:${createHash('sha256').update(data).digest('hex')}` };
const release = { tag_name: 'v1.10.0', assets: [asset] };

function patch(version) {
  const name = 'tmc-renderer.json';
  return { tag_name: `v${version}`, assets: [{ ...asset, name,
    browser_download_url: `https://github.com/admxj/mova-tool/releases/download/v${version}/${name}` }] };
}

test('selects compatible renderer and newer desktop independently', () => {
  const releases = [patch('1.10.4'), patch('1.9.11'), release, patch('1.9.10'), patch('1.9.9')];
  const offers = selectUpdateTracks(releases, '1.9.0', '1.9.10');
  assert.equal(offers.renderer.version, '1.9.11');
  assert.equal(offers.desktop.version, '1.10.0');
  assert.equal(selectUpdateTracks(releases, '1.9.0', '1.9.11').renderer, null);
});

test('reads subsequent release pages without accepting third-party Link URLs', async () => {
  const calls = [];
  const result = await listReleases(async (url) => {
    calls.push(url);
    return Response.json(calls.length === 1 ? [release] : [patch('1.9.11')], { headers: calls.length === 1
      ? { link: '<https://evil.example/page=2>; rel="next"' } : {} });
  });
  assert.equal(result.length, 2);
  assert.deepEqual(calls.map((url) => new URL(url).host), ['api.github.com', 'api.github.com']);
});

test('selects only newer stable arm64 DMGs from the pinned repository', () => {
  assert.equal(selectUpdate(release, '1.9.0').version, '1.10.0');
  assert.equal(selectUpdate(release, '1.10.0'), null);
  assert.equal(selectUpdate({ ...release, prerelease: true }, '1.0.0'), null);
  assert.throws(() => selectUpdate({ ...release, assets: [{ ...asset, browser_download_url: 'https://example.com/a.dmg' }] }, '1.0.0'));
  assert.throws(() => selectUpdate({ ...release, assets: [{ ...asset, digest: null }] }, '1.0.0'));
});

test('offers the newest desktop first, then installs a compatible renderer if offered alone', async () => {
  let running = '1.9.0';
  const applied = [];
  const prompts = [];
  const check = createUpdateCheck({
    app: { getVersion: () => '1.9.0' },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, setProgressBar() {} }] },
    dialog: { showMessageBox: async (_win, options) => { prompts.push(options); return { response: prompts.length === 1 ? 1 : 0 }; } },
    shell: {},
  }, async (url) => url.startsWith('https://api.github.com/') ? Response.json(prompts.length === 0 ? [release, patch('1.9.1')] : [patch('1.9.1')]) : new Response(data), {
    version: () => running,
    activate: async (_win, version, body) => { running = version; applied.push(body.toString()); },
  });
  await check();
  await check();
  assert.deepEqual(applied, [data]);
  await check(true);
  assert.deepEqual(prompts.map(prompt => prompt.message), ['发现新版本 1.10.0', '发现新版本 1.9.1', '已是最新版本（1.9.1）']);
  for (const prompt of prompts.slice(0, 2)) assert.deepEqual(prompt.buttons, ['升级', '取消']);
});

test('streams a verified image and removes a failed download', async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'tmc-update-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const update = selectUpdate(release, '1.0.0');
  const progress = [];
  const image = await downloadUpdate(update, dir, (n) => progress.push(n), async () => new Response(data));
  assert.equal(await fs.readFile(image, 'utf8'), data);
  assert.equal(progress.at(-1), 1);
  await assert.rejects(downloadUpdate(update, dir, () => {}, async () => new Response('x'.repeat(asset.size))), /SHA-256/);
  assert.equal((await fs.readdir(dir)).length, 1);
});

test('cancel skips downloads and upgrade opens a verified DMG', async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'tmc-update-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const opened = [];
  const progress = [];
  let choice = 1;
  const check = createUpdateCheck({
    app: { getVersion: () => '1.0.0', getPath: () => dir },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, setProgressBar: (p) => progress.push(p) }] },
    dialog: { showMessageBox: async (_win, options) => {
      assert.deepEqual(options.buttons, ['升级', '取消']);
      return { response: choice };
    } },
    shell: { openExternal: async (url) => opened.push(url), openPath: async (file) => {
      opened.push(await fs.readFile(file, 'utf8'));
      return '';
    } },
  }, async (url) => url === asset.browser_download_url ? new Response(data) : Response.json([release]));
  await check();
  assert.deepEqual(opened, []);
  assert.deepEqual(progress, []);
  choice = 0;
  await check();
  assert.equal(opened.at(-1), data);
  assert.deepEqual(progress.slice(-2), [1, -1]);
});
