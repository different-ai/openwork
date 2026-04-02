import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("openworkLabsDesktop", {
  isDesktop: true,
  platform: process.platform,
});
