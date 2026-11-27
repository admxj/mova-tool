const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

test('load requires the renderer readiness signal and fails on renderer loss', async () => {
  const contents = new EventEmitter();
  contents.executeJavaScript = async () => false;
  const win = { webContents: contents, loadURL: async (url) => assert.equal(url, rendererUrl) };
  await assert.rejects(loadRenderer(win), /ready/);
  contents.executeJavaScript = async () => true;
  await loadRenderer(win);
  win.loadURL = async () => { contents.emit('render-process-gone'); };
  await assert.rejects(loadRenderer(win), /renderer process/);
  assert.equal(contents.listenerCount('render-process-gone'), 0);
});
const { createRendererOrigin, rendererUrl, loadRenderer, migrateRendererStorage } = require('../renderer-origin');

test('migration copies allowlisted legacy storage into the new origin and destroys the helper window', async () => {
  const history = [];
  class Helper {
    async loadFile(file) { history.push(file); }
    async loadURL(url) { history.push(url); }
    webContents = { executeJavaScript: async (source) => {
      history.push(source);
      return { 'tmc.settings.v1': 'fixture', 'unrelated': 'ignore' };
    } };
    destroy() { history.push('destroy'); }
  }
  await migrateRendererStorage(Helper, '/legacy/index.html');
  assert.equal(history[0], '/legacy/index.html');
  assert.equal(history[2], 'tmc-ui://app/storage-migration.html');
  assert.match(history[3], /getItem\(key\) === null/);
  assert.match(history[3], /fixture/);
  assert.doesNotMatch(history[3], /unrelated/);
  assert.equal(history.at(-1), 'destroy');
});

test('the same local origin serves bundled and verified renderer files without mixing them', async () => {
  const origin = createRendererOrigin(async (name) => name === 'index.html' ? Buffer.from('bundled') : Buffer.from('bundled asset'));
  const request = (url = rendererUrl, method = 'GET') => origin.handle({ url, method });
  assert.equal(await (await request()).text(), 'bundled');
  origin.use({ files: new Map([['index.html', Buffer.from('verified')]]) });
  assert.equal(await (await request()).text(), 'verified');
  assert.equal((await request('tmc-ui://app/bundle.js')).status, 404);
  assert.equal((await request('tmc-ui://app/%2e%2e%2fsettings.json')).status, 404);
  assert.equal((await request('tmc-ui://outside/index.html')).status, 404);
  assert.equal((await request(rendererUrl, 'POST')).status, 405);
});
