import electron from "electron";

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("openworkLabsDesktop", {
  isDesktop: true,
  platform: process.platform,
  ensureLocalServer: () => ipcRenderer.invoke("labs:ensure-local-server"),
  pickRepoDirectory: () => ipcRenderer.invoke("labs:pick-repo-directory"),
  ensureWorkspace: (workspace) => ipcRenderer.invoke("labs:ensure-workspace", workspace),
  refreshWorkspace: (workspaceId) => ipcRenderer.invoke("labs:refresh-workspace", workspaceId),
  removeWorkspace: (workspaceId) => ipcRenderer.invoke("labs:remove-workspace", workspaceId),
  getSessionMessages: (workspaceId, sessionId) =>
    ipcRenderer.invoke("labs:get-session-messages", { workspaceId, sessionId }),
  createSession: (workspaceId, options) =>
    ipcRenderer.invoke("labs:create-session", { workspaceId, options: options ?? {} }),
  sendPrompt: (workspaceId, sessionId, prompt) =>
    ipcRenderer.invoke("labs:send-prompt", { workspaceId, sessionId, prompt }),
  abortSession: (workspaceId, sessionId) =>
    ipcRenderer.invoke("labs:abort-session", { workspaceId, sessionId }),
  subscribeEvents: (listener) => {
    const eventHandler = (_event, payload) => listener({ kind: "event", ...payload });
    const connectionHandler = (_event, payload) => listener({ kind: "connection", ...payload });
    ipcRenderer.on("labs:event", eventHandler);
    ipcRenderer.on("labs:connection", connectionHandler);
    return () => {
      ipcRenderer.off("labs:event", eventHandler);
      ipcRenderer.off("labs:connection", connectionHandler);
    };
  },
});
