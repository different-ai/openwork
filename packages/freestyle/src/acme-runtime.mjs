import { readFile, writeFile } from "node:fs/promises";
import { bootAcmeWeb, acmeWebOutputs } from "/workspace/worlds/acme-web.ts";
import { probeAcmeGateway } from "/workspace/worlds/lib/acme-gateway-probe.ts";

import { templateOrigins } from "./origins.mjs";
process.env.OPENWORK_WORLD_PLACE = "local";
process.env.OPENWORK_EVAL_DEN_API_PREPARED = "1";
process.env.pnpm_config_verify_deps_before_run = "false";
process.env.OPENWORK_EVAL_MYSQL_URL = "mysql://root:password@127.0.0.1:3306";
process.env.DATABASE_REDIS_URL = "redis://127.0.0.1:6379";
const stack = new AsyncDisposableStack();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await stack.disposeAsync(); process.exit(0); });
try {
  const world = await bootAcmeWeb(stack, { app: templateOrigins.app, den: templateOrigins.den, api: templateOrigins.api });
  const proof = await probeAcmeGateway(world);
  const { web, den, gatewayUrl } = world;
  const outputs = Object.fromEntries(Object.entries(acmeWebOutputs(world)).map(([key, entry]) => [key, typeof entry === "string" ? { value: entry } : entry]));
  outputs.orgId = { value: world.model.orgId, group: "Org" };
  outputs.verifiedReply = { value: proof.reply, group: "Verification" };
  // Compile the browser entry points while warming, including the gateway UI.
  for (const path of ["/", "/dashboard", "/dashboard/gateway-providers"]) {
    const response = await fetch(`${den.ref.webUrl}${path}`);
    if (!response.ok) throw new Error(`Den warmup failed: ${path} (${response.status})`);
    await response.text();
  }
  // Warm Vite's transitive module graph, not just its HTML entry point.
  const seen = new Set();
  async function warmModule(path) {
    if (seen.has(path) || !path.startsWith("/") || path.startsWith("//")) return;
    seen.add(path);
    const response = await fetch(`${web.manifest.webUrl}${path}`);
    if (!response.ok) throw new Error(`App warmup failed: ${path}`);
    const source = await response.text();
    const imports = [...source.matchAll(/(?:from\s*|import\s*\(?\s*|src=)["'](\/[^"']+)["']/g)].map((match) => match[1]);
    for (const dependency of imports) await warmModule(dependency);
  }
  await warmModule("/");
  // The real desktop app, viewed through noVNC. Optional: a desktop failure
  // leaves the web, Den and gateway preview usable and says so in its outputs.
  let desktop = null;
  try {
    const { startDesktop } = await import("./desktop.mjs");
    desktop = await startDesktop(stack, world);
    // Wait for the window so Freestyle snapshots a running desktop and every clone
    // resumes it instantly. Bounded well inside the builder's existing deadline;
    // a slower first boot still snapshots and finishes starting in the clone.
    const running = await Promise.race([desktop.ready, new Promise((resolve) => setTimeout(resolve, 180_000, false))]);
    outputs.desktopStatus = running
      ? { value: "ready", group: "Desktop", note: "Real OpenWork desktop app (signed out), resumed running from the snapshot" }
      : { value: "starting", group: "Desktop", note: "Real OpenWork desktop app (signed out); still loading when the viewer opens" };
  } catch (error) {
    console.error("Desktop preview unavailable:", error);
    outputs.desktopStatus = { value: "unavailable", group: "Desktop", note: "The web preview is unaffected; see /opt/openwork-preview/desktop logs" };
  }
  const services = { app: web.manifest.webUrl, den: den.ref.webUrl, api: den.ref.apiUrl, engine: web.manifest.openworkUrl, gateway: gatewayUrl, ...(desktop ? { desktop: desktop.url } : {}) };
  await writeFile("/opt/openwork-preview/services.json", JSON.stringify(services), { mode: 0o600 });
  await writeFile("/opt/openwork-preview/outputs.json", JSON.stringify(outputs), { mode: 0o600 });
  await writeFile("/opt/openwork-preview/ready-world", JSON.stringify({ warmedAt: new Date().toISOString(), pid: process.pid, modules: seen.size }));
} catch (error) {
  console.error(error);
  await writeFile("/opt/openwork-preview/failed-world", "failed");
  await stack.disposeAsync();
  process.exit(1);
}
// Own the complete world until the VM expires; do not dispose at startup completion.
await new Promise(() => {});
