import { appendFile, writeFile } from "node:fs/promises";
import { bootWorkbot, probeWorkbot, workbotOutputs } from "/workspace/worlds/lib/workbot.ts";
import { templateOrigins } from "./origins.mjs";

// preview-workbot inside a Freestyle VM: the local world (Den on this VM's MySQL/Redis, the runner, Workbot), under
// the snapshot's template origins. The edge gateway translates them per clone; nothing restarts in a clone.
process.env.OPENWORK_WORLD_PLACE = "local";
process.env.OPENWORK_EVAL_DEN_API_PREPARED = "1";
process.env.OPENWORK_WORKBOT_PREBUILT = "1";
process.env.pnpm_config_verify_deps_before_run = "false";
process.env.OPENWORK_EVAL_MYSQL_URL = "mysql://root:password@127.0.0.1:3306";
process.env.DATABASE_REDIS_URL = "redis://127.0.0.1:6379";
const root = "/opt/openwork-preview";
const stack = new AsyncDisposableStack();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await stack.disposeAsync(); process.exit(0); });
let phase = Date.now();
async function mark(stage) {
  const now = Date.now();
  await appendFile(`${root}/runtime-stages.jsonl`, JSON.stringify({ stage, durationMs: now - phase }) + "\n");
  phase = now;
}
try {
  const world = await bootWorkbot(stack, { den: templateOrigins.den, workbot: templateOrigins.workbot });
  await mark("world-services");
  // Compile the pages a sign-in crosses, so a clone's first visit is not a cold Next.js build.
  for (const path of ["/", "/mcp/select-organization", "/dashboard"]) {
    const response = await fetch(`${world.den.ref.webUrl}${path}`);
    if (response.status >= 500) throw new Error(`Den warmup failed: ${path} (${response.status})`);
    await response.text();
  }
  await mark("den-pages");
  const proof = await probeWorkbot(world);
  await mark("workbot-probe");
  const outputs = Object.fromEntries(Object.entries(workbotOutputs(world)).map(([key, entry]) => [key, typeof entry === "string" ? { value: entry } : entry]));
  outputs.verified = { value: `Signed in through Den and answered: ${proof.reply}`, group: "Verification" };
  outputs.orgId = { value: world.orgId, group: "Org" };
  const services = { den: world.den.ref.webUrl, api: world.den.ref.apiUrl, workbot: world.workbotInternal, runner: world.runnerUrl };
  await writeFile(`${root}/services.json`, JSON.stringify(services), { mode: 0o600 });
  await writeFile(`${root}/outputs.json`, JSON.stringify(outputs), { mode: 0o600 });
  await writeFile(`${root}/ready-world`, JSON.stringify({ warmedAt: new Date().toISOString(), pid: process.pid, world: "workbot" }));
} catch (error) {
  console.error(error);
  await writeFile(`${root}/failed-world`, "failed");
  await stack.disposeAsync();
  process.exit(1);
}
// Own the complete world until the VM expires.
await new Promise(() => {});
