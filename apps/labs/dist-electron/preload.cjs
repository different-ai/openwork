"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("openwork", {
    getSnapshot: () => ipcRenderer.invoke("ow:getSnapshot"),
    createWorkspace: () => ipcRenderer.invoke("ow:createWorkspace"),
    connectRemote: (url, token) => ipcRenderer.invoke("ow:connectRemote", { url, token }),
    createSession: () => ipcRenderer.invoke("ow:createSession"),
    selectSession: (sessionID) => ipcRenderer.invoke("ow:selectSession", sessionID),
    sendPrompt: (sessionID, prompt) => ipcRenderer.invoke("ow:sendPrompt", { sessionID, prompt }),
    abortSession: (sessionID) => ipcRenderer.invoke("ow:abortSession", sessionID),
    getLogs: () => ipcRenderer.invoke("ow:getLogs"),
    sendRendererLog: (level, message) => ipcRenderer.send("ow:rendererLog", { level, message }),
    onState: (listener) => {
        const wrapped = (_event, payload) => listener(payload);
        ipcRenderer.on("ow:state", wrapped);
        return () => ipcRenderer.removeListener("ow:state", wrapped);
    },
    onLog: (listener) => {
        const wrapped = (_event, payload) => listener(payload);
        ipcRenderer.on("ow:log", wrapped);
        return () => ipcRenderer.removeListener("ow:log", wrapped);
    },
});
