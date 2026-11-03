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

  await step("the admin opens Features: each background feature shows organizations on, members using, runs, its days and one health label", async () => {
    await admin.see({ role: "heading", label: "Features" }, { timeoutMs: 60_000 });
    // The schedule-trigger outcome features are retired (GA): no rows. Your agent is the remaining outcome feature.
    await admin.see({ testId: "admin-feature-usage-toggle-workbotProactive" });
    // Historical usage is preserved in the store, but cannot resurrect a retired rollout.
    await admin.notSee({ testId: "admin-feature-usage-toggle-slackSendAsBot" });
    const health = async (key: string) => (await adminProbe.dom(`[data-testid="admin-feature-usage-health-${key}"]`)).elements[0]?.text ?? "";
    const labels = {
      agent: await health("workbotProactive"),
      adoptionOnly: await health("settledSessions"),
      unused: await health("computerUse"),
    };
    const bars = await adminProbe.dom('[data-testid="admin-feature-usage-bars"]');
    const failed = await adminProbe.dom('[data-testid="admin-feature-usage-bars"] [data-failed="true"]');
    const ok = labels.agent === "Healthy" && labels.adoptionOnly === "In use" && labels.unused === "Not used" && bars.elements.length >= 1 && failed.elements.length >= 1;
    evidence.recordAssertionEvidence("Health reads in plain words", `${JSON.stringify(labels)}; day bars=${bars.elements.length}; failed days marked=${failed.elements.length}`, ok);
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
