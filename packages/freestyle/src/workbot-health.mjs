import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Den web, Den API, the runner and Workbot all answer inside the VM (the runtime already proved sign-in and a reply).
const services = JSON.parse(await readFile("/opt/openwork-preview/services.json", "utf8"));
const checks = [[`${services.api}/health`, "Den API"], [`${services.den}/`, "Den web"], [`${services.runner}/health`, "runner"], [`${services.workbot}/healthz`, "Workbot"]];
const deadline = Date.now() + 60_000;
for (const [url, name] of checks) {
  while (true) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then((response) => response.status < 500).catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`Preview ${name} did not become healthy`);
    await delay(1000);
  }
}
