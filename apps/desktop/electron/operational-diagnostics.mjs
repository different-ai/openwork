import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  bucketOperationalUptime,
  operationalDiagnosticSnapshotSchema,
  operationalDiagnosticsConfigSchema,
  operationalSnapshotMinute,
} from "@openwork/types/operational-diagnostics";

export const desktopDiagnosticsConfigSchema = operationalDiagnosticsConfigSchema.extend({
  output: operationalDiagnosticsConfigSchema.shape.output.default("file"),
});

export function startDesktopOperationalDiagnostics({ config, featureEnabled, directory, version, runtimeStatus, schedule = setInterval, write = writeFile, makeDirectory = mkdir, now = () => new Date(), uptime = process.uptime }) {
  if (!config?.enabled || !featureEnabled || config.output !== "file") return () => {};
  let stopped = false;
  let running = false;
  async function emit() {
    if (stopped || running) return;
    running = true;
    try {
      let status;
      try { status = await runtimeStatus(); } catch { status = undefined; }
      const snapshot = operationalDiagnosticSnapshotSchema.safeParse({
        schemaVersion: 1,
        version,
        instanceKind: "desktop",
        deploymentKind: "desktop",
        uptimeSeconds: bucketOperationalUptime(uptime()),
        snapshotTime: operationalSnapshotMinute(now()),
        components: {
          database: "unknown",
          migrations: "unknown",
          worker: "unknown",
          engine: typeof status?.engine?.running === "boolean" ? (status.engine.running ? "ok" : "down") : "unknown",
          localServer: typeof status?.openworkServer?.running === "boolean" ? (status.openworkServer.running ? "ok" : "down") : "unknown",
        },
      });
      if (!snapshot.success || stopped) return;
      await makeDirectory(directory, { recursive: true });
      if (!stopped) await write(path.join(directory, "operational-diagnostic.json"), `${JSON.stringify(snapshot.data)}\n`, { mode: 0o600 });
    } catch {
      return;
    } finally {
      running = false;
    }
  }
  const timer = schedule(() => { void emit(); }, config.intervalMinutes * 60_000);
  timer.unref();
  void emit();
  return () => { stopped = true; clearInterval(timer); };
}
