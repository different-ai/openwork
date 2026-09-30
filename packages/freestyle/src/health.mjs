import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const services = JSON.parse(await readFile("/opt/openwork-preview/services.json", "utf8"));
const outputs = JSON.parse(await readFile("/opt/openwork-preview/outputs.json", "utf8"));
const headers = { authorization: `Bearer ${outputs.openworkToken.value}` };
const deadline = Date.now() + 60_000;
while (true) {
  try {
    const list = await fetch(`${services.engine}/workspaces`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!list.ok) throw new Error("Workspace list unavailable");
    const { items } = await list.json();
    if (!Array.isArray(items) || items.length === 0) throw new Error("Workspace missing");
    for (const workspace of items) {
      const status = await fetch(`${services.engine}/workspace/${encodeURIComponent(workspace.id)}/opencode/session/status`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!status.ok) throw new Error("Engine session API unavailable");
      await status.json();
    }
    break;
  } catch {
    if (Date.now() > deadline) throw new Error("Preview engine did not become healthy");
    await delay(1000);
  }
}
