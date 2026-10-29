import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { readDefaultDesktopPolicy } from "./desktop-policies.ts";
import { isRecord } from "./library.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * The owner of "Acme", signed in to a real Den in the real app (in a browser)
 * on the OpenCode v2 engine, with the bundled OpenCode v1 catalog behind it.
 * Personal providers are allowed and mirror without a rollout override.
 * Nothing in this computer's own OpenCode profile is read.
 */
export async function v2LocalProviderMirror(seed: Seed) {
  const folder = seed.tmpPath("acme");
  await mkdir(folder, { recursive: true });
  const workspacePath = await realpath(folder);
  const { den, webPort } = await denForAppWeb(seed, { org: { name: "Acme", admin: { name: "Acme Admin" } } });
  const token = randomUUID();
  const hostToken = randomUUID();
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, name: "v2-local-provider-mirror", workspacePath, engine: "v2", headless: true,
    // Exercise the real policy sync without waiting its production five-minute interval.
    env: { OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken, OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "1000" },
  });
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("Could not resolve the seeded organization");

  /** The app's own local OpenWork server, called from inside its page as the app does. */
  async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
    const result = await seed.evalIn(app, browserScript(async (path, method, bodyJson, token, hostToken) => {
      const port = localStorage.getItem("openwork.server.port");
      if (!port) return { status: 0, text: "missing local server port" };
      const response = await fetch("http://127.0.0.1:" + port + path, {
        method,
        headers: { Authorization: "Bearer " + token, "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
        ...(bodyJson ? { body: bodyJson } : {}),
      });
      return { status: response.status, text: await response.text() };
    }, [path, init.method ?? "GET", init.body === undefined ? "" : JSON.stringify(init.body), token, hostToken]), { awaitPromise: true, timeoutMs: 120_000 });
    let body: unknown = result.text;
    try { body = result.text ? JSON.parse(result.text) : null; } catch { /* diagnostic text */ }
    return { status: result.status, body };
  }

  // Same owned-runtime handoff as other app-in-a-browser worlds: renderer
  // sign-in alone does not give the local server the Den session the desktop
  // shell pushes (PUT /den-session), which organization policy and rollouts
  // are read with.
  const linked = await request("/den-session", { method: "PUT", body: { baseUrl: den.ref.apiUrl, token: den.admin.token, orgId: organizationId } });
  if (linked.status >= 300) throw new Error(`Den session handoff failed: HTTP ${linked.status}`);

  /** Saved the way the AI Gateway's "Who can use models" saves "Only models you provide". */
  const allowPersonalProviders = async (allowed: boolean) => {
    const stored = await readDefaultDesktopPolicy(seed, den.admin);
    const policy = { ...(isRecord(stored.policy) ? stored.policy : {}), allowCustomProviders: allowed };
    const updated = await seed.api(den.admin, `/v1/desktop-policies/${String(stored.id)}`, {
      method: "PATCH", body: JSON.stringify({ policyName: stored.policyName, policy }), signal: AbortSignal.timeout(30_000),
    });
    if (!updated.response.ok) throw new Error(`Saving model access failed: HTTP ${updated.response.status}`);
  };

  /**
   * A ChatGPT sign-in as OpenCode v1 stores it: an OAuth entry written through
   * the same engine credential route a provider sign-in ends with. The tokens
   * are synthetic and never sent anywhere.
   */
  const signInWithChatGpt = async () => {
    const saved = await request(`/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode/auth/openai`, {
      method: "PUT", body: { type: "oauth", refresh: "synthetic-refresh", access: "synthetic-access", expires: Date.now() + 86_400_000 },
    });
    if (saved.status >= 300) throw new Error(`Seeding the ChatGPT sign-in failed: HTTP ${saved.status}`);
  };

  // This proof connects its first provider through Settings. Do not create a
  // chat during setup: a fresh workspace has no usable model until that action.
  return {
    app, den, workspace, allowPersonalProviders, signInWithChatGpt,
    organizationName: "Acme",
    openRouterKey: "sk-or-v1-synthetic-not-a-real-key",
    anthropicKey: "sk-ant-synthetic-not-a-real-key",
    settingsUrl: `${app.webUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/settings/ai`,
    composerUrl: `${app.webUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/session`,
  };
}
