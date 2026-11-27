// Run with Electron, not Node. Uses only an isolated profile and ephemeral keys.
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
const { scheme, createRendererOrigin, loadRenderer, migrateRendererStorage } = require('../renderer-origin');
const { createRendererStore, signRenderer } = require('../renderer-update');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmc-update-smoke-'));
app.setPath('userData', root);
protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.whenReady().then(async () => {
  const bundle = new Map([
    ['index.html', Buffer.from('<!doctype html><title>bundled</title><script defer src="app.js"></script>')],
    ['app.js', Buffer.from('document.documentElement.dataset.tmcReady = "1"')],
  ]);
  const legacy = path.join(root, 'legacy.html');
  fs.writeFileSync(legacy, '<!doctype html><title>legacy</title>');
  const origin = createRendererOrigin(async (name) => bundle.get(name));
  protocol.handle(scheme, origin.handle);
  const win = new BrowserWindow({ show: false });
  const run = (source) => win.webContents.executeJavaScript(source);
  await win.loadFile(legacy);
  await run(`localStorage.setItem('tmc.settings.v1', 'legacy'); localStorage.setItem('tmc.browserId', 'legacy-id'); localStorage.setItem('unrelated', 'ignore')`);
  await loadRenderer(win);
  await run(`localStorage.setItem('tmc.settings.v1', 'existing')`);
  await migrateRendererStorage(BrowserWindow, legacy);
  await loadRenderer(win);
  assert.deepEqual(await run(`['tmc.settings.v1', 'tmc.browserId', 'unrelated'].map(k => localStorage.getItem(k))`), ['existing', 'legacy-id', null]);

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const patchDir = path.join(root, 'patches');
  const store = createRendererStore(patchDir, '1.1.0', publicKey);
  const load = async (patch) => { origin.use(patch); await loadRenderer(win); };
  const pack = (version, ready) => signRenderer(version, new Map([
    ['index.html', Buffer.from(`<title>${version}</title><script defer src="app.js"></script>`)],
    ['app.js', Buffer.from(ready ? 'document.documentElement.dataset.tmcReady = "1"' : '')],
  ]), privateKey);
  await store.activate('1.1.1', pack('1.1.1', true), load);
  assert.equal(await run('document.title'), '1.1.1');
  assert.equal(await run(`localStorage.getItem('tmc.browserId')`), 'legacy-id');
  await assert.rejects(store.activate('1.1.2', pack('1.1.2', false), load), /did not report ready/);
  assert.equal(await run('document.title'), '1.1.1');
  assert.equal(store.version, '1.1.1');
  const restored = createRendererStore(patchDir, '1.1.0', publicKey);
  await load(await restored.restore());
  assert.equal(await run('document.title'), '1.1.1');
  console.log('[update smoke] legacy migration, signed reload, failed reload rollback and disk restore passed');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
app.on('will-quit', () => {});
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
