const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tmcBridge', {
  request: (options) => ipcRenderer.invoke('tmc:http', options),
  openExternal: (url) => ipcRenderer.invoke('tmc:open-external', url),
  onUpdateStatus(listener) {
    ipcRenderer.on('tmc:update-status', (_event, phase, percent) => listener(phase, percent));
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
