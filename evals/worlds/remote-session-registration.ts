import { denFetch } from "@openwork/behaviors";
import { createOrg, type Place, type Seed } from "@openwork/env";
import { object, records, remoteSessionGateway, string } from "./fixtures/remote-session-gateway.ts";

export { object, record, records, string } from "./fixtures/remote-session-gateway.ts";
export const SHARED_INSTALL_ID = "synthetic_shared_session_install";
export const WORKSPACE_ID = "synthetic_native_workspace";
const REMOTE_CAPABILITIES = ["remote_session_v1", "remote_session_control_v1", "remote_session_only_v1", "remote_session_recovery_v1"];

/** Real Den HTTP/MCP/database; a synthetic wire client, not a fake native host. */
async function registrationWorld(seed: Seed, options: { automations?: boolean; place?: Place } = {}) {
  const den = await seed.den({
    web: false,
    org: { name: "Session registration proof", admin: { name: "Session Proof Admin", email: "session-registration-admin@example.test" }, members: { other: { name: "Other Session Member" } } },
    env: {
      // An organization owner is not automatically a platform administrator,
      // especially in Daytona. Rollout controls need explicit synthetic setup.
      DEN_BOOTSTRAP_ADMIN_EMAILS: "session-registration-admin@example.test",
      DEN_AUTOMATIONS_ENABLED: options.automations ? "true" : "false",
      DEN_AUTOMATIONS_RUNTIME_ENABLED: options.automations ? "true" : "false",
      DEN_OPENWORK_WEB_ENABLED: "false",
    },
  });
  const initial = await denFetch(den.admin, "/v1/org", { headers: { authorization: `Bearer ${den.admin.token}` } });
  if (!initial.response.ok) throw new Error(`Initial organization HTTP ${initial.response.status}`);
  const organizationId = string(object(object(initial.body).organization).id);
  const other = den.members.other;
  if (!other) throw new Error("Missing negative remote-session member");
  const otherOrg = await createOrg(den, "Other session registration proof");
  const gateway = remoteSessionGateway({
    owner: { session: den.admin, organizationId },
    otherMember: { session: other, organizationId },
    otherOrg: { session: den.admin, organizationId: otherOrg.id },
  });
  const runnerTokens = new Map<string, string>();
  const runnerIds = new Map<string, string>();
  async function runner(persona: string, path: string, method = "GET", body?: unknown) {
    const token = runnerTokens.get(persona);
    if (!token) throw new Error(`No registered session runner for ${persona}`);
    return gateway.api(persona, path, method, body, token);
  }
  return {
    den, organizationId, otherOrganizationId: otherOrg.id,
    api: gateway.api,
    rollout: gateway.rollout,
    remote: gateway.remote,
    search: (persona = "owner") => gateway.call(persona, "search_capabilities", { query: "remote session targets registered computer", limit: 20 }),
    async featureState() {
      const result = await gateway.api("owner", "/v1/admin/features");
      if (result.status !== 200) throw new Error(`Feature inventory HTTP ${result.status}`);
      const feature = records(object(result.body).features).find(item => item.key === "remoteSessionTargets");
      if (!feature) throw new Error("Missing remote-session rollout");
      return feature;
    },
    async register(persona: string, runnerId = SHARED_INSTALL_ID, options: { legacy?: boolean; scheduling?: boolean } = {}) {
      const result = await gateway.api(persona, options.legacy ? "/v1/automation-runners/token" : "/v1/session-runners/token", "POST", {
        runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"],
        capabilities: options.scheduling ? [] : REMOTE_CAPABILITIES,
        appVersion: "synthetic-boundary-proof", platform: "linux", concurrency: 1,
      });
      if (result.status !== 200) return result;
      const body = object(result.body);
      runnerTokens.set(persona, string(body.token));
      runnerIds.set(persona, runnerId);
      // Tokens remain private to the world and never appear in evidence.
      return { status: result.status, body: { expiresAt: body.expiresAt, eventsPath: body.eventsPath, runnerId } };
    },
    inventory(persona: string) {
      return runner(persona, "/v1/session-runners/inventory", "PUT", {
        computer: { label: `Synthetic ${persona} computer`, platform: "linux", appVersion: "synthetic-boundary-proof" },
        workspaces: [{ workspaceId: WORKSPACE_ID, name: "Boundary directory", active: true, engine: "v2", defaultModel: null, models: [] }],
      });
    },
    runner,
    rawRunnerId: (persona: string) => runnerIds.get(persona),
    work: (persona: string) => runner(persona, "/v1/session-runners/work"),
    claim: (persona: string, commandId: string) => runner(persona, `/v1/remote-session-commands/${commandId}/claim`, "POST"),
    complete: (persona: string, commandId: string, body: unknown) => runner(persona, `/v1/remote-session-commands/${commandId}/complete`, "POST", body),
    report: (persona: string, commandId: string, body: unknown) => runner(persona, `/v1/remote-session-commands/${commandId}/session`, "POST", body),
    claimRequest: (persona: string, requestId: string) => runner(persona, `/v1/remote-session-requests/${requestId}/claim`, "POST"),
    completeRequest: (persona: string, requestId: string, body: unknown) => runner(persona, `/v1/remote-session-requests/${requestId}/complete`, "POST", body),
    async [Symbol.asyncDispose]() { await otherOrg[Symbol.asyncDispose](); },
  };
}

export function remoteSessionRegistration(seed: Seed) { return registrationWorld(seed); }
// A separate, sequential world makes Automation presence observable. The main
// boundary world has its scheduling runtime entirely absent, not merely idle.
export function remoteSessionAutomationPresence(seed: Seed) { return registrationWorld(seed, { automations: true }); }
