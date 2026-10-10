import { randomBytes } from "node:crypto";
import type { DenSession } from "@openwork/behaviors";
import { faultProxy, localMysqlIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./dashboards.ts";
import { isRecord, records, stringField } from "./library.ts";

const models = [
  { id: "fixture/slack-default", name: "Slack fixture default" },
  { id: "fixture/slack-review", name: "Slack fixture review" },
];

/**
 * Real Den, owner session, permissions, connector page and settings persistence.
 * Only the runner catalog is a boundary fixture, using the existing fault lab.
 * Slack is deliberately uninstalled and unsigned-in: there is no provider
 * discovery, OAuth, webhook, task or publishing step in this setup journey.
 */
export async function slackAssistantSetup(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("the deterministic runner catalog runs next to a local Den");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim() || process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim()) {
    throw new Error("Slack setup proof requires a disposable Den, never an attached service");
  }
  // The fallback is loopback, and the catch-all refuses every non-catalog call.
  // The lab records only method/path/status, never auth headers or request bodies.
  const runner = await faultProxy({ apiUrl: "http://127.0.0.1:9", webUrl: "http://127.0.0.1:9" }, { place });
  await runner.faults.status("/v1/models", 200, {
    method: "GET", times: 10_000, body: { defaultModel: models[0].id, models },
  });
  await runner.faults.status("/", 503, { times: 10_000, body: { error: "setup_proof_does_not_run_tasks" } });

  try {
    const den = await seed.den({
      web: true,
      env: {
        NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org",
        DEN_ALLOW_PRIVATE_MCP_URLS: "1",
        DEN_HEADLESS_RUNNER_URL: runner.ref.webUrl,
        DEN_HEADLESS_RUNNER_TOKEN: randomBytes(32).toString("base64url"),
        // Prove organization overrides, without inherited deployment locks.
        DEN_FEATURE_SLACK_ASSISTANT: undefined, DEN_FEATURE_PERMISSIONS: undefined,
        DEN_FEATURE_WORKBOT_DEFAULT_MODEL: undefined,
        RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
      },
      org: {
        name: "Slack setup proof workspace",
        admin: { name: "Slack Owner", email: "slack-owner@example.test" },
        members: {
          teammate: { name: "Slack Teammate", email: "slack-teammate@example.test" },
          unflaggedOwner: { name: "Slack Unflagged Owner", email: "slack-unflagged-owner@example.test" },
        },
      },
    });
    const teammate = den.members.teammate;
    const unflaggedOwner = den.members.unflaggedOwner;
    if (!teammate || !unflaggedOwner) throw new Error("The two boundary personas were not provisioned");
    const orgId = await enableOrganizationCapabilities(seed, den.admin, { slackAssistant: true, permissions: true });
    const originalOrg = await seed.api(den.admin, "/v1/org", { headers: { "x-openwork-org-id": orgId } });
    if (!originalOrg.response.ok || !isRecord(originalOrg.body)) throw new Error("The owner organization was not readable");
    if (!isRecord(originalOrg.body.currentMember) || originalOrg.body.currentMember.isOwner !== true) {
      throw new Error("The setup persona must be the real organization owner");
    }
    const teammateMember = records(originalOrg.body.members).find((member) => isRecord(member.user) && member.user.email === teammate.email);
    const teammateId = stringField(teammateMember, "id");
    if (!teammateId) throw new Error("The teammate membership is missing");
    const team = await seed.api(den.admin, "/v1/teams", {
      headers: { "x-openwork-org-id": orgId }, method: "POST",
      body: JSON.stringify({ name: "Slack setup readers", memberIds: [teammateId] }),
    });
    const teamId = stringField(isRecord(team.body) ? team.body.team : null, "id");
    if (!team.response.ok || !teamId) throw new Error(`Could not arrange the reader team: HTTP ${team.response.status}`);
    const permission = await seed.api(den.admin, "/v1/permissions/sets", {
      headers: { "x-openwork-org-id": orgId }, method: "POST",
      // One unrelated admin-area permission keeps the direct route present and
      // locked with its reason, without granting connection read or management.
      body: JSON.stringify({ teamId, permissions: [{ key: "inference.view", status: "allow" }] }),
    });
    if (!permission.response.ok) throw new Error(`Could not arrange the teammate boundary: HTTP ${permission.response.status}`);

    const unflagged = await seed.api(unflaggedOwner, "/v1/org", {
      method: "POST", body: JSON.stringify({ name: "Slack setup unflagged workspace" }),
    });
    const unflaggedOrgId = stringField(isRecord(unflagged.body) ? unflagged.body.organization : null, "id");
    if (!unflagged.response.ok || !unflaggedOrgId) throw new Error(`Could not arrange the unflagged workspace: HTTP ${unflagged.response.status}`);
    for (const [id, enabled] of [[orgId, true], [unflaggedOrgId, false]] satisfies [string, boolean][]) {
      const flags = await seed.api(den.admin, `/v1/admin/organizations/${id}/capabilities`, {
        method: "PUT", body: JSON.stringify({ capabilities: { slackAssistant: enabled, workbotDefaultModel: false } }),
      });
      if (!flags.response.ok) throw new Error(`Could not arrange Slack rollout: HTTP ${flags.response.status}`);
    }

    async function addSlack(owner: DenSession, organizationId: string) {
      // Creating an OAuth connection only stores its configuration. Do not sign
      // in, list its tools or start the separate Slack bot installation flow.
      const created = await seed.api(owner, "/v1/mcp-connections", {
        headers: { "x-openwork-org-id": organizationId }, method: "POST",
        body: JSON.stringify({
          name: "Slack", url: "https://mcp.slack.com/mcp", authType: "oauth", credentialMode: "per_member",
          access: { orgWide: false, memberIds: [], teamIds: [] },
        }),
      });
      const id = stringField(created.body, "id");
      if (!created.response.ok || !id) throw new Error(`Could not arrange Slack: HTTP ${created.response.status}`);
      return { id, path: `/v1/mcp-connections/${id}/slack-assistant`, pagePath: `/dashboard/mcp-connections/${id}` };
    }
    const connection = await addSlack(den.admin, orgId);
    const unflaggedConnection = await addSlack(unflaggedOwner, unflaggedOrgId);
    // Seed a secret in the OFF workspace so the rollout, not missing credentials,
    // is the reason its Enable control stays locked. Never install a real bot.
    const offConfig = await seed.api(unflaggedOwner, unflaggedConnection.path, {
      headers: { "x-openwork-org-id": unflaggedOrgId }, method: "PUT",
      body: JSON.stringify({ enabled: false, signingSecret: "fixture-off-signing-secret-not-real-0123456789" }),
    });
    if (!offConfig.response.ok) throw new Error(`Could not arrange OFF credentials: HTTP ${offConfig.response.status}`);
    const viewport = { width: 1440, height: 1100 };
    const web = await seed.web({ den, signedInAs: den.admin, startPath: connection.pagePath, headless: true, viewport });
    const teammateWeb = await seed.web({ den, signedInAs: teammate, startPath: connection.pagePath, headless: true, viewport });
    const unflaggedWeb = await seed.web({ den, signedInAs: unflaggedOwner, startPath: unflaggedConnection.pagePath, headless: true, viewport });
    return {
      den, web, teammate, teammateWeb, unflaggedOwner, unflaggedWeb, orgId, unflaggedOrgId,
      connection, unflaggedConnection, models,
      signingSecret: "fixture-slack-signing-secret-not-real-0123456789",
      runnerRequests: () => runner.requestLog(),
      async [Symbol.asyncDispose]() { await runner[Symbol.asyncDispose](); },
    };
  } catch (error) {
    await runner[Symbol.asyncDispose]();
    throw error;
  }
}
