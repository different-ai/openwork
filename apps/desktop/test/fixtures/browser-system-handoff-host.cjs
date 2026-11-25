const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tabs", {
  create: (url) => ipcRenderer.invoke("openwork:browser:createTab", url),
  openExternal: (tabId, address) => ipcRenderer.invoke("openwork:browser:openTabExternal", tabId, address),
});
