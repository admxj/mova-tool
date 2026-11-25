const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tmcBridge', {
  request: (options) => ipcRenderer.invoke('tmc:http', options),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
