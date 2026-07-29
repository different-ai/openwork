import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__OPENWORK_STATION__", {
  getState() {
    return ipcRenderer.invoke("openwork:station:get-state");
  },
  sendCommand(command) {
    ipcRenderer.send("openwork:station:ui-command", command);
  },
  setExpanded(expanded) {
    return ipcRenderer.invoke("openwork:station:set-expanded", expanded === true);
  },
  onState(callback) {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("openwork:station:state", handler);
    return () => ipcRenderer.removeListener("openwork:station:state", handler);
  },
});
