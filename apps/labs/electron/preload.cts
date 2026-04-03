const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openwork", {
  getSnapshot: () => ipcRenderer.invoke("ow:getSnapshot"),
  createWorkspace: () => ipcRenderer.invoke("ow:createWorkspace"),
  connectRemote: (url: string, token: string) => ipcRenderer.invoke("ow:connectRemote", { url, token }),
  createSession: () => ipcRenderer.invoke("ow:createSession"),
  selectSession: (sessionID: string) => ipcRenderer.invoke("ow:selectSession", sessionID),
  sendPrompt: (sessionID: string, prompt: string) => ipcRenderer.invoke("ow:sendPrompt", { sessionID, prompt }),
  abortSession: (sessionID: string) => ipcRenderer.invoke("ow:abortSession", sessionID),
  getLogs: () => ipcRenderer.invoke("ow:getLogs"),
  sendRendererLog: (level: string, message: string) => ipcRenderer.send("ow:rendererLog", { level, message }),
  onState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on("ow:state", wrapped);
    return () => ipcRenderer.removeListener("ow:state", wrapped);
  },
  onLog: (listener: (entry: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on("ow:log", wrapped);
    return () => ipcRenderer.removeListener("ow:log", wrapped);
  },
});
