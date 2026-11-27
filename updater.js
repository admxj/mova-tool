const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const repo = 'admxj/mova-tool';
const { maxPackBytes } = require('./renderer-update');
const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

function selectUpdate(release, current) {
  const version = /^v(.+)$/.exec(release.tag_name)?.[1];
  if (release.draft || release.prerelease || !stable.test(version ?? '') || !stable.test(current)) return null;
  const old = current.split('.').map(Number);
  const diff = version.split('.').map((n, i) => Number(n) - old[i]).find(Boolean);
  if (!(diff > 0)) return null;
  const candidates = release.assets?.filter((asset) => /^[\w.-]+-arm64\.dmg$/.test(asset.name));
  const asset = candidates?.[0];
  if (candidates?.length !== 1 || !asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3 ||
      asset.browser_download_url !== `https://github.com/${repo}/releases/download/v${version}/${asset.name}`) {
    throw new Error('新版缺少有效的 arm64 DMG 或 SHA-256 校验信息');
  }
  return { version, url: asset.browser_download_url, name: asset.name, size: asset.size, digest: asset.digest.slice(7) };
}

const rendererAssetName = 'tmc-renderer.json';

function compareVersions(a, b) {
  const rhs = b.split('.').map(Number);
  return a.split('.').map((part, i) => Number(part) - rhs[i]).find(Boolean) || 0;
}

function selectUpdateTracks(releases, installed, running = installed) {
  const tracks = { desktop: null, renderer: null };
  if (!stable.test(installed) || !stable.test(running)) return tracks;
  const [major, minor] = installed.split('.');
  if (!running.startsWith(`${major}.${minor}.`)) running = installed;
  for (const release of releases) {
    const version = /^v(.+)$/.exec(release?.tag_name)?.[1];
    if (!stable.test(version ?? '') || release.draft || release.prerelease || !Array.isArray(release.assets)) continue;
    const [candidateMajor, candidateMinor, patch] = version.split('.');
    if (candidateMajor !== major) continue;
    if (candidateMinor === minor && compareVersions(version, running) > 0 &&
        (!tracks.renderer || compareVersions(version, tracks.renderer.version) > 0)) {
      const assets = release.assets.filter((a) => a?.name === rendererAssetName);
      const a = assets[0];
      const url = `https://github.com/${repo}/releases/download/v${version}/${rendererAssetName}`;
      if (assets.length === 1 && a.browser_download_url === url && Number.isSafeInteger(a.size) &&
          a.size > 0 && a.size <= maxPackBytes) {
        tracks.renderer = { version, url, size: a.size };
      }
    } else if (Number(candidateMinor) > Number(minor) && patch === '0' &&
        (!tracks.desktop || compareVersions(version, tracks.desktop.version) > 0)) {
      try { tracks.desktop = selectUpdate(release, installed) ?? tracks.desktop; }
      catch { /* An invalid desktop asset does not hide a valid older release or renderer patch. */ }
    }
  }
  return tracks;
}

async function listReleases(request = fetch) {
  const releases = [];
  const signal = AbortSignal.timeout(20_000);
  for (let page = 1; page <= 10; page++) {
    const response = await request(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { signal, redirect: 'error' });
    if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('GitHub Release 列表格式错误');
    releases.push(...batch);
    if (!/;\s*rel="next"/.test(response.headers.get('link') ?? '')) break;
  }
  return releases;
}

function downloadSignal(timeout, cancellation) {
  const deadline = AbortSignal.timeout(timeout);
  return cancellation ? AbortSignal.any([deadline, cancellation]) : deadline;
}

async function downloadUpdate(update, root, onProgress, request = fetch, cancellation) {
  const dir = await fs.mkdtemp(path.join(root, 'tmc-update-'));
  const target = path.join(dir, update.name);
  try {
    const signal = downloadSignal(20 * 60_000, cancellation);
    signal.throwIfAborted();
    const response = await request(update.url, { signal });
    if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`);
    const hash = createHash('sha256');
    let total = 0;
    await pipeline(Readable.fromWeb(response.body, { signal }), new Transform({ transform(chunk, _encoding, done) {
      total += chunk.length;
      if (total > update.size) return done(new Error('DMG 大小不匹配'));
      hash.update(chunk);
      onProgress(Math.min(0.99, total / update.size));
      done(null, chunk);
    } }), require('node:fs').createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
    if (total !== update.size) throw new Error('DMG 大小不匹配');
    if (hash.digest('hex') !== update.digest) throw new Error('DMG SHA-256 校验失败');
    onProgress(1);
    return target;
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function downloadRenderer(update, onProgress, request, cancellation) {
  const signal = downloadSignal(120_000, cancellation);
  signal.throwIfAborted();
  const response = await request(update.url, { signal });
  if (!response.ok || !response.body) throw new Error(`下载界面失败（HTTP ${response.status}）`);
  const bytes = Buffer.alloc(update.size);
  let total = 0;
  for await (const chunk of Readable.fromWeb(response.body, { signal })) {
    if (total + chunk.byteLength > bytes.length) throw new Error('前端补丁大小不匹配');
    bytes.set(chunk, total);
    total += chunk.byteLength;
    onProgress(total / bytes.length);
  }
  if (total !== bytes.length) throw new Error('前端补丁大小不匹配');
  return bytes;
}

function createUpdateCheck({ app, BrowserWindow, dialog, shell }, request = fetch, renderer, currentVersion) {
  let busy = false;
  let promoteCheck;
  let activeDownload;
  async function check(interactive = false) {
    if (busy) {
      if (interactive) promoteCheck?.();
      return;
    }
    busy = true;
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { busy = false; return; }
    const show = (options) => dialog.showMessageBox(win, options);
    let accepted = false;
    let controller;
    const status = (phase, percent) => {
      if (!win.isDestroyed()) win.webContents?.send('tmc:update-status', phase, percent);
    };
    let manual = false;
    promoteCheck = () => {
      if (manual) return;
      manual = true;
      status('checking');
    };
    try {
      if (interactive) promoteCheck();
      const installed = typeof currentVersion === 'function' ? currentVersion() : currentVersion || app.getVersion();
      const releases = await listReleases(request);
      promoteCheck = undefined;
      const current = renderer?.version() ?? installed;
      const { desktop, renderer: candidate } = selectUpdateTracks(releases, installed, current);
      const patch = renderer ? candidate : null;
      if (!app.isPackaged) console.log('[updater] check', { installed, current, desktop: desktop?.version ?? null, renderer: patch?.version ?? null });
      if (win.isDestroyed()) return;
      if (manual) status('idle');
      if (!desktop && !patch) {
        if (manual) await show({ message: `已是最新版本（${current}）` });
        return;
      }
      const update = desktop ?? patch;
      const detail = desktop ? '下载后打开安装包，请手动替换安装。' : '升级会重新加载窗口，请先保存未提交内容。';
      const { response: choice } = await show({ type: 'info', message: `发现新版本 ${update.version}`, detail,
        buttons: ['升级', '取消'], defaultId: 0, cancelId: 1 });
      if (win.isDestroyed() || choice !== 0) return;
      accepted = true;
      controller = new AbortController();
      activeDownload = { win, controller };
      win.setProgressBar(0);
      status('downloading', 0);
      let last = -1;
      const progress = (ratio) => {
        const percent = Math.floor(ratio * 100);
        if (percent !== last && !win.isDestroyed()) {
          win.setProgressBar(ratio);
          status('downloading', percent);
        }
        last = percent;
      };
      if (!desktop) {
        const bytes = await downloadRenderer(patch, progress, request, controller.signal);
        controller.signal.throwIfAborted();
        activeDownload = undefined;
        status('installing');
        if (!win.isDestroyed()) await renderer.activate(win, patch.version, bytes);
        return;
      }
      const file = await downloadUpdate(desktop, app.getPath('temp'), progress, request, controller.signal);
      activeDownload = undefined;
      if (controller.signal.aborted || win.isDestroyed()) {
        await fs.rm(path.dirname(file), { recursive: true, force: true });
        return;
      }
      status('installing');
      const error = await shell.openPath(file);
      if (error) throw new Error(`${error}\n安装包已保存到：${file}`);
    } catch (error) {
      if (controller?.signal.aborted) return;
      if (!app.isPackaged) console.error('[updater] check failed:', error.message);
      promoteCheck = undefined;
      if (manual || accepted) status('idle');
      if ((manual || accepted) && !win.isDestroyed()) {
        await show({ type: 'error', message: '更新未完成', detail: error.message });
      }
    } finally {
      activeDownload = undefined;
      if (controller && !win.isDestroyed()) {
        win.setProgressBar(-1);
        status('idle');
      }
      busy = false;
    }
  }
  check.cancel = (sender) => {
    if (!activeDownload || activeDownload.win.isDestroyed() || activeDownload.win.webContents !== sender) return false;
    activeDownload.controller.abort();
    return true;
  };
  return check;
}

function enableUpdates(electron, renderer, options = {}) {
  const { app, Menu, MenuItem } = electron;
  if ((!app.isPackaged && !options.dev) || process.platform !== 'darwin' || process.arch !== 'arm64') return;
  if (!app.isPackaged) console.log('[updater] enabled for development');
  const check = createUpdateCheck(electron, fetch, renderer, options.version);
  electron.ipcMain.handle('tmc:cancel-update', event => check.cancel(event.sender));
  const menu = Menu.getApplicationMenu();
  const appMenu = menu?.items[0]?.submenu;
  if (appMenu) {
    appMenu.insert(1, new MenuItem({ label: '检查更新…', click: () => void check(true) }));
    Menu.setApplicationMenu(menu);
  }
  setTimeout(() => void check(), 3000).unref();
}

module.exports = { selectUpdate, selectUpdateTracks, listReleases, downloadUpdate, createUpdateCheck, enableUpdates };
