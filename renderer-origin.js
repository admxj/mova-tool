const { extname } = require('node:path');

const scheme = 'tmc-ui';
const rendererUrl = `${scheme}://app/index.html`;
const storageUrl = `${scheme}://app/storage-migration.html`;
const storageKeys = ['tmc.settings.v1', 'tmc.token.v1', 'tmc.userinfo.v1', 'tmc.browserId', 'tmc.hotel.search.v1', 'tmc.flight.search.v1'];
const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'], ['.woff2', 'font/woff2'], ['.ico', 'image/x-icon'],
]);

function createRendererOrigin(readBundled) {
  let current = null;
  return {
    use(patch) { current = patch; },
    async handle({ url, method }) {
      if (method !== 'GET') return new Response(null, { status: 405 });
      const parsed = new URL(url);
      const name = parsed.pathname.slice(1);
      if (parsed.protocol !== `${scheme}:` || parsed.host !== 'app' || parsed.username || parsed.password ||
          !name.split('/').every((part) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) && !part.endsWith('.'))) {
        return new Response(null, { status: 404 });
      }
      const type = types.get(extname(name));
      if (!type) return new Response(null, { status: 404 });
      const bytes = name === 'storage-migration.html' ? '<!doctype html><meta charset="utf-8">' :
        current ? current.files.get(name) : await readBundled(name);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(bytes, { headers: {
        'content-type': type, 'content-security-policy': csp, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      } });
    },
  };
}

async function loadRenderer(win) {
  const contents = win.webContents;
  let timer;
  let died;
  const interrupted = new Promise((_, reject) => {
    died = () => reject(new Error('Lost renderer process before ready'));
    contents.once('render-process-gone', died);
    contents.once('destroyed', died);
    timer = setTimeout(() => reject(new Error('Renderer ready timed out')), 15_000);
  });
  const navigation = async () => {
    await win.loadURL(rendererUrl);
    if (!await contents.executeJavaScript('document.documentElement.dataset.tmcReady === "1"')) {
      throw new Error('Renderer did not report ready');
    }
  };
  try { await Promise.race([interrupted, navigation()]); }
  finally {
    clearTimeout(timer);
    contents.removeListener('render-process-gone', died);
    contents.removeListener('destroyed', died);
  }
}

async function migrateRendererStorage(BrowserWindow, legacyFile) {
  const helper = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    helper.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    await helper.loadFile(legacyFile);
    const values = await helper.webContents.executeJavaScript(`Object.fromEntries(${JSON.stringify(storageKeys)}.map(key => [key, localStorage.getItem(key)]))`);
    const entries = storageKeys.filter((key) => typeof values?.[key] === 'string').map((key) => [key, values[key]]);
    if (!entries.length) return;
    await helper.loadURL(storageUrl);
    await helper.webContents.executeJavaScript(`for (const [key, value] of ${JSON.stringify(entries)}) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }`);
  } finally {
    helper.destroy();
  }
}

module.exports = { scheme, rendererUrl, createRendererOrigin, loadRenderer, migrateRendererStorage };
