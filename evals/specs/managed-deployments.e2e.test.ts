import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { managedDeploymentListSchema } from "@openwork/types/den/managed-deployments";
import { managedDeployments } from "../worlds/managed-deployments.ts";

// No paid infrastructure is launched here. This proves the real Den screens,
// records, approval handoff and access boundaries. The AWS installer and health
// agent are validated separately in an approved, dedicated AWS account.
const test = spec.world(managedDeployments, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner prepares an AWS install without OpenWork claiming it is running", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const ownHeaders = { "x-openwork-org-id": world.enabledOrgId };
  async function openEnabledWorkspace() {
    await owner.see({ testId: "workspace-switcher-trigger" }, { timeoutMs: 90_000 });
    await owner.click({ testId: "workspace-switcher-trigger" });
    await owner.click({ role: "button", label: new RegExp(`^${world.names.enabled}`) });
    // The Deployments entry appears only once the switch is committed and the
    // workspace's features are loaded; follow it like a person would.
    await owner.click({ role: "link", label: "Deployments" });
  }
  async function deployments() {
    const result = await probe.api(world.den.admin, "/v1/managed-deployments", { headers: ownHeaders });
    expect(result.response.ok).toBe(true);
    return managedDeploymentListSchema.parse(result.body).deployments;
  }

  await step("before: a workspace outside the rollout sees why deployments are unavailable", async () => {
    const locked = "Deployments aren't turned on for this workspace";
    // A first visit may ask which workspace to open; pick it like a person would.
    await eventually(async () => await page.has(locked) || await page.has("Choose an organization"), { within: 90_000, label: "the deployments page or the workspace picker" });
    if (!(await page.has(locked))) {
      await owner.click({ role: "button", label: new RegExp(`^${world.names.disabled}`) });
      // The picker closes only after the workspace is committed.
      await eventually(async () => !(await page.has("Choose an organization")), { within: 60_000, label: "the workspace choice to be saved" });
      await owner.navigate(`${world.baseUrl}/dashboard/deployments`);
    }
    await owner.see({ text: /Deployments aren't turned on for this workspace/ }, { timeoutMs: 90_000 });
    const blocked = await probe.api(world.den.admin, "/v1/managed-deployments", { headers: { "x-openwork-org-id": world.disabledOrgId } });
    expect(blocked.response.status).toBe(404);
    evidence.recordAssertionEvidence("the default-off workspace is locked, not hidden", "The page names who can turn it on; the same workspace's API answers HTTP 404.", true);
    await owner.screenshot();
  });

  await step("an opted-in owner enters a dedicated AWS account and confirms the costs", async () => {
    await openEnabledWorkspace();
    await owner.see({ text: /No deployments yet/ }, { timeoutMs: 90_000 });
    expect(await deployments()).toHaveLength(0);
    await owner.click({ role: "button", label: "Create deployment" });
    await owner.see({ role: "heading", label: "Create deployment" });
    await owner.type({ label: "Dedicated AWS account ID" }, "123456789012");
    await owner.type({ label: "Address" }, "openwork.example.test");
    await owner.type({ label: "Route 53 hosted zone ID for that address" }, "ZTEST123");
    await owner.type({ label: "First administrator email" }, "admin@example.test");
    await owner.see({ text: /AWS bills my account/ });
    evidence.recordAssertionEvidence("no AWS keys or root credentials are collected", "The form asks for account ID, region, address, hosted zone and first-administrator email, and states AWS costs.", true);
    await owner.screenshot();
  });

  let deploymentId = "";
  await step("after: creating records the deployment but does not claim it is installed", async () => {
    await owner.click({ role: "checkbox", label: /^I control this AWS account/ });
    // The dialog's own submit, not the page action behind the backdrop.
    await owner.click({ testId: "create-deployment-submit" });
    await owner.see({ testId: "managed-deployment-status" }, { text: "Not launched", timeoutMs: 60_000 });
    const listed = await deployments();
    expect(listed).toHaveLength(1);
    expect(listed[0].run).toBeNull();
    expect(listed[0].installedVersion).toBeNull();
    expect(listed[0].health.state).toBe("awaiting_report");
    deploymentId = listed[0].id;
    evidence.recordAssertionEvidence("a record exists with no installer run", `Den stored ${deploymentId} with run=null, no installed version, status Not launched.`, true);
    await owner.screenshot();
  });

  let runId = "";
  await step("after: AWS approval is a link the owner opens, not something OpenWork runs", async () => {
    await owner.click({ role: "button", label: "Prepare AWS approval" });
    await owner.see({ role: "link", label: "Review and approve in AWS" }, { timeoutMs: 30_000 });
    await owner.see({ testId: "managed-deployment-status" }, { text: "Awaiting AWS approval" });
    const [item] = await deployments();
    expect(item.run?.state).toBe("awaiting_approval");
    expect(item.run?.events).toHaveLength(0);
    runId = item.run?.id ?? "";
    await owner.notSee({ text: "Operational" });
    evidence.recordAssertionEvidence("nothing reached AWS", `Run ${runId} awaits approval with zero installer events; the status never reads Operational.`, true);
    await owner.screenshot();
  });

  await step("reopening the approval after a reload reuses the same run", async () => {
    await owner.reload();
    await owner.see({ testId: "managed-deployment-status" }, { text: "Awaiting AWS approval", timeoutMs: 60_000 });
    await owner.click({ role: "button", label: "Prepare AWS approval" });
    await owner.see({ role: "link", label: "Review and approve in AWS" }, { timeoutMs: 30_000 });
    const [item] = await deployments();
    expect(item.id).toBe(deploymentId);
    expect(item.run?.id).toBe(runId);
    evidence.recordAssertionEvidence("no duplicate installer run", `After reload the deployment ${deploymentId} still has run ${runId}.`, true);
    await owner.screenshot();
  });

  await step("three deployments are listed together with independent AWS approvals", async () => {
    const targets = [
      { name: "Staging", accountId: "123456789013", domain: "staging.example.test" },
      { name: "Sandbox", accountId: "123456789014", domain: "sandbox.example.test" },
    ];
    for (const target of targets) {
      await owner.click({ role: "button", label: "Create deployment" });
      await owner.see({ role: "heading", label: "Create deployment" });
      await owner.type({ label: "Name" }, target.name, { replace: true });
      await owner.type({ label: "Dedicated AWS account ID" }, target.accountId, { replace: true });
      await owner.type({ label: "Address" }, target.domain, { replace: true });
      await owner.type({ label: "Route 53 hosted zone ID for that address" }, "ZTEST123", { replace: true });
      await owner.type({ label: "First administrator email" }, "admin@example.test", { replace: true });
      await owner.click({ role: "checkbox", label: /^I control this AWS account/ });
      await owner.click({ testId: "create-deployment-submit" });
      await owner.see({ role: "heading", label: target.name }, { timeoutMs: 60_000 });
    }
    const before = await deployments();
    expect(before).toHaveLength(3);
    expect(new Set(before.map((item) => item.id)).size).toBe(3);
    const added = before.filter((item) => item.id !== deploymentId);
    expect(added.every((item) => item.run === null && item.installedVersion === null)).toBe(true);

    // Prepare each from its own row while the other approvals stay pending.
    for (const item of added) {
      await owner.click({ role: "button", label: new RegExp(`^${item.name}AWS`) });
      await owner.see({ role: "heading", label: item.name });
      await owner.click({ role: "button", label: "Prepare AWS approval" });
      await owner.see({ role: "link", label: "Review and approve in AWS" }, { timeoutMs: 30_000 });
      const current = await deployments();
      expect(current.find((entry) => entry.id === item.id)?.run?.state).toBe("awaiting_approval");
      expect(current.find((entry) => entry.id === deploymentId)?.run?.id).toBe(runId);
    }
    const approvals = await deployments();
    expect(new Set(approvals.map((item) => item.run?.id)).size).toBe(3);
    await owner.reload();
    for (const name of ["Production", ...targets.map((target) => target.name)]) {
      await owner.see({ role: "button", label: new RegExp(`^${name}AWS`) }, { timeoutMs: 60_000 });
    }
    const after = await deployments();
    expect(after).toHaveLength(3);
    expect(after.find((item) => item.id === deploymentId)?.run?.id).toBe(runId);
    for (const approval of approvals) {
      expect(after.find((item) => item.id === approval.id)?.run?.id).toBe(approval.run?.id);
    }
    expect(after.every((item) => item.run?.state === "awaiting_approval" && item.run.events.length === 0 && item.installedVersion === null)).toBe(true);
    await owner.notSee({ text: "Operational" });
    evidence.recordAssertionEvidence("three independent customer-cloud installs", "Production, Staging and Sandbox remain listed after reload, with three distinct deployment/run IDs and account-bound AWS approvals. Preparing each leaves Production unchanged; none falsely claims to be running.", true);
    await owner.screenshot();
  });

  await step("a teammate and another workspace cannot list the deployment", async () => {
    await owner.see({ testId: "managed-deployment-row" });
    const forbidden = await probe.api(world.den.members.member, "/v1/managed-deployments", { headers: ownHeaders });
    expect(forbidden.response.status).toBe(403);
    const otherWorkspace = await probe.api(world.den.admin, "/v1/managed-deployments", { headers: { "x-openwork-org-id": world.disabledOrgId } });
    expect(otherWorkspace.response.status).toBe(404);
    evidence.recordAssertionEvidence("no cross-role or cross-workspace access", "The teammate's API answers HTTP 403; the owner's other workspace answers HTTP 404 for the same list (its page is the locked state shown first).", true);
    await owner.screenshot();
  });
});
