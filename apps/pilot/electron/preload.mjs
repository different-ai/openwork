import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__PILOT__", {
  // ── System control ──
  system: {
    runAppleScript: (script) => ipcRenderer.invoke("pilot:applescript", script),
    listApps: () => ipcRenderer.invoke("pilot:list-apps"),
    activateApp: (name) => ipcRenderer.invoke("pilot:activate-app", name),
    launchApp: (name) => ipcRenderer.invoke("pilot:launch-app", name),
    typeText: (text) => ipcRenderer.invoke("pilot:type-text", text),
    pressKey: (combo) => ipcRenderer.invoke("pilot:press-key", combo),
    clipboardRead: () => ipcRenderer.invoke("pilot:clipboard-read"),
    clipboardWrite: (text) => ipcRenderer.invoke("pilot:clipboard-write", text),
    openUrl: (url) => ipcRenderer.invoke("pilot:open-url", url),
    frontmostApp: () => ipcRenderer.invoke("pilot:frontmost-app"),
  },

  // ── Permissions ──
  permissions: {
    requestMicrophone: () => ipcRenderer.invoke("pilot:request-microphone"),
  },

  // ── Listening state ──
  getListening: () => ipcRenderer.invoke("pilot:get-listening"),
  setListening: (value) => ipcRenderer.send("pilot:set-listening", value),
  onListeningChanged: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on("pilot:listening-changed", handler);
    return () => ipcRenderer.removeListener("pilot:listening-changed", handler);
  },
});
