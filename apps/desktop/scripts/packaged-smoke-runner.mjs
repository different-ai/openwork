import { spawn } from "node:child_process";

// Linux smoke commands include xvfb -> pnpm -> Vitest -> Electron. A timeout
// must terminate the process group, not just the outer launcher.
export function runCommand(command, args, { timeout, ...options }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true });
    let timedOut = false;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      killGroup();
      resolve({ status, signal, timedOut });
    });
  });
}
