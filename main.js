const { app, BrowserWindow, ipcMain, nativeImage, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const logoPath = path.join(__dirname, 'renderer', 'assets', 'tmc-logo.png');

// 显示名称变更后继续使用原来的本地配置目录。
app.setPath('userData', path.join(app.getPath('appData'), require('./package.json').name));

// 冒烟测试使用临时 userData，避免把 mock 配置和 token 写进真实配置。
if (process.env.TMC_SMOKE) {
  app.setPath('userData', path.join(os.tmpdir(), 'tmc-tool-smoke-profile'));
}

/**
 * 统一 HTTP 出口：渲染进程不直接发请求，避免 CORS，也方便统一超时与错误。
 * 只允许 http/https，防止被页面脚本引导去读本地文件。
 */
async function doHttp(options = {}) {
  const startedAt = Date.now();
  const {
    method = 'GET',
    url,
    headers = {},
    body,
    timeoutMs = 30000,
  } = options;

  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, status: 0, error: `不支持的 URL：${url}`, durationMs: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: body === undefined || body === null
        ? undefined
        : typeof body === 'string' ? body : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await response.text();
    const responseHeaders = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* 非 JSON 响应保留原文 */ }
    return {
      ok: response.ok,
      status: response.status,
      headers: responseHeaders,
      text,
      json,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    return {
      ok: false,
      status: 0,
      error: aborted ? `请求超时（${timeoutMs}ms）` : String(error && error.message ? error.message : error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    title: 'TMC 机票/酒店下单调试工具',
    icon: logoPath,
    backgroundColor: '#f4f6fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.on('console-message', (_event, ...args) => {
    const details = args[0] && typeof args[0] === 'object'
      ? args[0]
      : { level: args[0], message: args[1], lineNumber: args[2], sourceId: args[3] };
    const isError = details.level === 'error' || details.level === 3;
    if (isError) {
      console.error(`[renderer] ${details.message} (${details.sourceId || ''}:${details.lineNumber || ''})`);
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] process gone: ${details && details.reason}`);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.env.TMC_SMOKE) {
    win.webContents.once('did-finish-load', () => {
      const shot = async (name) => {
        const image = await win.webContents.capturePage();
        const out = process.env.TMC_SMOKE_OUT || path.join(app.getPath('temp'), 'tmc-tool-smoke.png');
        const target = name ? out.replace(/\.png$/, `-${name}.png`) : out;
        fs.writeFileSync(target, image.toPNG());
        console.log(`[smoke] screenshot: ${target}`);
      };
      setTimeout(async () => {
        try {
          await shot('');
          for (const view of ['hotel', 'login', 'settings', 'logs']) {
            await win.webContents.executeJavaScript(
              `document.querySelector('.tab[data-view="${view}"]').click();`,
            );
            await new Promise((resolve) => setTimeout(resolve, 350));
            await shot(view);
          }

          const stepsFile = process.env.TMC_SMOKE_STEPS_FILE;
          if (stepsFile) {
            const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
            for (const step of steps) {
              if (step.settings) {
                const payload = JSON.stringify(JSON.stringify(step.settings));
                await win.webContents.executeJavaScript(
                  `localStorage.setItem('tmc.settings.v1', ${payload});`,
                );
                await new Promise((resolve) => {
                  win.webContents.once('did-finish-load', resolve);
                  win.webContents.reload();
                });
                await new Promise((resolve) => setTimeout(resolve, 500));
              }
              if (step.js) {
                await win.webContents.executeJavaScript(`(function () {\n${step.js}\n})();`);
              }
              if (step.waitMs) await new Promise((resolve) => setTimeout(resolve, step.waitMs));
              if (step.shot) await shot(step.shot);
            }
          }
        } catch (error) {
          console.error(`[smoke] failed: ${error.message}`);
          process.exitCode = 1;
        } finally {
          app.quit();
        }
      }, 900);
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  if (app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(logoPath));
  }
  ipcMain.handle('tmc:http', (_event, options) => doHttp(options));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 桌面调试工具：点左上角关闭窗口即真实退出，不保留 macOS 的常驻行为。
  app.quit();
});
