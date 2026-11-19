import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Only files the development servers reload (Den web components, docs, CI) can differ from the running template;
// Workbot and the runner are part of the template's key. Let Den web pick up the checkout, then check every service.
const services = JSON.parse(await readFile("/opt/openwork-preview/services.json", "utf8"));
await delay(500);
for (const path of ["/", "/mcp/select-organization"]) {
  const response = await fetch(`${services.den}${path}`, { signal: AbortSignal.timeout(60_000) });
  if (response.status >= 500) throw new Error(`Updated Den page unavailable: ${path}`);
  await response.text();
}
await import("./health.mjs");
