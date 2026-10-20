import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { configureProvider } from "./chat.ts";
import { modelRemovalHttpFixture } from "./model-removal-cdp.ts";

/** Real app, authentication and continuation; native recorded setup results and credential HTTP faults are fixtures. */
export async function credentialCardRecovery(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed);
  const organizationId = await seededOrganizationId(seed, den.admin);
  const enabled = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { secureSecretFields: true } }) });
  if (!enabled.response.ok) throw new Error(`Credential rollout setup failed: ${enabled.response.status}`);
  const continuation = "I've saved the key. Go ahead.";
  const answer = "Both credential requests are ready.";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{ promptMarker: continuation, latestUserTurn: true, finalReply: answer, steps: [] }] });
  const { app, workspace } = await signedInAppWeb(seed, { den, webPort, name: "credential-card-recovery", engine: "v2", workspacePath: seed.tmpPath("credential-card-recovery"), mocks: { agent: mock } });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing credential continuation model");
  await configureProvider(seed, app, workspace.workspaceId, "credential-fixture", "credential-model", {
    provider: { "credential-fixture": { npm: "@ai-sdk/openai-compatible", name: "Credential fixture", options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-model-key" }, models: { "credential-model": { name: "Credential model" } } } },
  }, "v2");
  const session = await seed.session(app, { title: "Connection setup" });
  const prompts = [
    { schemaVersion: "1", kind: "credential_prompt", name: "Project provider", destination: null, target: { type: "gateway_provider_credential", inferenceProviderId: "ipr_fixture", credentialSetId: "gcs_fixture", credentialKind: "aws_keys" } },
    { schemaVersion: "1", kind: "credential_prompt", name: "Project status", destination: "https://fixture.example/mcp", target: { type: "mcp_connection_key", connectionId: "emc_fixture" } },
  ];
  const now = Date.now();
  const details = [...prompts, prompts[0]].map((prompt, ordinal) => ({ tool: "openwork-cloud.execute_capability", ordinal, status: "completed", input: { name: prompt?.target.type === "mcp_connection_key" ? "postMcpConnections" : "postInferenceProviders", body: {} }, output: { credentialPrompt: prompt } }));
  const history = [
    { id: "msg_setup_user", sessionID: session.sessionId, type: "user", time: { created: now - 10_000 }, text: "Set up the project provider and status service." },
    { id: "msg_setup_agent", sessionID: session.sessionId, type: "assistant", time: { created: now - 9_000, completed: now - 8_000 }, model: { providerID: "credential-fixture", id: "credential-model" }, finish: "stop", content: [
      { type: "tool", tool: "execute", callID: "call_setup", time: { created: now - 9_000, ran: now - 9_000, completed: now - 8_000 }, state: { status: "completed", input: { code: "return await setupProjectConnections();" }, metadata: { openworkToolDetails: details }, content: [{ type: "text", text: "The project connections need private credentials." }] } },
    ] },
  ];
  let historyActive = true;
  let historyReleased = false;
  const historyWaiters = new Set<() => void>();
  const releaseHistory = () => { historyReleased = true; for (const wake of historyWaiters) wake(); historyWaiters.clear(); };
  let providerSaves = 0;
  let connectionSaves = 0;
  let continuations = 0;
  const fixture = await modelRemovalHttpFixture(app, ["*/opencode2/api/session/*/message*", "*/opencode2/api/session/*/prompt", "*/v1/inference-providers/ipr_fixture/*", "*/v1/mcp-connections*"], async (url, request) => {
    const root = url.pathname.match(/\/opencode2\/api\/session\/([^/]+)\/message(?:\/([^/]+))?$/);
    if (historyActive && root?.[1] === session.sessionId && request.method === "GET") {
      if (!historyReleased) await new Promise<void>((resolve) => historyWaiters.add(resolve));
      return { data: root[2] ? history.find((message) => message.id === root[2]) : history };
    }
    if (url.pathname.endsWith(`/opencode2/api/session/${session.sessionId}/prompt`) && request.method === "POST") { continuations++; historyActive = false; return undefined; }
    if (url.pathname.endsWith("/inference-providers/ipr_fixture/credential-sets")) return { credentialSets: [{ id: "gcs_fixture", credentialStatus: providerSaves > 1 ? "ready" : "missing" }] };
    if (url.pathname.endsWith("/inference-providers/ipr_fixture/credential-sets/gcs_fixture") && request.method === "PATCH") {
      providerSaves++;
      return providerSaves === 1 ? Response.json({ error: "credential_rejected", message: "Fixture rejected credentials" }, { status: 400 }) : { ok: true };
    }
    if (url.pathname.endsWith("/mcp-connections/emc_fixture/shared-credential") && request.method === "PUT") { connectionSaves++; return { ok: true }; }
    if (url.pathname.endsWith("/mcp-connections") && request.method === "GET") return { connections: [{ id: "emc_fixture", connected: connectionSaves > 0 }] };
    return undefined;
  }, ["GET", "POST", "PUT", "PATCH"]);
  return { app, session, answer, releaseHistory, counts() { fixture.check(); return { providerSaves, connectionSaves, continuations }; }, async [Symbol.asyncDispose]() { releaseHistory(); await fixture[Symbol.asyncDispose](); } };
}
