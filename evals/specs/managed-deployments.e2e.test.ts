import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { managedDeploymentListSchema } from "@openwork/types/den/managed-deployments";
import { managedDeployments } from "../worlds/managed-deployments.ts";

// No paid infrastructure is launched here. This proves the real Den screens,
// records, approval handoff and access boundaries. The AWS installer and health
// agent are validated separately in an approved, dedicated AWS account.
const test = spec.world(managedDeployments, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner prepares an AWS install without OpenWork claiming it is running", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const ownHeaders = { "x-openwork-org-id": world.enabledOrgId };
  async function selectWorkspace(name: string) {
    await owner.see({ testId: "workspace-switcher-trigger" }, { timeoutMs: 90_000 });
    await owner.click({ testId: "workspace-switcher-trigger" });
    await owner.click({ role: "button", label: new RegExp(`^${name}`) });
    await owner.navigate(`${world.baseUrl}/dashboard/deployments`);
  }
  async function deployments() {
    const result = await probe.api(world.den.admin, "/v1/managed-deployments", { headers: ownHeaders });
    expect(result.response.ok).toBe(true);
    return managedDeploymentListSchema.parse(result.body).deployments;
  }

  await step("before: a workspace outside the rollout sees why deployments are unavailable", async () => {
    await owner.see({ text: /Deployments aren't turned on for this workspace/ }, { timeoutMs: 90_000 });
    const blocked = await probe.api(world.den.admin, "/v1/managed-deployments", { headers: { "x-openwork-org-id": world.disabledOrgId } });
    expect(blocked.response.status).toBe(404);
    evidence.recordAssertionEvidence("the default-off workspace is locked, not hidden", "The page names who can turn it on; the same workspace's API answers HTTP 404.", true);
    await owner.screenshot();
  });

  await step("an opted-in owner enters a dedicated AWS account and confirms the costs", async () => {
    await selectWorkspace(world.names.enabled);
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

  await step("a teammate and another workspace cannot see the deployment", async () => {
    const forbidden = await probe.api(world.den.members.member, "/v1/managed-deployments", { headers: ownHeaders });
    expect(forbidden.response.status).toBe(403);
    await selectWorkspace(world.names.disabled);
    await owner.see({ text: /Deployments aren't turned on for this workspace/ }, { timeoutMs: 60_000 });
    await owner.notSee({ testId: "managed-deployment-row" });
    const otherWorkspace = await probe.api(world.den.admin, "/v1/managed-deployments", { headers: { "x-openwork-org-id": world.disabledOrgId } });
    expect(otherWorkspace.response.status).toBe(404);
    evidence.recordAssertionEvidence("no cross-role or cross-workspace access", "The teammate's API answers HTTP 403; the owner's other workspace shows no deployment rows and its API answers 404.", true);
    await owner.screenshot();
  });
});
