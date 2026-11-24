import { browserScript, evaluateOnSurface, type Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/testkit";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { acquirePermissionsMachine, permissionsDescendants, pollPermissions } from "./sandbox-ux-permissions.ts";
import { uxDenProxy } from "./sandbox-ux-signed-in.ts";

/** The embedded server and OS process tree must be real; only fixture traffic is faulted. */
export async function permissionsOpensFast(seed: Seed, { place }: { place: { kind: string } }) {
  if (place.kind !== "local") throw new Error("Permissions timing proof uses the local loopback fault proxy and process tree");
  const cleanup = new AsyncDisposableStack();
  cleanup.defer(await acquirePermissionsMachine("permissions-opens-fast proof / local Den"));
  try {
    const den = cleanup.use(await seed.den({ web: false, org: { name: "Permissions timing proof", members: { riley: { name: "Riley Test Member" } } } }));
    await enableOrganizationCapabilities(seed, den.admin, { sandboxTools: true });
    const proxy = await uxDenProxy(den.ref.apiUrl);
    cleanup.defer(proxy.close);
    const root = await realpath(await mkdtemp("/tmp/owperm-"));
    cleanup.defer(() => rm(root, { recursive: true, force: true }));
    const folders = Array.from({ length: 12 }, (_, index) => join(root, `work-${index + 1}`));
    await Promise.all(folders.map(path => mkdir(path)));
    const app = await seed.desktop({ den: { ...den, ref: { webUrl: proxy.url, apiUrl: proxy.url } }, as: "riley", workspacePath: folders[0], env: { MSB_HOME: join(root, "msb") } });
    cleanup.defer(() => app.stop());
    for (const path of folders) await seed.workspace(app, path);
    const selected = await seed.workspace(app, folders[0]);
    // A read-only count is not exposed by Seed; prove actual registration, not just created directories.
    const workspaceCount = await evaluateOnSurface(app, () => window.__openwork?.slice?.("route")?.workspaces?.length ?? 0);
    const base = `/workspace/${encodeURIComponent(selected.workspaceId)}`;
    return {
      app, proxy, workspaceCount, statusPath: `${base}/sandbox-status`,
      processes: () => permissionsDescendants(app.handle.pid).then(rows => rows.filter(row => row.executable === "msb").map(row => row.pid)),
      measure: (captureMs: number, limitMs: number) => pollPermissions(app, { modes: true, expectSwitch: true, captureMs, limitMs }),
      hangSettings: () => installSettingsFault(app, `${base}/sandbox-settings`),
      [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
    };
  } catch (error) {
    await cleanup.disposeAsync();
    throw error;
  }
}

/** No testkit hook for embedded-server requests. Hold this one loopback renderer GET until its original abort signal fires. */
async function installSettingsFault(app: Surface, endpoint: string) {
  await evaluateOnSurface(app, browserScript(path => {
    const original = globalThis.fetch;
    const starts: number[] = [];
    const fault: typeof fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== path || (init?.method ?? "GET") !== "GET") return original(input, init);
      starts.push(performance.now());
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    globalThis.fetch = fault;
    Reflect.set(window, "__permissionsProofFault", { starts: () => [...starts], restore: () => { globalThis.fetch = original; } });
  }, [endpoint]));
  return async (restore: boolean) => evaluateOnSurface(app, browserScript(restore => {
    const state: unknown = Reflect.get(window, "__permissionsProofFault");
    if (!state || typeof state !== "object" || !("starts" in state) || !("restore" in state) || typeof state.starts !== "function" || typeof state.restore !== "function") throw new Error("Missing embedded settings fault witness");
    const starts: unknown = state.starts();
    if (restore) {
      state.restore();
      Reflect.deleteProperty(window, "__permissionsProofFault");
    }
    if (!Array.isArray(starts)) throw new Error("Invalid embedded settings fault witness");
    return starts.flatMap((start: unknown) => typeof start === "number" ? [start] : []);
  }, [restore]));
}
