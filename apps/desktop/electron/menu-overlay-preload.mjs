import { contextBridge, ipcRenderer } from "electron";

let latestRequest = null;
let showCallback = null;

ipcRenderer.on("openwork:menu-overlay:show", (_event, request) => {
  latestRequest = request;
  showCallback?.(request);
});

contextBridge.exposeInMainWorld("__OPENWORK_MENU_OVERLAY__", {
  ready() {
    ipcRenderer.send("openwork:menu-overlay:ready");
  },
  onShow(callback) {
    showCallback = callback;
    if (latestRequest) {
      callback(latestRequest);
    }
    return () => {
      if (showCallback === callback) {
        showCallback = null;
      }
    };
  },
  choose(requestId, itemId) {
    ipcRenderer.send("openwork:menu-overlay:choose", { requestId, itemId });
  },
  close(requestId) {
    ipcRenderer.send("openwork:menu-overlay:close", { requestId });
  },
});
