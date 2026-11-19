import { createHash } from "node:crypto";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase, type Seed } from "@openwork/env";
import { healthFixture } from "./den-service-readiness.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { chatAs } from "./workbot-agent-library.ts";
import { ENCRYPTION_KEY, SLACK_CONNECTION_ID, encryptForDen } from "./workbot-proactive.ts";

const HOUR_MS = 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A fixed-offset zone where it is 12-something now, so the member's day has checks behind it and ahead of it. */
function noonZone(now: number) {
  let offset = 12 - new Date(now).getUTCHours();
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset === 0 ? "Etc/GMT" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

/** A timestamp as Den's ORM writes it: the UTC wall clock, whatever the MySQL session's zone. */
function sqlTime(at: number) {
  return new Date(at).toISOString().replace("T", " ").replace("Z", "");
}

function hashId(...parts: string[]) {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/**
 * Your agent's brief: Den with Workbot, a headless runner that only
 * answers health checks, and the Workbot Slack app installed (synthetic credentials). The organization used Your agent
 * before the brief: meeting prep turned off and one instruction, so its brief is carried over until the admin saves
 * it. The member's agent is as the wake left it this morning, in a zone where it is about 1 PM: checks on the rhythm
 * (one sent two messages, one stayed quiet, one found something that could wait), and an extra check it asked for
 * before a 2 PM meeting. Nothing is due during the proof, so no model, calendar or Slack is reached; "chat" is the
 * Connect call Workbot makes for the member. Fictional names only.
 */
export async function workbotAgentBriefWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const runner = stack.use(await healthFixture());
    const den = await seed.den({
      org: { name: "Acme Robotics", admin: { name: "Dana Ortiz" }, members: { member: { name: "Sam Rivera" } } },
      env: {
        DEN_WORKBOT_URL: "http://localhost:3020",
        DEN_HEADLESS_RUNNER_URL: runner.url,
        DEN_HEADLESS_RUNNER_TOKEN: "readiness-fixture-service-token-not-production",
        DEN_DB_ENCRYPTION_KEY: ENCRYPTION_KEY,
      },
    });
    const organizationId = await seededOrganizationId(seed, den.admin);
    // Your agent as the organization used it before the brief.
    const before = await seed.api(den.admin, "/v1/org/workbot-settings/proactive", { method: "PUT", body: JSON.stringify({ enabled: true, responsibilities: { meeting_prep: false }, instructions: "Ignore build bot alerts." }) });
    if (!before.response.ok) throw new Error(`Setting up Your agent failed: ${before.text.slice(0, 300)}`);
    const memberContext = await seed.api(den.members.member, "/v1/org");
    const member = isRecord(memberContext.body) && isRecord(memberContext.body.currentMember) ? memberContext.body.currentMember : null;
    const memberId = typeof member?.id === "string" ? member.id : "";
    const ownerContext = await seed.api(den.admin, "/v1/org");
    const ownerMember = isRecord(ownerContext.body) && isRecord(ownerContext.body.currentMember) ? ownerContext.body.currentMember : null;
    const ownerMemberId = typeof ownerMember?.id === "string" ? ownerMember.id : "";
    const databaseUrl = den.database?.url;
    if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_") || !memberId || !ownerMemberId) {
      throw new Error("The agent fixture needs a disposable testkit database and both memberships.");
    }
    await seed.nativeConnector(den.admin, {
      providerKey: "google-workspace",
      name: "Google Workspace",
      clientId: "fixture-client.apps.googleusercontent.com",
      clientSecret: "fixture-secret",
      features: ["calendarRead", "gmailDraft", "driveRead"],
      access: { orgWide: true },
    });
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO external_mcp_connection (id, organization_id, name, url, auth_type, credential_mode, created_by_org_membership_id) VALUES (?, ?, 'Slack', 'https://mcp.slack.com/mcp', 'oauth', 'per_member', ?)",
      [SLACK_CONNECTION_ID, organizationId, ownerMemberId],
    );
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO slack_assistant_installation (connection_id, organization_id, enabled, signing_secret, team_id, app_id, bot_user_id, bot_token) VALUES (?, ?, 1, ?, 'T0FIXTURE', 'A0FIXTURE', 'U0WORKBOT', ?)",
      [SLACK_CONNECTION_ID, organizationId, encryptForDen("synthetic-signing-secret"), encryptForDen("xoxb-synthetic-not-a-token")],
    );

    // The member's agent as this morning's checks left it, with an extra check it asked for at 1:45 PM.
    const now = Date.now();
    const timeZone = noonZone(now);
    // Noon, the 12 PM check; the agent asked for an extra one at 1:45 PM, before the 2 PM check.
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    const lastCheck = hourStart;
    const requested = hourStart + 105 * 60_000;
    const why = "before your 2 PM with Northwind Labs";
    const state = {
      v: 1, calendar: null, lastLook: { calendar: lastCheck, email: lastCheck, chat: lastCheck }, lastPassAt: lastCheck, nextPassAt: lastCheck + 2 * HOUR_MS, woke: [], notices: {},
      requests: [{ at: requested, why, requestedAt: lastCheck }],
    };
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO agent_instance (member_id, organization_id, time_zone, state, next_wake_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE time_zone = VALUES(time_zone), state = VALUES(state), next_wake_at = VALUES(next_wake_at), lease_owner = NULL, lease_until = NULL",
      [memberId, organizationId, timeZone, encryptForDen(JSON.stringify(state)), sqlTime(now + 6 * HOUR_MS), sqlTime(now - 3 * 24 * HOUR_MS), sqlTime(now)],
    );
    const checks: [string, number, string, string, string, string, string | null][] = [
      ["first", hourStart - 4 * HOUR_MS + 60_000, "morning", "sent", "sent", "Sent you 2 messages from Gmail and Slack.", JSON.stringify({ channelId: "D0FIXTURE", messageTs: "1700000000.000100", permalink: "https://example.slack.com/archives/D0FIXTURE/p1700000000000100" })],
      ["ten", hourStart - 2 * HOUR_MS + 60_000, "scheduled", "quiet", "no_findings", "Stayed quiet: nothing needed you.", null],
      ["noon", lastCheck, "scheduled", "quiet", "findings_held", "Stayed quiet: found something that can wait for a later check.", null],
    ];
    for (const [key, at, kind, outcome, reason, summary, message] of checks) {
      await queryDenDatabase(
        databaseUrl,
        "INSERT INTO agent_member_check (id, organization_id, member_id, checked_at, kind, outcome, reason, summary, responsibilities, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)",
        [hashId(memberId, key), organizationId, memberId, sqlTime(at), kind, outcome, reason, summary, message],
      );
    }
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO agent_delivery (id, organization_id, member_id, responsibility, outcome, created_at) VALUES (?, ?, ?, 'brief', 'sent', ?), (?, ?, ?, 'brief', 'sent', ?)",
      [hashId(memberId, "email:thr_sow"), organizationId, memberId, sqlTime(checks[0]?.[1] ?? now), hashId(memberId, "chat:priya"), organizationId, memberId, sqlTime(checks[0]?.[1] ?? now)],
    );

    const headers = (session: DenSession) => ({ authorization: `Bearer ${session.token}`, "x-openwork-org-id": organizationId, "content-type": "application/json" });
    const setBrief = async (on: boolean) => {
      const result = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", headers: headers(den.admin), body: JSON.stringify({ capabilities: { workbotAgentBrief: on } }) });
      if (!result.response.ok) throw new Error(`Setting workbotAgentBrief failed: ${result.text.slice(0, 300)}`);
    };
    const viewport = { width: 1280, height: 1700, deviceScaleFactor: 1 };
    const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport });
    const web = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard/library/my-agent", headless: true, viewport: { width: 1280, height: 2100, deviceScaleFactor: 1 } });
    return {
      den,
      owner,
      web,
      timeZone,
      requested,
      why,
      sayInChat: (name: string, body?: unknown) => chatAs(den.members.member, organizationId, name, body),
      /** The platform admin turns the brief on or off for this organization, as /admin does. */
      setBrief,
      async [Symbol.asyncDispose]() {
        await stack.disposeAsync();
      },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
