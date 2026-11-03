import { createHash } from "node:crypto";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase, type Seed } from "@openwork/env";
import { healthFixture } from "./den-service-readiness.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { ENCRYPTION_KEY, SLACK_CONNECTION_ID, encryptForDen } from "./workbot-proactive.ts";

const HOUR_MS = 3_600_000;

/**
 * What Workbot does after reading a member's message: one Connect capability call as them (mcp:read and mcp:write),
 * the way chat changes their agent. Returns the capability's parsed answer and whether it succeeded.
 */
export async function chatAs(session: DenSession, organizationId: string, name: string, body?: unknown): Promise<{ ok: boolean; body: unknown }> {
  const headers = { authorization: `Bearer ${session.token}`, "x-openwork-org-id": organizationId, "content-type": "application/json" };
  const minted = await denFetch(session, "/v1/mcp/token", { method: "POST", headers, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  const token = isRecord(minted.body) && typeof minted.body.token === "string" ? minted.body.token : "";
  if (!token) throw new Error(`Minting the member's Connect token failed: ${minted.text.slice(0, 300)}`);
  const call = await denFetch(session, "/mcp/agent", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: { name, ...(body === undefined ? {} : { body }) } } }),
  });
  const line = call.text.split("\n").find((entry) => entry.startsWith("data:"));
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : call.body;
  const result = isRecord(envelope) && isRecord(envelope.result) ? envelope.result : null;
  const content = result && Array.isArray(result.content) ? result.content : [];
  const first: unknown = content[0];
  const text = isRecord(first) && typeof first.text === "string" ? first.text : "";
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A plain-text error stays text.
  }
  return { ok: result?.isError !== true, body: parsed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A fixed-offset zone where it is about 2 PM now, so the member's day has a morning behind it and the agent's
 * working hours (8 AM–7 PM) are open whenever the proof runs.
 */
function afternoonZone(now: number) {
  let offset = 14 - new Date(now).getUTCHours();
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
 * My agent in the Library (`workbotProactive`): Den with Workbot and Your agent on for one organization, the
 * Workbot Slack app installed (synthetic credentials, nobody linked), and the member's agent as the wake left it this
 * morning: its time zone, a DM it sent (in the delivery ledger and as a check), a quiet check, and earlier checks this
 * week. My agent starts off, so the proof shows the Library before and after. No calendar, model or Slack is reached:
 * the member's agent is not due during the proof, and "chat" is the Connect call Workbot makes for the member.
 */
export async function workbotAgentLibraryWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const runner = stack.use(await healthFixture());
    const den = await seed.den({
      org: {
        name: "Agent library",
        admin: { name: "Workspace Owner" },
        members: { member: { name: "Workspace Member" } },
      },
      env: {
        DEN_WORKBOT_URL: "http://localhost:3020",
        DEN_HEADLESS_RUNNER_URL: runner.url,
        DEN_HEADLESS_RUNNER_TOKEN: "readiness-fixture-service-token-not-production",
        DEN_DB_ENCRYPTION_KEY: ENCRYPTION_KEY,
      },
    });
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { workbotProactive: true });
    // Your agent on for everyone, with one responsibility the admin turned off (the member sees it locked).
    const enabled = await seed.api(den.admin, "/v1/org/workbot-settings/proactive", { method: "PUT", body: JSON.stringify({ enabled: true, responsibilities: { waiting_on_you: false } }) });
    if (!enabled.response.ok) throw new Error(`Turning on Your agent failed: ${enabled.text.slice(0, 300)}`);
    const context = await seed.api(den.members.member, "/v1/org");
    const member = isRecord(context.body) && isRecord(context.body.currentMember) ? context.body.currentMember : null;
    const memberId = typeof member?.id === "string" ? member.id : "";
    const ownerContext = await seed.api(den.admin, "/v1/org");
    const owner = isRecord(ownerContext.body) && isRecord(ownerContext.body.currentMember) ? ownerContext.body.currentMember : null;
    const ownerMemberId = typeof owner?.id === "string" ? owner.id : "";
    const databaseUrl = den.database?.url;
    if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_") || !memberId || !ownerMemberId) {
      throw new Error("The agent fixture needs a disposable testkit database and both memberships.");
    }

    // The Google Workspace connector the agent reads through, as an admin adds it from the catalog.
    const google = await seed.nativeConnector(den.admin, {
      providerKey: "google-workspace",
      name: "Google Workspace",
      clientId: "fixture-client.apps.googleusercontent.com",
      clientSecret: "fixture-secret",
      features: ["calendarRead", "gmailDraft", "driveRead"],
      access: { orgWide: true },
    });

    // The Workbot Slack app, installed and on (synthetic workspace, token and signing secret).
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

    // The member's agent as the wake left it: not due during the proof, so nothing runs for them. Den's own loop may
    // have given them an agent row already; this one wins.
    const now = Date.now();
    const timeZone = afternoonZone(now);
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO agent_instance (member_id, organization_id, time_zone, next_wake_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE time_zone = VALUES(time_zone), next_wake_at = VALUES(next_wake_at), lease_owner = NULL, lease_until = NULL",
      [memberId, organizationId, timeZone, sqlTime(now + 2 * HOUR_MS), sqlTime(now - 3 * 24 * HOUR_MS), sqlTime(now)],
    );
    const morning = now - 6 * HOUR_MS + 2 * 60_000;
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO agent_delivery (id, organization_id, member_id, responsibility, outcome, created_at) VALUES (?, ?, ?, 'morning_brief', 'sent', ?)",
      [hashId(memberId, "morning_brief:brief"), organizationId, memberId, sqlTime(morning)],
    );
    const checks: [string, number, string, string, string, string, string[], string | null][] = [
      ["morning", morning, "morning", "sent", "sent", "Sent you a message about morning brief.", ["morning_brief"], JSON.stringify({ channelId: "D0FIXTURE", messageTs: "1700000000.000100", permalink: "https://example.slack.com/archives/D0FIXTURE/p1700000000000100" })],
      ["late-morning", now - 2.5 * HOUR_MS, "scheduled", "quiet", "nothing_new", "Stayed quiet: nothing new.", [], null],
      ["yesterday", now - 25 * HOUR_MS, "scheduled", "failed", "google_disconnected", "Couldn't read Gmail: reconnect Google.", [], null],
      ["two-days", now - 47 * HOUR_MS, "calendar", "waited", "quiet_window", "Waited: only urgent messages 12 PM–2 PM. Held a message about calendar changes.", ["calendar_changes"], null],
    ];
    for (const [key, at, kind, outcome, reason, summary, responsibilities, message] of checks) {
      await queryDenDatabase(
        databaseUrl,
        "INSERT INTO agent_member_check (id, organization_id, member_id, checked_at, kind, outcome, reason, summary, responsibilities, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [hashId(memberId, key), organizationId, memberId, sqlTime(at), kind, outcome, reason, summary, JSON.stringify(responsibilities), message],
      );
    }

    const headers = (session: DenSession) => ({ authorization: `Bearer ${session.token}`, "x-openwork-org-id": organizationId, "content-type": "application/json" });

    const sayInChat = (name: string, body?: unknown) => chatAs(den.members.member, organizationId, name, body);

    // Seed settings and check history with the parent on, then prove its off/on UI and API boundary.
    const disabled = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
      method: "PUT",
      headers: headers(den.admin),
      body: JSON.stringify({ capabilities: { workbotProactive: false } }),
    });
    if (!disabled.response.ok) throw new Error(`Turning off Your agent failed: ${disabled.text.slice(0, 300)}`);

    const viewport = { width: 1280, height: 2000, deviceScaleFactor: 1 };
    const web = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard/library", headless: true, viewport });
    return {
      den,
      web,
      google,
      timeZone,
      sayInChat,
      /** The platform admin turns My agent on for this organization, as /admin does. */
      async turnOnMyAgent() {
        const result = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
          method: "PUT",
          headers: headers(den.admin),
          body: JSON.stringify({ capabilities: { workbotProactive: true } }),
        });
        if (!result.response.ok) throw new Error(`Turning on My agent failed: ${result.text.slice(0, 300)}`);
      },
      async [Symbol.asyncDispose]() {
        await stack.disposeAsync();
      },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
