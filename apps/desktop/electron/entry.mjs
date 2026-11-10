import { app } from "electron";
import { dispatchDesktopEntry } from "./login-command.mjs";

// Decide before importing main: the shell command must never initialize the GUI,
// acquire its single-instance lock, or enter its normal authentication lifecycle.
await dispatchDesktopEntry({
  app,
  defaultApp: process.defaultApp,
  loadGui: () => import("./main.mjs"),
});
