import { addInitScript, browserScript, reload } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export type DiskReading = { freeBytes: number; totalBytes: number; level: "ok" | "low" | "critical" };

type DiskFault = { asked: number; real: string | null };
declare global { interface Window { __lowStorageDisk?: DiskFault } }

const READING_KEY = "openwork.eval.diskReading";

/**
 * A member signed in to the app in a browser, with its OpenWork server on the
 * same machine, and the low disk space warning off for their organization.
 *
 * Filling a real disk is not an option, so the reading the app receives is
 * test-owned. Every question still goes to the real server first, and its
 * answer is kept as the witness that the server measures the disk; the app is
 * then handed the reading chosen with `showDisk` instead.
 */
export async function lowStorageWarningWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Low disk space workspace", admin: { name: "Workspace owner" } },
  });
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, name: "low-storage-warning", workspacePath: seed.tmpPath("low-storage-warning"), engine: "v2",
  });
  const registration = await addInitScript(app.client, browserScript((key) => {
    const original = window.fetch.bind(window);
    const disk: DiskFault = window.__lowStorageDisk = { asked: 0, real: null };
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (!url.pathname.endsWith("/disk-space")) return original(input, init);
      const response = await original(input, init);
      disk.asked += 1;
      disk.real = await response.clone().text();
      const chosen = window.localStorage.getItem(key);
      if (!response.ok || !chosen) return response;
      return new Response(chosen, { status: 200, headers: { "Content-Type": "application/json" } });
    };
  }, [READING_KEY]));
  await reload(app);
  return {
    app, workspace,
    /** What the app is told about the disk, from its next load on. */
    showDisk: (reading: DiskReading) => seed.evalIn(app, browserScript((key, value) => {
      window.localStorage.setItem(key, value);
    }, [READING_KEY, JSON.stringify(reading)])),
    /** How often the app has asked since it loaded, and the real server's last answer. */
    asked: () => seed.evalIn(app, () => {
      const disk = window.__lowStorageDisk;
      if (!disk) throw new Error("The disk reading is not installed");
      return { asked: disk.asked, real: disk.real };
    }),
    /** A platform admin turns the warning on for the organization. */
    turnOnWarning: () => enableOrganizationCapabilities(seed, den.admin, { lowStorageWarning: true }),
    async [Symbol.asyncDispose]() { await registration.dispose(); },
  };
}
