import { allocateFreePorts } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { isRecord } from "./library.ts";
import { engineBinary } from "./openwork-server-cli.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

const AUTOMATION_NAME = "Weekly pipeline report";

type DenSession = Parameters<Seed["api"]>[0];

/**
 * Olive owns a Desktop Automation and is on the Sales team with Tess; Una is
 * in the organization but not on the team. Olive and Tess each have the app
 * open in a browser; Tess and Una also have Den's My Automations open.
 */
export async function automationTeamSharingWorld(seed: Seed) {
  const [olivePort, tessPort] = await allocateFreePorts(2);
  if (!olivePort || !tessPort) throw new Error("No ports available for the two apps in a browser.");
  const den = await seed.den({
    env: { DEN_AUTOMATIONS_ENABLED: "true", DEN_AUTOMATIONS_RUNTIME_ENABLED: "true" },
    org: {
      name: `Team sharing ${Date.now()}`,
      admin: { name: "Olive Owner" },
      members: { tess: { name: "Tess Teammate" }, una: { name: "Una Outsider" } },
    },
    trustedOrigins: [`http://127.0.0.1:${olivePort}`, `http://127.0.0.1:${tessPort}`],
  });
  const olive = den.admin;
  const tess = den.members.tess;
  const una = den.members.una;
  if (!tess || !una) throw new Error("The teammates were not seeded.");
  await enableOrganizationCapabilities(seed, olive, { automationTeamSharing: true });

  const memberId = async (session: DenSession) => {
    const org = await seed.api(session, "/v1/org");
    const member = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
    if (!org.response.ok || typeof member?.id !== "string") throw new Error(`Reading a membership failed: ${org.text.slice(0, 300)}`);
    return member.id;
  };
  const tessMemberId = await memberId(tess);
  const team = await seed.api(olive, "/v1/teams", {
    method: "POST",
    body: JSON.stringify({ name: "Sales", memberIds: [await memberId(olive), tessMemberId] }),
  });
  if (team.response.status !== 201) throw new Error(`Creating Sales failed: HTTP ${team.response.status} ${team.text.slice(0, 300)}`);

  // A model only Olive's desktop has; Den checks it when a desktop claims a run, and none does here.
  const created = await seed.api(olive, "/v1/automations", {
    method: "POST",
    body: JSON.stringify({
      name: AUTOMATION_NAME,
      instructions: "Summarize this week's sales pipeline and list the deals that moved.",
      schedule: { kind: "weekly", timezone: "UTC", daysOfWeek: [1], hour: 9, minute: 0 },
      model: { providerId: "openai", modelId: "gpt-test" },
    }),
  });
  const automation = isRecord(created.body) && isRecord(created.body.automation) ? created.body.automation : null;
  const automationId = automation && typeof automation.id === "string" ? automation.id : "";
  if (created.response.status !== 201 || !automationId) {
    throw new Error(`Creating the Automation failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
  }

  const binary = engineBinary();
  if (!binary) throw new Error("Prepare the shipped OpenCode sidecar before running this world.");
  const openApp = async (webPort: number, session: DenSession, label: string) => {
    const workspacePath = seed.tmpPath(`team-sharing-${label}`);
    const app = await seed.appWeb({ webPort, workspacePath, engine: "v2", headless: true, mouse: true, env: {
      OPENWORK_OPENCODE_BIN: binary,
      OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
      OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
      VITE_DEN_BASE_URL: den.ref.webUrl, VITE_DEN_API_BASE_URL: "/api/den",
    } });
    await seed.signIn(app, session, label);
    await seed.workspace(app, workspacePath);
    return app;
  };
  const oliveApp = await openApp(olivePort, olive, "olive");
  const tessApp = await openApp(tessPort, tess, "tess");
  const tessWeb = await seed.web({ den, signedInAs: tess, startPath: "/dashboard/automations", headless: true });
  const unaWeb = await seed.web({ den, signedInAs: una, startPath: "/dashboard/automations", headless: true });

  const read = async (session: DenSession, path: string, method = "GET") => {
    const result = await seed.api(session, path, { method, ...(method === "GET" ? {} : { body: "{}" }) });
    return { status: result.response.status, body: result.body };
  };
  return {
    oliveApp, tessApp, tessWeb, unaWeb, automationId, tessMemberId, name: AUTOMATION_NAME,
    /** The Automation as its current owner's Den record. */
    async record() {
      for (const session of [olive, tess]) {
        const result = await read(session, `/v1/automations/${automationId}`);
        const body = isRecord(result.body) ? result.body : {};
        const item = isRecord(body.automation) ? body.automation : null;
        const access = isRecord(body.access) ? body.access : null;
        if (result.status === 200 && item && access?.role === "owner") {
          return { ownerMemberId: String(item.ownerMemberId), state: String(item.state) };
        }
      }
      throw new Error("Neither Olive nor Tess owns the Automation.");
    },
    /** What Den answers when this person asks for it, pauses it, or lists what teams shared with them. */
    async asTess(action: "read" | "pause") {
      return (await read(tess, `/v1/automations/${automationId}${action === "pause" ? "/deactivate" : ""}`, action === "pause" ? "POST" : "GET")).status;
    },
    /** What Den lists for this person under "shared with my teams": each item's role and owner. */
    async sharedWith(person: "olive" | "tess") {
      const shared = await read(person === "olive" ? olive : tess, "/v1/shared-automations");
      const items = isRecord(shared.body) && Array.isArray(shared.body.items) ? shared.body.items.filter(isRecord) : [];
      return items.map((item) => {
        const access = isRecord(item.access) ? item.access : {};
        const owner = isRecord(access.owner) ? access.owner : {};
        return `${String(access.role)} of ${String(owner.name)}'s`;
      });
    },
    async asUna() {
      const detail = await read(una, `/v1/automations/${automationId}`);
      const shared = await read(una, "/v1/shared-automations");
      const run = await read(una, `/v1/automations/${automationId}/run`, "POST");
      const items = isRecord(shared.body) && Array.isArray(shared.body.items) ? shared.body.items.length : -1;
      return { detail: detail.status, sharedCount: items, run: run.status };
    },
  };
}
