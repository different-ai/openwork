import { spawn as nativeSpawn, execFile as nativeExecFile } from "node:child_process";
import { promisify } from "node:util";

// Explicit injection, not a patch of Node's built-ins. The desktop installs one
// launcher before starting helpers or importing the embedded server. CLI users
// retain Node's native implementation.
let launcher;
export function installProcessLauncher(value) {
  if (launcher) throw new Error("A process launcher is already installed");
  launcher = value;
  return () => { if (launcher === value) launcher = undefined; };
}
export function spawn(command, args, options) {
  return launcher ? launcher.spawn(command, args, options) : nativeSpawn(command, args, options);
}
export function execFile(file, args, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  return launcher ? launcher.execFile(file, args, options, callback) : nativeExecFile(file, args, options, callback);
}
export function runFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}
export function runFileResult(file, args, options = {}) {
  return new Promise(resolve => {
    execFile(file, args, options, (error, stdout, stderr) => resolve({
      status: error ? (typeof error.code === "number" ? error.code : null) : 0,
      stdout, stderr, error,
    }));
  });
}
execFile[promisify.custom] = runFile;

/** The brokered spawn event carries the real OS pid, unlike the request id. */
export function spawned(child) {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { child.removeListener("error", failed); resolve(); };
    const failed = error => { child.removeListener("spawn", done); reject(error); };
    child.once("spawn", done);
    child.once("error", failed);
  });
}
