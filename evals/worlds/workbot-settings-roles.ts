import type { Seed } from "@openwork/env";
import { modelProbeFixture } from "../../ee/apps/headless-runner/scripts/model-probe-fixture.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Real Den roles, settings route and page; only the model provider is a localhost fixture. */
export async function workbotSettingsRoles(seed: Seed) {
  const runner = await modelProbeFixture();
  try {
    const den = await seed.den({
      org: { name: "Settings roles", admin: { name: "Workspace Owner" }, members: { viewer: { name: "Model Viewer" }, manager: { name: "Model Manager" }, member: { name: "Workspace Member" } } },
      env: { DEN_DEPLOYMENT: "self_hosted", DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32) },
    });
    const initial = await seed.api(den.admin, "/v1/org");
    if (!isRecord(initial.body) || !isRecord(initial.body.organization) || typeof initial.body.organization.id !== "string" || !Array.isArray(initial.body.members)) throw new Error("Missing role fixture organization");
    const organizationId = initial.body.organization.id;
    const members = initial.body.members.filter(isRecord);
    const scope = { "x-openwork-org-id": organizationId };
    const roles: { person: "viewer" | "manager"; key: "inference.view" | "inference.manage" }[] = [{ person: "viewer", key: "inference.view" }, { person: "manager", key: "inference.manage" }];
    for (const { person, key } of roles) {
      const memberId = members.find(member => isRecord(member.user) && member.user.email === den.members[person]?.email)?.id;
      if (typeof memberId !== "string") throw new Error("Missing role fixture member");
      const team = await seed.api(den.admin, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name: person, memberIds: [memberId] }) });
      if (!isRecord(team.body) || !isRecord(team.body.team) || typeof team.body.team.id !== "string") throw new Error("Could not create the role fixture team");
      const role = await seed.api(den.admin, "/v1/permissions/sets", { method: "POST", headers: scope, body: JSON.stringify({ teamId: team.body.team.id, permissions: [{ key, status: "allow" }] }) });
      if (role.response.status !== 201) throw new Error("Could not grant the role fixture permission");
    }
    const viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
    const startPath = "/dashboard/workbot-settings";
    const web = await seed.web({ den, signedInAs: den.members.manager, startPath, headless: true, viewport });
    const viewer = await seed.web({ den, signedInAs: den.members.viewer, startPath, headless: true, viewport });
    const member = await seed.web({ den, signedInAs: den.members.member, startPath, headless: true, viewport });
    return { web, viewer, member, settingsUrl: `${den.ref.webUrl}${startPath}`, completionCount: () => runner.calls().length, async [Symbol.asyncDispose]() { await runner.close(); } };
  } catch (error) { await runner.close(); throw error; }
}
