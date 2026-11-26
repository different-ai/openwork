const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("createTestTab", (url) => ipcRenderer.invoke("openwork:browser:createTab", url));
