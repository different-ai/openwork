import { fileURLToPath } from "node:url";
import { createProcessLauncher } from "@openwork/child-process/client";
import { installProcessLauncher } from "@openwork/child-process";

/**
 * One already-signed Electron utility process, not a second engine executable.
 * Caller must await app readiness. Disabled launches retain the existing path.
 */
export function startDesktopLaunchBroker({ utilityProcess, enabled }) {
  if (!enabled) return null;
  const startedAt = Date.now();
  let brokerPid;
  let endedAt;
  const worker = utilityProcess.fork(fileURLToPath(new URL("./launch-broker-process.mjs", import.meta.url)), [], {
    serviceName: "OpenWork launch broker",
    stdio: "pipe",
  });
  // inherit stdio is unavailable on utilityProcess; keep legacy inherited output
  // draining. No request, argument, environment or pipe payload is logged here.
  worker.stdout?.pipe(process.stdout, { end: false });
  worker.stderr?.pipe(process.stderr, { end: false });
  worker.once("spawn", () => { brokerPid = worker.pid; });
  let stopping = false;
  async function cleanupWindows(entries) {
    const children = entries.filter(entry => !entry.detached).map(entry => ({
      pid: entry.child.pid, command: entry.command, startedAt: entry.startedAt,
    }));
    if (children.length === 0) return;
    const reaper = utilityProcess.fork(fileURLToPath(new URL("./launch-broker-reaper.mjs", import.meta.url)), [], {
      serviceName: "OpenWork launch cleanup", stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reaper.kill();
        if (ok) resolve();
        else reject(new Error("Launch broker child cleanup could not be confirmed"));
      };
      const timer = setTimeout(() => finish(false), 30_000);
      reaper.once("message", result => finish(result?.ok === true));
      reaper.once("exit", () => finish(false));
      reaper.postMessage({ parentPid: brokerPid, startedAt, endedAt, children });
    });
  }
  const launcher = createProcessLauncher({
    send: value => worker.postMessage(value),
    subscribe: receive => worker.on("message", receive),
    cleanup: process.platform === "win32" ? cleanupWindows : undefined,
    onClose: receive => worker.once("exit", () => {
      endedAt = Date.now();
      if (!stopping) console.error("[launch-broker] service exited; restart is required");
      receive();
    }),
  });
  installProcessLauncher(launcher);
  return {
    pid: () => worker.pid,
    async stop() { stopping = true; await launcher.shutdown(); worker.kill(); },
  };
}
