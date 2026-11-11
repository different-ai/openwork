import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { signIn } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { readDefaultDesktopPolicy } from "./desktop-policies.ts";
import { isRecord } from "./library.ts";
import { record, rows, text } from "./org-invite.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * Acme on a real isolated Den with local models under their own switch
 * (feature localModelsPolicy): Avery is the owner, Drew an admin, Riley a
 * member signed in to a real desktop app (in headless Chrome). No Ollama runs
 * on this computer; nothing here needs one.
 */
export async function localModelsPolicy(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Acme", admin: { name: "Avery Owner" }, members: { riley: { name: "Riley Member" }, drew: { name: "Drew Admin" } } },
    // AI Gateway on, so its page (and Who can use models) shows; nothing calls the gateway.
    env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:1", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:1" },
  });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { localModelsPolicy: true });
  const riley = den.members.riley;
  const drew = den.members.drew;
  if (!riley || !drew) throw new Error("Members were not seeded");

  // Drew becomes an admin. A role change ends their sessions, so they sign in again.
  const context = await seed.api(den.admin, "/v1/org");
  const drewMember = rows(record(context.body).members).find((entry) => isRecord(entry.user) && entry.user.email === drew.email);
  const promoted = await seed.api(den.admin, `/v1/members/${text(drewMember?.id)}/role`, { method: "POST", body: JSON.stringify({ role: "admin" }) });
  if (!promoted.response.ok) throw new Error(`Promote Drew: HTTP ${promoted.response.status}`);
  const drewSession = await signIn(den.ref, { email: drew.email, password: drew.password });

  const directory = seed.tmpPath("local-models-member");
  await mkdir(directory, { recursive: true });
  const token = randomUUID();
  const hostToken = randomUUID();
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, as: "riley", workspacePath: await realpath(directory), headless: true, name: "local-models-member", engine: "v1",
    env: { OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken, VITE_OPENWORK_HOST_TOKEN: hostToken },
  });
  const local = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${app.openworkUrl}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let parsed: unknown = raw;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* diagnostic text */ }
    return { status: response.status, body: parsed };
  };
  // The desktop shell hands its sign-in to the local server; the app in a browser does it here.
  const linked = await local("PUT", "/den-session", { baseUrl: den.ref.apiUrl, token: riley.token, orgId: organizationId });
  if (linked.status >= 300) throw new Error(`Den session handoff: HTTP ${linked.status}`);

  const gatewayPath = "/dashboard/ai-gateway?tab=ai-providers";
  const ownerWeb = await seed.web({ den, signedInAs: den.admin, startPath: gatewayPath, headless: true, viewport: { width: 1440, height: 1000 } });
  const adminWeb = await seed.web({ den, signedInAs: drewSession, startPath: gatewayPath, headless: true, viewport: { width: 1440, height: 1000 } });

  return {
    app, den, ownerWeb, adminWeb, organizationId,
    gatewayUrl: `${den.ref.webUrl}${gatewayPath}`,
    ollamaUrl: `${app.webUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/settings/ollama`,
    accountUrl: `${app.webUrl}/settings/cloud-account`,
    /** What Den stores for model access (a read). */
    async stored() {
      const policy = await readDefaultDesktopPolicy(seed, den.admin);
      const document = isRecord(policy.policy) ? policy.policy : {};
      return { allowCustomProviders: document.allowCustomProviders, allowLocalModels: document.allowLocalModels };
    },
    /** Has the local server read the organization's policy again, as it does on launch. */
    refreshServerPolicy: () => local("GET", "/managed-policy"),
    /** What Settings › Ollama writes when someone sets it up. */
    addOllama: () => local("PATCH", `/workspace/${encodeURIComponent(workspace.workspaceId)}/config`, {
      opencode: { provider: { ollama: { npm: "@ai-sdk/openai-compatible", name: "Ollama (local)", options: { baseURL: "http://localhost:11434/v1" }, models: { "qwen2.5-coder:7b": { name: "qwen2.5-coder:7b" } } } } },
      mergeProviderModels: ["ollama"],
    }),
  };
}
