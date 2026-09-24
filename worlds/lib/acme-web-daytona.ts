import { randomUUID } from "node:crypto";
import { startRemoteRuntime } from "../../evals/packages/env/src/app-web-runtime.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import type { Place } from "../../evals/packages/env/src/place.ts";
import { defaultDaytonaExec } from "../../evals/packages/hosts/src/daytona.ts";
import { privateSandboxId, privateWebPreview, verifyPrivateWebPreview } from "../../evals/packages/hosts/src/private-web-preview.ts";
import { deleteSandboxes, execInSandbox, provisionWebSandbox } from "../../evals/packages/hosts/src/provision.ts";
import { trackResource } from "../../packages/world/src/ledger.ts";
import { output, secret } from "../../packages/world/src/outputs.ts";
import type { WorldOutput } from "../../packages/world/src/outputs.ts";
import { receiptName, resolveStage } from "../../packages/world/src/stage.ts";
import { ACME_REPLY, bootAcmeGatewayOnDaytona, probeAcmeGatewayDirect } from "./acme-gateway.ts";

const ACME_WEB_NAME = "acme-web";
const DAYTONA_WEB_PORT = 5178;
const DAYTONA_LIFETIME_MINUTES = 120;

/**
 * The OpenWork web runtime on its own private Daytona sandbox, proxying the
 * world's Den. Same shape as app-web, but the proxy target is this world's Den
 * preview URL so a person can sign in as alex and chat through the gateway.
 */
async function startDaytonaWebRuntime(stack: AsyncDisposableStack, place: Place, den: Den, orgId: string) {
  const base = place.denBase();
  if (base.kind !== "daytona") throw new Error("acme-web Daytona runtime needs the Daytona Den base ref.");
  const runtimeName = `${receiptName(ACME_WEB_NAME, resolveStage(process.env))}-${randomUUID().slice(0, 8)}`;
  let sandboxId: string | undefined;
  const room = await provisionWebSandbox({
    ref: base.ref, name: runtimeName, private: true, autoStopMinutes: 0,
    onCreated: async (name) => {
      sandboxId = await privateSandboxId(name);
      await trackResource({ kind: "app-web-daytona", id: sandboxId, match: sandboxId, label: runtimeName });
    },
  });
  stack.defer(() => deleteSandboxes([sandboxId ?? room.sandbox]));
  if (!sandboxId || !room.created || !room.source) throw new Error("acme-web did not receive an owned private web sandbox.");
  const issuedAt = Date.now();
  const preview = await privateWebPreview(sandboxId, DAYTONA_WEB_PORT, undefined, (DAYTONA_LIFETIME_MINUTES + 10) * 60);
  const runtime = await startRemoteRuntime(sandboxId, runtimeName, "/workspace", room.source, {
    env: {
      OPENWORK_WEB_PORT: String(DAYTONA_WEB_PORT), VITE_HOST: "0.0.0.0",
      OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
      VITE_DEN_BASE_URL: den.ref.webUrl, VITE_DEN_API_BASE_URL: den.ref.apiUrl, VITE_DISABLE_OPENWORK_MODELS: "0",
    },
    browserHostSuffix: preview.browserHostSuffix,
  });
  stack.adopt(runtime, (owned) => owned.stop());
  await verifyPrivateWebPreview(preview);
  if (Date.now() - issuedAt >= 10 * 60_000) throw new Error("acme-web exceeded its signed-preview startup buffer.");
  await signRuntimeIntoDen(sandboxId, runtime.runtimeDirectory, den, orgId);
  return { browserOrigin: preview.browserOrigin, sandboxId, expires: new Date(issuedAt + (DAYTONA_LIFETIME_MINUTES + 10) * 60_000).toISOString() };
}

/**
 * The browser only holds the runtime's client token; den-session and provider
 * sync are host-token routes, so the launcher signs the runtime into Den as
 * the seeded owner — exactly what bootAcmeWeb does locally over loopback.
 * Without this, gateway models never reach the picker.
 */
async function signRuntimeIntoDen(sandboxId: string, runtimeDirectory: string, den: Den, orgId: string) {
  const manifest = `${runtimeDirectory}/runtime.json`;
  const session = Buffer.from(JSON.stringify({ baseUrl: den.ref.apiUrl, token: den.admin.token, orgId }), "utf8").toString("base64");
  const syncBody = Buffer.from(JSON.stringify({ reason: "acme-web" }), "utf8").toString("base64");
  const script = `python3 - <<PYEOF
import base64, json, urllib.request
manifest = json.load(open(${JSON.stringify(manifest)}))
session = base64.b64decode(${JSON.stringify(session)})
headers = {"x-openwork-host-token": manifest["hostToken"], "content-type": "application/json"}
def call(method, path, body):
    request = urllib.request.Request(manifest["openworkUrl"] + path, data=body, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.status, response.read().decode("utf-8")
print("den-session", call("PUT", "/den-session", session)[0])
status, body = call("POST", "/cloud-provider-sync/run", base64.b64decode(${JSON.stringify(syncBody)}))
print("sync", status, body[:200])
PYEOF`;
  const result = await execInSandbox(defaultDaytonaExec, sandboxId, script, { timeoutMs: 120_000, context: "acme-web runtime Den sign-in" });
  if (!/den-session 204/.test(result.stdout) || !/sync 200/.test(result.stdout)) {
    throw new Error(`acme-web could not sign the web runtime into Den: ${result.stdout.slice(-400)} ${result.stderr.slice(-400)}`);
  }
}

/**
 * acme-web on Daytona: Den + real AI Gateway + deterministic upstream in one
 * sandbox, verified with one message through the public gateway URL, plus the
 * OpenWork web runtime on a private sandbox signed into that Den.
 */
export async function bootAcmeWebOnDaytona(stack: AsyncDisposableStack, place: Place): Promise<Record<string, WorldOutput>> {
  const gateway = await bootAcmeGatewayOnDaytona(stack, place, { denEnv: { DEN_DASHBOARDS_ENABLED: "true" } });
  const probe = await probeAcmeGatewayDirect(gateway.den.admin, gateway);
  const web = await startDaytonaWebRuntime(stack, place, gateway.den, gateway.model.orgId);
  const { den, model, gatewayUrl } = gateway;
  return {
    webUrl: secret(web.browserOrigin, { group: "URLs", note: "Private signed OpenWork web runtime; sign in as alex, then pick Acme AI Gateway / Claude Haiku 4.5" }),
    denWeb: output(den.ref.webUrl, { group: "URLs" }),
    denApi: output(den.ref.apiUrl, { group: "URLs" }),
    aiGateway: output(`${den.ref.webUrl}/dashboard/ai-gateway?tab=ai-providers`, { group: "URLs", note: "Den admin screen for providers, keys and who can use them" }),
    gatewayUrl: output(gatewayUrl, { group: "URLs" }),
    model: output(model.modelName, { group: "AI Gateway" }),
    providerId: output(model.providerId, { group: "AI Gateway" }),
    modelId: output(model.modelId, { group: "AI Gateway" }),
    reply: output(ACME_REPLY, { group: "AI Gateway", note: "Deterministic upstream; no paid inference keys required" }),
    verified: output(`Message through AI Gateway (${probe.upstreamRequests} upstream call)`, { group: "AI Gateway" }),
    alexEmail: output(den.admin.email, { group: "Accounts", note: "org owner (Acme)" }),
    alexPassword: secret(den.admin.password, { group: "Accounts" }),
    previewExpires: output(web.expires, { group: "Runtime" }),
    ...(den.placement?.kind === "daytona" ? { denSandbox: output(den.placement.sandboxId, { group: "World" }) } : {}),
    webSandbox: output(web.sandboxId, { group: "World" }),
  };
}
