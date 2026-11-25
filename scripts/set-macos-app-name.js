const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { productName } = require('../package.json');

if (process.platform === 'darwin' && !process.env.ELECTRON_OVERRIDE_DIST_PATH) {
  const plist = path.join(require('electron'), '..', '..', 'Info.plist');
  const plistBuddy = '/usr/libexec/PlistBuddy';

  // macOS 的应用菜单标题取自 Electron 应用包的显示名称。
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    const current = execFileSync(plistBuddy, ['-c', `Print :${key}`, plist], {
      encoding: 'utf8',
    }).trim();
    if (current !== productName) {
      execFileSync(plistBuddy, ['-c', `Set :${key} ${productName}`, plist]);
    }
  }
}
