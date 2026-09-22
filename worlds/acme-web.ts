import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "../evals/packages/cdp/src/index.ts";
import { launchHeadlessWeb } from "../packages/world/src/headless-web.ts";
import type { HeadlessWebHandle } from "../packages/world/src/headless-web.ts";
import { hold } from "../packages/world/src/hold.ts";
import { output, secret } from "../packages/world/src/outputs.ts";
import { server } from "../evals/packages/env/src/den.ts";
import type { Den } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import { receiptName, resolveStage } from "../packages/world/src/stage.ts";
import { ACME_REPLY, gatewayEnvironment, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "./lib/acme-gateway.ts";
import { probeAcmeGateway } from "./lib/acme-gateway-probe.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACME_WEB_NAME = "acme-web";

export interface AcmeWebWorld {
  den: Den;
  web: HeadlessWebHandle;
  gatewayUrl: string;
  model: Awaited<ReturnType<typeof seedAcmeGateway>>;
  upstream: Awaited<ReturnType<typeof startAcmeUpstream>>;
}

/** Seeded Acme Den + real AI Gateway + isolated web runtime; only the upstream model is fake. */
export async function bootAcmeWeb(stack: AsyncDisposableStack, preview?: { app: string; den: string; api: string }): Promise<AcmeWebWorld> {
  const place = resolvePlace();
  if (place.kind !== "local") {
    throw new Error("Run acme-web co-located with MySQL (--place local), including inside a prepared Daytona sandbox.");
  }
  const upstream = await startAcmeUpstream(stack);
  const gateway = await gatewayEnvironment(upstream.baseUrl);
  const webPort = await allocateFreePort();
  const den = stack.use(await server({
    place,
    env: { ...gateway.env, DEN_DASHBOARDS_ENABLED: "true", RESEND_API_KEY: "", SMTP_HOST: "",
      ...(preview ? { DEN_WEB_ALLOWED_DEV_ORIGINS: new URL(preview.den).hostname } : {}) },
    seedProfile: "demo-org",
    trustedOrigins: [`http://127.0.0.1:${webPort}`, ...(preview ? Object.values(preview) : [])],
    publicOrigins: preview ? { web: preview.den, api: preview.den } : undefined,
    web: true,
  }));
  if (!den.database) throw new Error("Acme Gateway requires the world's isolated Den database.");
  await startAcmeGateway(stack, den.database.url, gateway);
  const model = await seedAcmeGateway(den.admin, upstream);
  const name = `${receiptName(ACME_WEB_NAME, resolveStage(process.env))}-${randomUUID().slice(0, 8)}`;
  const workspace = join(REPO_ROOT, "tmp", "worlds", name, "workspace");
  await mkdir(workspace, { recursive: true });
  const web = await launchHeadlessWeb({
    repoRoot: REPO_ROOT,
    name,
    workspace,
    state: "isolated",
    browserHostSuffix: preview ? `.${new URL(preview.app).hostname.split(".").slice(1).join(".")}` : undefined,
    env: {
      ...process.env,
      OPENWORK_WEB_PORT: String(webPort),
      OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1",
      OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
      VITE_DEN_BASE_URL: preview?.den ?? den.ref.webUrl,
      VITE_DEN_API_BASE_URL: preview ? "/api/den" : den.ref.apiUrl,
      VITE_DISABLE_OPENWORK_MODELS: "0",
    },
  });
  stack.adopt(web, (owned) => owned.stop());
  const synced = await fetch(`${web.manifest.openworkUrl}/den-session`, {
    method: "PUT", headers: { "x-openwork-host-token": web.manifest.hostToken, "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: den.ref.apiUrl, token: den.admin.token, orgId: model.orgId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!synced.ok) throw new Error(`Acme runtime sign-in failed: HTTP ${synced.status}`);
  return { den, web, model, upstream, gatewayUrl: gateway.baseUrl };
}

export function acmeWebOutputs(world: AcmeWebWorld) {
  const { den, web, model, gatewayUrl } = world;
  return {
      webUrl: output(web.manifest.webUrl, { group: "URLs" }),
      openworkUrl: output(web.manifest.openworkUrl, { group: "URLs" }),
      denWeb: output(den.ref.webUrl, { group: "URLs" }),
      denApi: output(den.ref.apiUrl, { group: "URLs" }),
      gatewayUrl: output(gatewayUrl, { group: "URLs" }),
      model: output(model.modelName, { group: "AI Gateway" }),
      providerId: output(model.providerId, { group: "AI Gateway" }),
      modelId: output(model.modelId, { group: "AI Gateway" }),
      reply: output(ACME_REPLY, { group: "AI Gateway", note: "Deterministic upstream; no paid inference keys required" }),
      verified: output("OpenCode chat through AI Gateway", { group: "AI Gateway" }),
      alexEmail: output(den.admin.email, { group: "Accounts", note: "org owner (Acme)" }),
      denToken: secret(den.admin.token, { group: "Accounts", note: "Disposable demo bearer token" }),
      openworkToken: secret(web.manifest.token, { group: "OpenWork" }),
      openworkHostToken: secret(web.manifest.hostToken, { group: "OpenWork" }),
      databaseUrl: secret(den.database?.url ?? "", { group: "Infrastructure", note: "Inside this VM; MySQL is not exposed publicly" }),
      redisUrl: output("redis://127.0.0.1:6379", { group: "Infrastructure", note: "Inside this VM" }),
      upstreamKey: secret(world.upstream.key, { group: "AI Gateway", note: "Synthetic upstream; no paid credentials" }),
      alexPassword: secret(den.admin.password, { group: "Accounts" }),
      dashboards: output("enabled", { group: "Org", note: "DEN_DASHBOARDS_ENABLED=true" }),
    };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await using stack = new AsyncDisposableStack();
  if (process.env.OPENWORK_WORLD_PLACE === "freestyle") {
    const { parseAppWebOptions } = await import("./lib/app-web-options.ts");
    const { ensureSnapshot } = await import("../packages/freestyle/src/builder.ts");
    const { launchPreview, deletePreview } = await import("../packages/freestyle/src/index.ts");
    const { trackResource } = await import("../packages/world/src/ledger.ts");
    const options = parseAppWebOptions(argv, process.env);
    if (!options.ref) throw new Error("ACME Freestyle requires --ref <full-pushed-sha>.");
    await ensureSnapshot(options.ref, undefined, console.error, "acme-web");
    const preview = await launchPreview({ gitSha: options.ref, lifetimeMinutes: options.lifetimeMinutes, world: "acme-web" });
    stack.defer(() => deletePreview(preview.id));
    await trackResource({ kind: "freestyle-preview", id: preview.id, match: preview.id, label: "acme-web" });
    await hold({ name: ACME_WEB_NAME, outputs: { ...preview.outputs, webUrl: secret(preview.url), expires: preview.expiresAt, snapshotId: preview.snapshotId } });
    return;
  }
  const world = await bootAcmeWeb(stack);
  await probeAcmeGateway(world);
  await hold({
    name: ACME_WEB_NAME,
    outputs: acmeWebOutputs(world),
  });
}

if (import.meta.main) await main();
