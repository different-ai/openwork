import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { freeAutoAllOrganizations } from "../worlds/free-auto-all-organizations.ts";

const test = spec.world(freeAutoAllOrganizations, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

function access(body: unknown): Record<string, unknown> {
  const value = body && typeof body === "object" && "access" in body ? body.access : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected access status");
  return Object.fromEntries(Object.entries(value));
}

test("every organization's members get free Auto without a platform admin turning it on", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const member = user.on(world.memberWeb);
  const openOrganization = async (name: string) => {
    await admin.click({ role: "button", label: /Organizations \(/ });
    await admin.type({ placeholder: "Org name, slug, or id" }, name);
    await admin.see({ text: /Search across all 2 organizations · page 1-1 of 1/ }, { timeoutMs: 60_000 });
    // Witness: the organization's settings are on screen, so a missing switch is not just an unopened row.
    await admin.see({ testId: "admin-openwork-web-access" }, { timeoutMs: 60_000 });
  };

  await step("the platform admin opens an organization and finds no free Auto switch to turn on", async () => {
    await openOrganization("Auto Studio");
    await admin.notSee({ testId: "admin-free-auto" });
    const current = access((await probe.api(world.teammate, "/v1/inference/access")).body);
    expect(current.kind).toBe("free");
    expect(current.remainingUsd).toBe(5);
    evidence.recordAssertionEvidence("the member already has the full free Auto allowance",
      `Auto Studio member access: ${current.kind}, $${current.remainingUsd} left; no rollout switch on the organization`, current.kind === "free" && current.remainingUsd === 5);
    await admin.screenshot();
  });

  await step("a second organization gets free Auto too", async () => {
    await admin.reload();
    await openOrganization("Second Studio");
    await admin.notSee({ testId: "admin-free-auto" });
    const other = access((await probe.api(world.den.admin, "/v1/inference/access")).body);
    expect(other.kind).toBe("free");
    evidence.recordAssertionEvidence("free Auto is not limited to one organization",
      `${world.secondName} access: ${other.kind}, $${other.remainingUsd} left; reason: ${other.reason}`, other.kind === "free");
    await admin.screenshot();
  });

  await step("an ordinary member still cannot open platform administration", async () => {
    await member.see({ role: "heading", label: "Admin access required" }, { timeoutMs: 60_000 });
    const denied = await probe.api(world.teammate, "/v1/admin/organizations");
    expect(denied.response.status).toBe(403);
    evidence.recordAssertionEvidence("member administration is refused", `admin organization list as member: HTTP ${denied.response.status}`, denied.response.status === 403);
    await member.screenshot();
  });
});
