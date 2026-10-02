import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { freeAutoRollout } from "../worlds/free-auto-rollout.ts";

const test = spec.world(freeAutoRollout, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

function access(body: unknown): Record<string, unknown> {
  const value = body && typeof body === "object" && "access" in body ? body.access : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected access status");
  return Object.fromEntries(Object.entries(value));
}

test("a platform admin enables free Auto for one organization and can revoke it while another organization stays excluded", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const member = user.on(world.memberWeb);
  const toggle = { testId: `admin-free-auto-${world.slug}` };
  const status = () => probe.api(world.teammate, "/v1/inference/access");

  await step("before: free Auto is disabled for an organization that has not joined the pilot", async () => {
    await admin.click({ role: "button", label: /Organizations \(/ });
    await admin.type({ placeholder: "Org name, slug, or id" }, "Auto Pilot Studio");
    await admin.see({ text: /Search across all 2 organizations · page 1-1 of 1/ }, { timeoutMs: 60_000 });
    await admin.see(toggle, { timeoutMs: 60_000 });
    const before = access((await status()).body);
    expect(before.reason).toBe("free_disabled");
    evidence.recordAssertionEvidence("the unenrolled member has no free allowance", `access kind: ${before.kind}; reason: ${before.reason}`, before.reason === "free_disabled");
    await admin.screenshot();
  });

  await step("after: the platform admin enables free Auto for the pilot organization", async () => {
    await admin.click(toggle);
    await admin.see({ testId: "admin-free-auto-state" }, { text: "Enabled", timeoutMs: 30_000 });
    const current = access((await status()).body);
    const other = access((await probe.api(world.den.admin, "/v1/inference/access")).body);
    expect(current.kind).toBe("free");
    expect(current.remainingUsd).toBe(5);
    expect(other.reason).toBe("free_disabled");
    evidence.recordAssertionEvidence("only the enrolled organization gets Auto", `pilot: ${current.kind}, $${current.remainingUsd}; other organization: ${other.reason}`, current.kind === "free" && other.reason === "free_disabled");
    await admin.reload();
    await admin.click({ role: "button", label: /Organizations \(/ });
    await admin.type({ placeholder: "Org name, slug, or id" }, "Auto Pilot Studio");
    await admin.see({ testId: "admin-free-auto-state" }, { text: "Enabled", timeoutMs: 30_000 });
    await admin.screenshot();
  });

  await step("an ordinary member cannot change the organization's rollout", async () => {
    await member.see({ role: "heading", label: "Admin access required" }, { timeoutMs: 60_000 });
    await member.notSee(toggle);
    const denied = await probe.api(world.teammate, "/v1/admin/organizations");
    expect(denied.response.status).toBe(403);
    evidence.recordAssertionEvidence("member administration is refused", `admin organization list as member: HTTP ${denied.response.status}`, denied.response.status === 403);
    await member.screenshot();
  });

  await step("the platform admin disables free Auto again and the member loses access", async () => {
    await admin.click(toggle);
    await admin.see({ testId: "admin-free-auto-state" }, { text: "Disabled", timeoutMs: 30_000 });
    const revoked = access((await status()).body);
    expect(revoked.reason).toBe("free_disabled");
    evidence.recordAssertionEvidence("disabling enrollment revokes free access", `member access: ${revoked.kind}; reason: ${revoked.reason}`, revoked.reason === "free_disabled");
    await admin.screenshot();
  });
});
