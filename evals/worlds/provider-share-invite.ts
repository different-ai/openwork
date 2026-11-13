import { randomUUID } from "node:crypto";
import { allocateFreePorts } from "@openwork/cdp";
import { mkdir, realpath } from "node:fs/promises";
import { signIn } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { emailLinks, invitationWitnesses, record, text } from "./org-invite.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/** Real isolated Den + the desktop's real app/server in headless Chrome. Keys are synthetic; no model request is made. */
export async function providerShareInvite(seed: Seed) {
  if (process.env.OPENWORK_EVAL_DEN_API_URL) throw new Error("Provider sharing proof requires a cold isolated Den, never a reused server");
  const runId = randomUUID().slice(0, 8);
  const organizationName = `Share Lab ${runId}`;
  // A second desktop, for the plain member, on its own trusted origin.
  const [memberPort] = await allocateFreePorts(1);
  if (!memberPort) throw new Error("No port for the member's desktop");
  const { den, webPort } = await denForAppWeb(seed, {
    web: true,
    trustedOrigins: [`http://127.0.0.1:${memberPort}`],
    env: {
      DEN_ORG_MODE: "multi_org", OPENWORK_DEV_MODE: "1", RESEND_API_KEY: "", SMTP_HOST: "",
      GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:1", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:1",
    },
    org: { name: organizationName, admin: { name: "Share Owner" }, members: { member: { name: "Plain Member" } } },
  });
  const organizationId = await seededOrganizationId(seed, den.admin);
  const member = den.members.member;
  if (!member) throw new Error("Plain member was not seeded");
  const witnesses = invitationWitnesses(den.admin);
  const directory = seed.tmpPath("provider-share-owner");
  await mkdir(directory, { recursive: true });
  const token = randomUUID();
  const hostToken = randomUUID();
  // This journey exercises the supported v1 credential store, not v2 engine migration.
  const app = await seed.appWeb({
    den: den.ref, webPort, workspacePath: await realpath(directory), headless: true, name: "provider-share-invite", engine: "v1",
    env: { OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken, VITE_OPENWORK_HOST_TOKEN: hostToken, OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "1000" },
  });
  const workspace = await seed.workspace(app, await realpath(directory));
  // Read-only network witness: retain only the share response, never request headers or the key.
  const shareResponses: Array<{ status: number; body?: string }> = [];
  const shareRequestIds = new Map<string, number>();
  const pending = new Map<string, { method: string; path: string; status?: number }>();
  const network = new WebSocket(app.client.webSocketDebuggerUrl!);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Share response observer did not connect")), 10_000);
    network.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    network.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Share response observer did not connect")); }, { once: true });
  });
  network.send(JSON.stringify({ id: 1, method: "Network.enable" }));
  network.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Network.requestWillBeSent") {
      const request = message.params.request;
      if (request.url.startsWith(app.openworkUrl)) pending.set(message.params.requestId, { method: request.method, path: new URL(request.url).pathname });
    }
    if (message.method === "Network.responseReceived" && pending.has(message.params.requestId)) pending.get(message.params.requestId)!.status = Number(message.params.response.status);
    if (["Network.loadingFinished", "Network.loadingFailed"].includes(message.method)) pending.delete(message.params.requestId);
    if (message.method === "Network.responseReceived" && String(message.params?.response?.url).includes("/cloud-provider-sync/device-providers/openai/share")) {
      shareRequestIds.set(message.params.requestId, shareResponses.length);
      shareResponses.push({ status: Number(message.params.response.status) });
    }
    if (message.method === "Network.loadingFinished" && shareRequestIds.has(message.params?.requestId)) {
      const index = shareRequestIds.get(message.params.requestId)!;
      network.send(JSON.stringify({ id: 100 + index, method: "Network.getResponseBody", params: { requestId: message.params.requestId } }));
    }
    if (typeof message.id === "number" && message.id >= 100 && shareResponses[message.id - 100]) {
      shareResponses[message.id - 100]!.body = String(message.result?.body ?? "response unavailable").slice(0, 600);
    }
  });
  const localRequest = async (path: string, body?: unknown) => {
    const response = await fetch(`${app.openworkUrl}${path}`, {
      method: body === undefined ? "GET" : "PUT",
      headers: { Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const raw = await response.text();
    return { status: response.status, text: raw, body: raw ? JSON.parse(raw) as unknown : null };
  };
  // The native shell performs this handoff; appWeb must do it explicitly too.
  const linked = await localRequest("/den-session", { baseUrl: den.ref.apiUrl, token: den.admin.token, orgId: organizationId });
  if (linked.status >= 300) throw new Error(`Den session handoff: HTTP ${linked.status}`);
  const catalog = await localRequest(`/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode/provider`);
  const config = await localRequest(`/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode/config`);
  if (catalog.status !== 200 || config.status !== 200) {
    const engine = await localRequest("/experimental/engine-v2-preview/status");
    throw new Error(`Runtime catalog unavailable: HTTP ${catalog.status} ${catalog.text.slice(0, 1000)}; config HTTP ${config.status} ${config.text.slice(0, 1000)}; engine ${JSON.stringify(engine.body)}`);
  }
  const ownerWeb = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/members", headless: true, viewport: { width: 1440, height: 1000 } });
  const inviteWeb = await seed.web({ den, startPath: "/", headless: true, viewport: { width: 1440, height: 1000 } });
  await inviteWeb.client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const person = { name: "New Teammate", email: `provider-new-${runId}@openwork.test`, password: `Synthetic-${runId}-password!` };
  const other = await seed.api(member, "/v1/org", { method: "POST", body: JSON.stringify({ name: `Other Lab ${runId}` }) });
  if (!other.response.ok) throw new Error(`Other organization: ${other.response.status}`);
  const otherOrganizationId = text(record(record(other.body).organization).id);
  // Creating "Other Lab" made it the member's active organization; put them back in the shared one.
  const restored = await seed.api(member, "/v1/me/active-organization", { method: "POST", body: JSON.stringify({ organizationId }) });
  if (!restored.response.ok) throw new Error(`Restore organization: ${restored.response.status}`);
  const memberDirectory = seed.tmpPath("provider-share-member");
  await mkdir(memberDirectory, { recursive: true });
  const memberToken = randomUUID();
  const memberHostToken = randomUUID();
  const memberSide = await signedInAppWeb(seed, {
    den, webPort: memberPort, as: "member", workspacePath: await realpath(memberDirectory), headless: true, name: "provider-share-member", engine: "v1",
    env: { OPENWORK_TOKEN: memberToken, OPENWORK_HOST_TOKEN: memberHostToken, VITE_OPENWORK_HOST_TOKEN: memberHostToken, OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "1000" },
  });
  const memberLinked = await fetch(`${memberSide.app.openworkUrl}/den-session`, {
    method: "PUT", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${memberToken}`, "x-openwork-host-token": memberHostToken, "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: den.ref.apiUrl, token: member.token, orgId: organizationId }),
  });
  if (memberLinked.status >= 300) throw new Error(`Member Den session handoff: HTTP ${memberLinked.status}`);
  return {
    app, den, ownerWeb, inviteWeb, member, otherOwner: member, organizationId, otherOrganizationId, organizationName, person, witnesses,
    key: "sk-synthetic-provider-share-proof-never-call-a-provider",
    settingsUrl: `${app.webUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/settings/ai`,
    memberApp: memberSide.app,
    memberSettingsUrl: `${memberSide.app.webUrl}/workspace/${encodeURIComponent(memberSide.workspace.workspaceId)}/settings/ai`,
    async providers() {
      try {
        return await witnesses.api("/v1/inference-providers", { headers: { "x-openwork-org-id": organizationId } });
      } catch (error) {
        throw new Error(`Provider witness failed: ${String(error)}; Den API log tail: ${(await den.apiLog()).slice(-6000)}`);
      }
    },
    async inviteLink(email: string) {
      const html = await witnesses.lastEmail("organizationInvite", email);
      const link = emailLinks(html).find((url) => new URL(url).pathname === "/join-org");
      if (!link) throw new Error("Captured local invitation email had no join link");
      return link;
    },
    sessionFor: () => signIn(den.ref, person),
    async ownerGrant() {
      const result = await seed.api(den.admin, "/v1/auth/desktop-handoff", { method: "POST", body: JSON.stringify({ desktopScheme: "openwork" }) });
      if (!result.response.ok) throw new Error(`One-time handoff: HTTP ${result.response.status}`);
      return text(record(result.body).grant);
    },
    localRequest,
    shareResponses: () => [...shareResponses],
    async shareDiagnostics() {
      return { pending: [...pending.values()],
        providers: await witnesses.api("/v1/inference-providers", { headers: { "x-openwork-org-id": organizationId } }).then((r) => ({ status: r.response.status, count: record(r.body).inferenceProviders instanceof Array ? (record(r.body).inferenceProviders as unknown[]).length : null })).catch(() => null),
        sync: await localRequest("/cloud-provider-sync/status").then((r) => ({ status: r.status, body: r.body })).catch((e) => String(e)),
        denLog: (await den.apiLog()).slice(-10000),
      };
    },
    [Symbol.asyncDispose]: async () => { network.close(); },
  };
}
