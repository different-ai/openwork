import { contextBridge, ipcRenderer } from "electron";

let latestRequest = null;
let showCallback = null;

ipcRenderer.on("micx:menu-overlay:show", (_event, request) => {
  latestRequest = request;
  showCallback?.(request);
});

contextBridge.exposeInMainWorld("__MICX_MENU_OVERLAY__", {
  ready() {
    ipcRenderer.send("micx:menu-overlay:ready");
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
    ipcRenderer.send("micx:menu-overlay:choose", { requestId, itemId });
  },
  close(requestId) {
    ipcRenderer.send("micx:menu-overlay:close", { requestId });
  },
});
