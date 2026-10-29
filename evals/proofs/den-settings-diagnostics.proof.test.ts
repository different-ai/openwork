import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { orgDiagnosticsSchema } from "@openwork/types/den/diagnostics";
import { cloudSettingsDiagnostics, localSettingsDiagnostics } from "../worlds/den-settings-diagnostics.ts";

const local = spec.world(localSettingsDiagnostics, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });
const cloud = spec.world(cloudSettingsDiagnostics, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

local("one Settings › Diagnostics page shows desktop startups to org admins and installation services to installation admins", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner), ownerProbe = probe.on(world.owner);
  const operator = user.on(world.operator), operatorProbe = probe.on(world.operator);

  await step("an organization owner sees how desktop apps started and connected in the last 24 hours", async () => {
    await owner.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
    await owner.click({ role: "link", label: "Settings" });
    await owner.click({ role: "link", label: "Diagnostics" });
    await owner.see({ testId: "diagnostics-desktop-summary" }, { text: /4 startups/, timeoutMs: 60_000 });
    await owner.see({ testId: "diagnostics-desktop-failure-signed_in-certificate" });
    await owner.see({ testId: "diagnostics-attention" }, { text: /certificate not trusted/ });
    await owner.see({ testId: "diagnostics-installation-locked" });
    const response = await ownerProbe.api(world.den.members.owner, "/v1/org/diagnostics");
    const report = orgDiagnosticsSchema.parse(response.body);
    if (report.desktop.access !== "granted") throw new Error("The owner should see desktop startups");
    expect(report.desktop).toMatchObject({ startups: 4, connected: 3, failed: 1, people: 2, typicalMs: 2000 });
    expect(report.desktop.failures).toEqual([expect.objectContaining({ step: "signed_in", reason: "certificate", count: 1, people: 1 })]);
    expect(report.desktop.versions.map((entry) => entry.version).sort()).toEqual(["0.18.7", "0.19.2"]);
    expect(report.installation).toEqual({ access: "locked", reason: "installation_admin_required" });
    expect(report.attention).toContainEqual(expect.objectContaining({ code: "desktop_startup_failures", severity: "warning", detail: "certificate" }));
    evidence.recordAssertionEvidence(
      "Desktop launches reported through the real endpoint become startup health",
      `startups=${report.desktop.startups}; connected=${report.desktop.connected}; typical=${report.desktop.typicalMs}ms; slowest=${report.desktop.slowestMs}ms; failure=${report.desktop.failures.map((failure) => `${failure.step}/${failure.reason}`).join(",")}; installation=${report.installation.access}`,
      report.desktop.startups === 4 && report.desktop.failures.length === 1 && report.installation.access === "locked",
    );
    await owner.click({ testId: "diagnostics-desktop-summary" });
    await owner.see({ testId: "diagnostics-desktop-steps" }, { text: /Signed in to OpenWork/ });
    await owner.screenshot();
  });

  await step("a post-deploy smoke test reads the same report with an exit code: warnings pass, errors fail", async () => {
    const strict = await ownerProbe.api(world.den.members.owner, "/v1/org/diagnostics?strict=1");
    const report = orgDiagnosticsSchema.parse(strict.body);
    expect(strict.response.status).toBe(200);
    expect(report.attention.every((item) => item.severity === "warning")).toBe(true);
    evidence.recordAssertionEvidence("strict=1 fails only on error-severity attention", `status=${strict.response.status}; attention=${report.attention.map((item) => `${item.code}:${item.severity}`).join(",")}`, strict.response.status === 200);
  });

  await step("an installation admin with an ordinary member role finds Diagnostics in Settings and the command palette", async () => {
    await operator.see({ testId: "member-dashboard" }, { timeoutMs: 60_000 });
    await operator.click({ role: "link", label: "Settings" });
    await operator.click({ role: "link", label: "Diagnostics" });
    await operator.see({ testId: "diagnostics-installation" }, { timeoutMs: 60_000 });
    await operator.see({ testId: "installation-server" });
    await operator.see({ testId: "diagnostics-desktop-locked" });
    await operator.click({ testId: "den-command-palette-trigger" });
    await operator.type({ testId: "den-command-palette-input" }, "services");
    await operator.see({ text: "Settings › Diagnostics" });
    await operator.press("Escape");
    const rows = await operatorProbe.dom('[data-testid^="service-status-"]');
    expect(rows.elements).toHaveLength(5);
    const context = await operatorProbe.api(world.den.admin, "/v1/org");
    expect(context.body).toMatchObject({ canManageDeploymentServices: true, currentMember: { role: "member" } });
    evidence.recordAssertionEvidence("Installation authority is independent of organization role", `role=member; installation rows=${rows.elements.length}; desktop section locked`, rows.elements.length === 5);
    await operator.screenshot();
  });

  await step("after: Check now verifies the runner by authenticated health and times each check", async () => {
    await operatorProbe.eventually(() => operatorProbe.dom('[data-testid="diagnostics-check-now"]:not(:disabled)'), { within: 60_000, until: (value) => value.elements.length === 1, label: "Check now is available" });
    await operator.click({ testId: "diagnostics-check-now" });
    await operator.see({ testId: "service-state-database" }, { text: "Ready", timeoutMs: 60_000 });
    await operator.see({ testId: "service-state-headlessRunner" }, { text: "Ready", timeoutMs: 60_000 });
    await operator.see({ testId: "service-state-workbot" }, { text: "Not set up" });
    const response = await operatorProbe.api(world.den.admin, "/v1/org/diagnostics");
    const report = orgDiagnosticsSchema.parse(response.body);
    if (report.installation.access !== "operator") throw new Error("The installation admin should see installation services");
    const runner = report.installation.services.services.find((service) => service.id === "headlessRunner");
    expect(runner?.reason).toBe("health_verified");
    expect(typeof runner?.durationMs).toBe("number");
    expect(report.installation.server.version).toBeTruthy();
    expect(world.fixtureCalls()).toBeGreaterThan(0);
    expect(world.unexpectedFixtureCalls()).toBe(0);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("http://127.0.0.1");
    expect(serialized).not.toContain("readiness-fixture-service-token");
    evidence.recordAssertionEvidence(
      "Ready comes from authenticated health, with timing, and no endpoint or token values",
      `runner=${runner?.reason} in ${runner?.durationMs}ms; health calls=${world.fixtureCalls()}; non-health calls=${world.unexpectedFixtureCalls()}`,
      runner?.reason === "health_verified" && world.unexpectedFixtureCalls() === 0,
    );
    await operator.click({ testId: "service-details-toggle-headlessRunner" });
    await operator.see({ testId: "service-details-headlessRunner" }, { text: /Resumable answers/ });
    await operator.screenshot();
  });

  await step("old Settings › Services links land on Diagnostics", async () => {
    await operator.navigate(`${world.den.ref.webUrl}/dashboard/services`);
    await operator.see({ testId: "diagnostics-page" }, { timeoutMs: 60_000 });
    await operator.see({ testId: "diagnostics-installation" });
    await operator.screenshot();
  });

  await step("ordinary members get neither the page nor any section through the API", async () => {
    const member = user.on(world.member), memberProbe = probe.on(world.member);
    await member.see({ testId: "member-dashboard" }, { timeoutMs: 60_000 });
    await member.notSee({ role: "link", label: "Diagnostics" });
    await member.navigate(`${world.den.ref.webUrl}/dashboard/diagnostics`);
    await memberProbe.eventually(() => memberProbe.dom('[data-testid="admin-access-state"][data-access-state="locked"], [data-testid="member-dashboard"]'), { within: 60_000, until: (value) => value.elements.length > 0, label: "Member Diagnostics route is denied after access resolves" });
    await member.notSee({ testId: "diagnostics-check-now" });
    const response = await memberProbe.api(world.den.members.member, "/v1/org/diagnostics");
    const report = orgDiagnosticsSchema.parse(response.body);
    expect([report.desktop.access, report.providers.access, report.connectors.access, report.network.access]).toEqual(["locked", "locked", "locked", "locked"]);
    expect(report.installation.access).toBe("locked");
    expect(report.attention).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/missingSettings|DEN_HEADLESS_RUNNER_TOKEN/);
    evidence.recordAssertionEvidence("A plain member sees only locks", `sections=${[report.desktop.access, report.providers.access, report.connectors.access, report.installation.access, report.network.access].join(",")}`, report.desktop.access === "locked" && report.installation.access === "locked");
    await member.screenshot();
  });

  await step("the page fits a narrow screen without sideways scrolling", async () => {
    await owner.resizeViewport({ width: 320, height: 740, deviceScaleFactor: 1 });
    await owner.navigate(`${world.den.ref.webUrl}/dashboard/diagnostics`);
    await owner.see({ testId: "diagnostics-desktop-summary" }, { timeoutMs: 60_000 });
    const layout = await ownerProbe.dom("body");
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("Diagnostics fits 320px", `document=${layout.documentWidth}px; viewport=${layout.viewportWidth}px`, layout.documentWidth <= layout.viewportWidth);
    await owner.screenshot();
  });
});

cloud("on OpenWork Cloud the same page shows Installation as managed by OpenWork, even to internal operators", async ({ world, user, probe, step, evidence }) => {
  await step("a cloud owner sees desktop startups and a managed installation", async () => {
    const owner = user.on(world.owner), ownerProbe = probe.on(world.owner);
    await owner.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
    await owner.click({ role: "link", label: "Settings" });
    await owner.click({ role: "link", label: "Diagnostics" });
    await owner.see({ testId: "diagnostics-installation-managed" }, { text: /Managed by OpenWork/, timeoutMs: 60_000 });
    await owner.see({ testId: "diagnostics-desktop-summary" });
    const response = await ownerProbe.api(world.den.members.owner, "/v1/org/diagnostics");
    const report = orgDiagnosticsSchema.parse(response.body);
    expect(report.deployment).toBe("cloud");
    expect(report.installation).toEqual({ access: "managed" });
    evidence.recordAssertionEvidence("Cloud installation is managed", `deployment=${report.deployment}; installation=${report.installation.access}`, report.installation.access === "managed");
    await owner.screenshot();
  });
  await step("an internal platform operator gets no installation details in tenant Settings", async () => {
    const operatorProbe = probe.on(world.operator);
    const response = await operatorProbe.api(world.den.admin, "/v1/org/diagnostics");
    const report = orgDiagnosticsSchema.parse(response.body);
    const context = await operatorProbe.api(world.den.admin, "/v1/org");
    expect(report.installation).toEqual({ access: "managed" });
    expect(context.body).toMatchObject({ canManageDeploymentServices: false });
    expect(JSON.stringify(report)).not.toContain("missingSettings");
    evidence.recordAssertionEvidence("Platform admins don't get tenant-visible infrastructure details", `installation=${report.installation.access}; canManageDeploymentServices=false`, report.installation.access === "managed");
  });
  await step("the internal cloud operator retains the separate platform diagnostic surface", async () => {
    const operator = user.on(world.operator);
    await operator.navigate(`${world.den.ref.webUrl}/admin/services`);
    await operator.see({ testId: "admin-services-page" }, { timeoutMs: 60_000 });
    const response = await probe.on(world.operator).api(world.den.admin, "/v1/admin/services");
    expect(response.response.status).toBe(200);
    evidence.recordAssertionEvidence("Internal platform diagnostics remain independent", `platform inventory=${response.response.status}`, response.response.ok);
    await operator.screenshot();
  });
});
