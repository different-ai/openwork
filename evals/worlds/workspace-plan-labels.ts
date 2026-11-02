import type { Seed } from "@openwork/env";
import { sandboxCreatedSchema } from "@openwork/types/den/sandbox-organizations";
import { createOrganization, setActiveOrganization, setPlan, type DenCall } from "./plan-shapes.ts";

/** Real plan and sandbox records, arranged through the same APIs as /admin. */
export async function workspacePlanLabelsWorld(seed: Seed) {
  const den = await seed.den({
    web: true,
    env: { DEN_DEPLOYMENT: "cloud", RESEND_API_KEY: "", SMTP_HOST: "" },
    org: {
      name: "Free workspace",
      admin: { name: "Workspace owner" },
      members: { avery: { name: "Avery Member" }, riley: { name: "Riley Member" } },
    },
  });
  const call: DenCall = async (path, init) => {
    const result = await seed.api(den.admin, path, init);
    return { status: result.response.status, ok: result.response.ok, body: result.body };
  };
  for (const tier of ["team", "enterprise"] as const) {
    const id = await createOrganization(call, tier === "team" ? "Team workspace" : "Enterprise workspace");
    await setPlan(call, id, { tier, seatLimit: 10 });
  }
  const created = await call("/v1/admin/sandbox-orgs", {
    method: "POST",
    body: JSON.stringify({ name: "Trial sandbox", connectorBaseUrl: null, days: 14, memberLimit: 3, allowedEmailDomains: [], joinRole: "member" }),
  });
  if (!created.ok) throw new Error(`Create sandbox: HTTP ${created.status}`);
  const { sandbox } = sandboxCreatedSchema.parse(created.body);
  const token = new URL(sandbox.joinLink).searchParams.get("token");
  const { avery, riley } = den.members;
  if (!avery || !riley || !token) throw new Error("Sandbox join fixtures are incomplete.");
  for (const person of [avery, riley]) {
    const joined = await seed.api(person, "/v1/sandbox-join", { method: "POST", body: JSON.stringify({ token }) });
    if (!joined.response.ok) throw new Error(`Join sandbox: HTTP ${joined.response.status}`);
    const selected = await seed.api(person, "/v1/me/active-organization", {
      method: "POST", body: JSON.stringify({ organizationId: sandbox.organizationId }),
    });
    if (!selected.response.ok) throw new Error(`Select sandbox: HTTP ${selected.response.status}`);
  }
  await setActiveOrganization(call, sandbox.organizationId);
  const viewport = { width: 1280, height: 900 };
  const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard", headless: true, viewport });
  const member = await seed.web({ den, signedInAs: avery, startPath: "/dashboard", headless: true, viewport });
  return { den, owner, member };
}
