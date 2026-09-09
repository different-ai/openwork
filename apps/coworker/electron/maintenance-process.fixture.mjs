// Disposable child-process witness for maintenance.test.mjs. Not bundled.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureMaintenanceProcesses, prepareMaintenanceHandoff, readMaintenanceStartup, runMaintenanceHelper } from "./maintenance-handoff.mjs";

const self = fileURLToPath(import.meta.url);
const [role, root, profile] = process.argv.slice(2);
if (role === "writer") {
  const interval = setInterval(async () => {
    try { await access(path.join(root, "release-writer")); } catch { return; }
    clearInterval(interval);
    await writeFile(path.join(profile, "late-writer"), "written before Chromium witness exit");
    process.exit(0);
  }, 20);
  process.send({ type: "ready" });
} else if (role === "relaunch") {
  const notice = readMaintenanceStartup(profile);
  const marker = process.env.COWORKER_TEST_INHERITED;
  await writeFile(path.join(root, "relaunched.json.tmp"), JSON.stringify({ notice, marker, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, args: process.argv.slice(2) }));
  await rename(path.join(root, "relaunched.json.tmp"), path.join(root, "relaunched.json"));
} else if (role === "parent" && process.connected) {
  const [request] = await once(process, "message");
  const writer = spawn(process.execPath, [self, "writer", request.root, request.scope.userData], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
  await once(writer, "message");
  const handoff = await prepareMaintenanceHandoff({ input: { confirmation: "DELETE" }, scope: request.scope,
    helperPath: request.timeout || request.ackFault ? self : fileURLToPath(new URL("./maintenance-helper.mjs", import.meta.url)),
    args: [self, "relaunch", request.root, request.scope.userData, "opencoworker://discard", "--fresh-start=stale"],
    cwd: request.launchCwd ?? process.cwd(),
    env: { ...process.env, COWORKER_MAINTENANCE_TEST_ACK: request.ackFault ?? "" },
    ...(request.ackFault ? { ackTimeoutMs: 60 } : {}),
  });
  process.send({ type: "ready", helperPid: handoff.pid, writerPid: writer.pid, ticket: handoff.ticket });
  await once(process, "message");
  try {
    await handoff.arm(captureMaintenanceProcesses([writer.pid]));
    if (!request.noCommit) await handoff.commit();
  } catch (error) {
    if (!request.ackFault) throw error;
    await handoff.cancel();
    process.send({ type: "cancelled", message: error.message });
    await once(process, "message"); // Ordinary quit, separate from reset exit.
  }
  writer.disconnect(); writer.unref();
  process.disconnect();
  process.exit(0);
} else if (!role && process.connected) {
  const fault = process.env.COWORKER_MAINTENANCE_TEST_ACK;
  const originalSend = process.send.bind(process);
  if (fault) process.send = (message, callback) => {
    if (message.type !== (fault === "lost-committed" ? "committed" : "armed")) return originalSend(message, callback);
    if (fault === "delayed-armed") setTimeout(() => process.connected ? originalSend(message, callback) : callback?.(null), 200);
    else queueMicrotask(() => callback?.(null));
    return true;
  };
  await runMaintenanceHelper(process, { exitTimeoutMs: fault ? 1000 : 100 });
  if (process.connected) process.disconnect();
} else {
  process.exitCode = 1;
}
