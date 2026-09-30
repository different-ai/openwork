import { spawn } from "node:child_process";

// Drain every lane before reporting failure so evidence is complete and no
// desktop remains running while the caller writes the final timing report.
export async function runConcurrent(tasks, concurrency = 3) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid smoke concurrency");
  const pending = [...tasks];
  const failures = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (pending.length) {
      const task = pending.shift();
      try {
        await task();
      } catch (error) {
        failures.push(error);
      }
    }
  }));
  if (failures.length) throw new AggregateError(failures, `${failures.length} packaged smoke check(s) failed`);
}

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
