import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminFeatureOutcomesWorld } from "../worlds/admin-feature-outcomes.ts";

const test = spec.world(adminFeatureOutcomesWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a platform admin sees, per feature across organizations, whether background features are used and working", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin);
  const adminProbe = probe.on(world.admin);
  const member = user.on(world.member);
  const memberProbe = probe.on(world.member);

  await step("before: an organization member is not on the admin allowlist and sees no feature data", async () => {
    await member.see({ text: "This account is not on the OpenWork admin allowlist" }, { timeoutMs: 60_000 });
    const rows = await memberProbe.dom('[data-testid^="admin-feature-usage-toggle-"]');
    const status = await world.memberRead();
    const ok = rows.elements.length === 0 && status === 403;
    evidence.recordAssertionEvidence("Members cannot read feature outcomes", `feature rows=${rows.elements.length}; GET /v1/admin/feature-usage → ${status}`, ok);
    expect(ok).toBe(true);
    await member.screenshot();
  });

  await step("the admin opens Features: surviving features show adoption while retired outcome rows stay absent", async () => {
    await admin.see({ role: "heading", label: "Features" }, { timeoutMs: 60_000 });
    // Retired background features are no longer rollout rows, even with stored outcomes.
    await admin.notSee({ testId: "admin-feature-usage-toggle-workbotProactive" });
    // Historical usage is preserved in the store, but cannot resurrect a retired rollout.
    await admin.notSee({ testId: "admin-feature-usage-toggle-slackSendAsBot" });
    await admin.notSee({ testId: "admin-feature-usage-toggle-settledSessions" });
    await admin.notSee({ testId: "admin-feature-usage-toggle-computerUse" });
    const health = async (key: string) => (await adminProbe.dom(`[data-testid="admin-feature-usage-health-${key}"]`)).elements[0]?.text ?? "";
    const labels = {
      adoptionOnly: await health("workbotDocuments"),
      unused: await health("remoteComputers"),
    };
    const ok = labels.adoptionOnly === "In use" && labels.unused === "Not used";
    evidence.recordAssertionEvidence("Health reads in plain words", JSON.stringify(labels), ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("an organization row opens that organization's Features tab", async () => {
    await admin.click({ testId: `admin-feature-usage-organization-${world.acmeId}` });
    await admin.see({ role: "heading", label: "Acme Robotics" }, { timeoutMs: 30_000 });
    const route = await adminProbe.url();
    const ok = route.endsWith(`/admin/organizations/${world.acmeId}/features`);
    evidence.recordAssertionEvidence("Each organization links to its own Features tab", `route=${route}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });
});
