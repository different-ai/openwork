import { readFile, writeFile } from "node:fs/promises";
import { bootAcmeWeb, acmeWebOutputs } from "/workspace/worlds/acme-web.ts";
import { probeAcmeGateway } from "/workspace/worlds/lib/acme-gateway-probe.ts";

const access = JSON.parse(await readFile("/opt/openwork-preview/access.json", "utf8"));
process.env.OPENWORK_WORLD_PLACE = "local";
process.env.OPENWORK_EVAL_DEN_API_PREPARED = "1";
process.env.pnpm_config_verify_deps_before_run = "false";
process.env.OPENWORK_EVAL_MYSQL_URL = "mysql://root:password@127.0.0.1:3306";
process.env.DATABASE_REDIS_URL = "redis://127.0.0.1:6379";
const stack = new AsyncDisposableStack();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await stack.disposeAsync(); process.exit(0); });
try {
  const world = await bootAcmeWeb(stack, { app: access.origins.app, den: access.origins.den, api: access.origins.api });
  const proof = await probeAcmeGateway(world);
  const { web, den, gatewayUrl } = world;
  const outputs = Object.fromEntries(Object.entries(acmeWebOutputs(world)).map(([key, entry]) => [key, typeof entry === "string" ? { value: entry } : entry]));
  outputs.verifiedReply = { value: proof.reply, group: "Verification" };
  const services = { app: web.manifest.webUrl, den: den.ref.webUrl, api: den.ref.apiUrl, engine: web.manifest.openworkUrl, gateway: gatewayUrl };
  await writeFile("/opt/openwork-preview/services.json", JSON.stringify(services), { mode: 0o600 });
  await writeFile("/opt/openwork-preview/outputs.json", JSON.stringify(outputs), { mode: 0o600 });
  await writeFile("/opt/openwork-preview/ready-world", "ready");
} catch (error) {
  console.error(error);
  await writeFile("/opt/openwork-preview/failed-world", "failed");
  await stack.disposeAsync();
  process.exit(1);
}
// Own the complete world until the VM expires; do not dispose at startup completion.
await new Promise(() => {});
