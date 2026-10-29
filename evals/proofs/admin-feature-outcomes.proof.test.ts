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
    await admin.see({ testId: "admin-feature-usage-toggle-automationCalendarTriggers" });
    const health = async (key: string) => (await adminProbe.dom(`[data-testid="admin-feature-usage-health-${key}"]`)).elements[0]?.text ?? "";
    const labels = {
      calendar: await health("automationCalendarTriggers"),
      slack: await health("slackSendAsBot"),
      interval: await health("automationIntervalSchedules"),
      agent: await health("workbotProactive"),
      adoptionOnly: await health("mermaidZoom"),
      unused: await health("computerUse"),
    };
    const bars = await adminProbe.dom('[data-testid="admin-feature-usage-bars"]');
    const failed = await adminProbe.dom('[data-testid="admin-feature-usage-bars"] [data-failed="true"]');
    const ok = labels.calendar === "Most meetings skipped" && labels.slack === "1 hit the limit" && labels.interval === "Healthy"
      && labels.agent === "Healthy" && labels.adoptionOnly === "In use" && labels.unused === "Not used" && bars.elements.length >= 4 && failed.elements.length >= 2;
    evidence.recordAssertionEvidence("Health reads in plain words", `${JSON.stringify(labels)}; day bars=${bars.elements.length}; failed days marked=${failed.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: opening Before or after meetings shows totals, why meetings were skipped and each organization", async () => {
    await admin.click({ testId: "admin-feature-usage-toggle-automationCalendarTriggers" });
    await admin.see({ testId: "admin-feature-usage-reasons-automationCalendarTriggers" });
    const text = await adminProbe.text();
    const organizations = await adminProbe.dom('[data-testid^="admin-feature-usage-organization-"]');
    const names = organizations.elements.map((element) => element.text);
    const ok = text.includes("Turned off for the organization") && text.includes("Model no longer available") && text.includes("Run failed")
      && names.join(",") === "Acme Robotics,Northwind Labs" && !text.includes("execution_runtime_unavailable");
    evidence.recordAssertionEvidence("Skips and failures by reason, then by organization", `reasons: Turned off for the organization, Model no longer available, Run failed; organizations: ${names.join(", ")}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("Slack messages from the bot say the counts cover the last 24 hours and who hit the daily limit", async () => {
    await admin.click({ testId: "admin-feature-usage-toggle-slackSendAsBot" });
    await admin.see({ testId: "admin-feature-usage-detail-slackSendAsBot" });
    const coverage = (await adminProbe.dom('[data-testid="admin-feature-usage-detail-slackSendAsBot"] [data-testid="admin-feature-usage-coverage"]')).elements[0]?.text ?? "";
    const text = (await adminProbe.dom('[data-testid="admin-feature-usage-detail-slackSendAsBot"]')).elements[0]?.text ?? "";
    const ok = coverage === "Last 24 hours only" && text.includes("Hit the limit") && text.includes("Slack refused the message");
    evidence.recordAssertionEvidence("A store that keeps one day says so", `coverage="${coverage}"; reasons include "Slack refused the message"`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("30 days include the older meeting run and the earlier use", async () => {
    await admin.click({ testId: "admin-feature-usage-range-30d" });
    await admin.see({ text: "Last 30 days" });
    const runs = await adminProbe.eventually(async () => (await adminProbe.dom('[data-testid="admin-feature-usage-detail-automationCalendarTriggers"] dd')).elements[0]?.text ?? "", {
      within: 15_000, until: (value) => value === "15", label: "30-day meeting runs",
    });
    const ok = runs === "15";
    evidence.recordAssertionEvidence("The range widens the counts", `meeting runs: 14 in 7 days → ${runs} in 30 days`, ok);
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
