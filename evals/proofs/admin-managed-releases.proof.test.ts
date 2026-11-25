import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminManagedReleasesWorld } from "../worlds/admin-managed-releases.ts";

const test = spec.world(adminManagedReleasesWorld, {
  timeout: 600_000,
  needs: { commands: ["pnpm"] },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

test("a platform administrator verifies and pins an installer without changing an existing approval", async ({ world, user, probe, step, evidence }) => {
  const person = user.on(world.admin);
  const browser = probe.on(world.admin);

  await step("before: the administrator sees the environment default and its original pending approval", async () => {
    await person.see({ testId: "managed-current-version", text: "1.2.2" }, { timeoutMs: 90_000 });
    await person.see({ text: "Environment" });
    const pending = await world.pendingApproval();
    expect(pending.run.version).toBe("1.2.2");
    expect(pending.installedVersion).toBeNull();
    evidence.recordAssertionEvidence("The existing approval is version-pinned", "Current default 1.2.2; an uninstalled target has an awaiting-approval run for 1.2.2", pending.run.version === "1.2.2" && pending.installedVersion === null);
    await person.screenshot();
  });

  await step("the administrator explicitly configures single-administrator approval inside Admin", async () => {
    await person.click({ text: "Advanced" });
    await person.click({ role: "radio", text: "One administrator" });
    await person.click({ role: "button", label: "Save approval policy" });
    await person.see({ text: "Allow one platform administrator to verify and pin releases?" });
    await person.click({ role: "button", label: "Confirm one administrator" });
    await person.see({ text: /Saved approval policy/ });
    const report = await world.report();
    const changed = report.history.some(change => change.action === "approval_saved");
    expect(changed).toBe(true);
    evidence.recordAssertionEvidence("Approval policy is an explicit audited setting", "Second-administrator approval was changed through the Admin controls and confirmation; the policy change appears in history", changed);
    await person.click({ text: "Advanced" });
    await person.screenshot();
  });

  await step("after: an inaccessible release explains the publishing problem without changing the default", async () => {
    await person.type({ label: "Choose version" }, "1.2.5", { replace: true });
    await person.click({ role: "button", label: "Verify release" });
    await person.see({ text: /403/ }, { timeoutMs: 30_000 });
    await person.see({ text: /publish|public/i });
    await person.notSee({ text: "The request failed with status 502." });
    await person.notSee({ text: "Private storage diagnostic" });
    const current = await world.readiness();
    const reads = await world.artifactReads();
    const requested = reads.some(line => line.includes("1.2.5/manifest.json"));
    expect(current?.version).toBe("1.2.2");
    expect(requested).toBe(true);
    evidence.recordAssertionEvidence("Unavailable objects have an actionable explanation", "The object store returned 403; the administrator sees publishing/public-access guidance, not a generic 502 or provider body; the default remains 1.2.2", requested && current?.version === "1.2.2");
    await person.screenshot();
  });

  await step("a corrupt published bundle is refused without changing the offered version", async () => {
    await person.type({ label: "Choose version" }, "1.2.4", { replace: true });
    await person.click({ role: "button", label: "Verify release" });
    await person.see({ text: /Verification failed/ }, { timeoutMs: 30_000 });
    const current = await world.readiness();
    const reads = await world.artifactReads();
    expect(current?.version).toBe("1.2.2");
    expect(reads.some(line => line.includes("1.2.4/bundle.tar.gz"))).toBe(true);
    evidence.recordAssertionEvidence("A real checksum mismatch reaches the verifier", "The published-object fixture served the corrupt candidate; validation failed and the offered version stayed 1.2.2", current?.version === "1.2.2" && reads.some(line => line.includes("1.2.4/bundle.tar.gz")));
    await person.screenshot();
  });

  await step("the latest stable candidate verifies all five services but cannot yet be pinned", async () => {
    await person.click({ role: "button", label: "Use latest stable" });
    await person.see({ label: "Choose version" }, { value: "1.2.3" });
    await person.click({ role: "button", label: "Verify release" });
    await person.see({ text: "Verified release 1.2.3" }, { timeoutMs: 30_000 });
    const page = await browser.text();
    for (const service of ["Den API", "Den web", "Managed runner", "Workbot", "Model gateway"]) expect(page).toContain(service);
    const disabled = await browser.dom("button[disabled]");
    expect(disabled.elements.some(element => element.text === "Pin 1.2.3")).toBe(true);
    const reads = await world.artifactReads();
    expect(reads.some(line => line.includes("1.2.3/manifest.json"))).toBe(true);
    evidence.recordAssertionEvidence("Verification is not mistaken for cloud qualification", "All five service pins verified from published-object fixtures; Pin 1.2.3 is disabled until both qualification reports are supplied", disabled.elements.some(element => element.text === "Pin 1.2.3"));
    await person.screenshot();
  });

  await step("after: the administrator records qualification and the new default survives a reload", async () => {
    await person.type({ label: "Successful fresh install report" }, "https://example.test/reports/fresh-install", { replace: true });
    await person.type({ label: "Approved update report" }, "https://example.test/reports/approved-update", { replace: true });
    await person.click({ role: "button", label: "Pin 1.2.3" });
    await person.see({ testId: "managed-current-version", text: "1.2.3" }, { timeoutMs: 30_000 });
    await person.reload();
    await person.see({ testId: "managed-current-version", text: "1.2.3" }, { timeoutMs: 30_000 });
    const current = await world.readiness();
    const report = await world.report();
    const pin = report.history.find(change => change.action === "pinned" && change.version === "1.2.3");
    expect(current?.version).toBe("1.2.3");
    expect(pin?.qualification?.freshInstallUrl).toBe("https://example.test/reports/fresh-install");
    expect(pin?.qualification?.approvedUpdateUrl).toBe("https://example.test/reports/approved-update");
    evidence.recordAssertionEvidence("The pin is persistent and attributed", "Admin default and organization readiness both report 1.2.3 after reload; history retains the actor, exact manifest hash and both reports", current?.version === "1.2.3" && Boolean(pin?.manifestSha256 && pin.actor && pin.qualification));
    await person.screenshot();
  });

  await step("the earlier approval remains unchanged while the newer version becomes available", async () => {
    await person.see({ text: "Pinned 1.2.3" });
    const pending = await world.pendingApproval();
    expect(pending.availableVersion).toBe("1.2.3");
    expect(pending.run.version).toBe("1.2.2");
    expect(pending.run.id).toBe(pending.originalRunId);
    expect(pending.installedVersion).toBeNull();
    evidence.recordAssertionEvidence("No installation or approval is silently upgraded", "Available version 1.2.3; original run ID and approved version 1.2.2 unchanged; target still uninstalled", pending.availableVersion === "1.2.3" && pending.run.version === "1.2.2" && pending.run.id === pending.originalRunId && pending.installedVersion === null);
  });

  await step("an ordinary member cannot see or change the platform release configuration", async () => {
    const member = user.on(world.member);
    await member.see({ text: /administrator|restricted|not authorized|access/i }, { timeoutMs: 90_000 });
    await member.notSee({ role: "button", label: "Verify release" });
    const access = await world.memberAccess();
    expect(access).toEqual({ read: 403, write: 403 });
    evidence.recordAssertionEvidence("Organization membership grants no platform release access", "Member UI is blocked; release read and pin-setting mutation both return 403", access.read === 403 && access.write === 403);
    await member.screenshot();
  });
});
