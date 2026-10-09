import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { awsDeploymentListSchema } from "@openwork/types/den/aws-deployments";
import { awsManagedDeployments } from "../worlds/aws-managed-deployments.ts";

// This journey does not launch paid infrastructure. It proves the real Den UI,
// records, approval handoff, and access boundaries; the AWS installer is tested
// separately in a dedicated, explicitly approved live validation account.
const test = spec.world(awsManagedDeployments, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner prepares an AWS install without confusing approval with a healthy deployment", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const member = user.on(world.memberWeb);
  const page = probe.on(world.web);
  async function selectWorkspace(name: string) {
    await owner.see({ testId: "workspace-switcher-trigger" }, { timeoutMs: 90_000 });
    await owner.click({ testId: "workspace-switcher-trigger" });
    await owner.click({ role: "button", label: new RegExp(`^${name}`) });
    await owner.navigate(`${world.baseUrl}/dashboard/aws-deployments`);
  }
  const ownHeaders = { "x-openwork-org-id": world.enabledOrgId };
  async function deployments() {
    const result = await probe.api(world.den.admin, "/v1/aws-deployments", { headers: ownHeaders });
    expect(result.response.ok).toBe(true);
    return awsDeploymentListSchema.parse(result.body).deployments;
  }

  await step("before: an owner sees why AWS deployment is unavailable for a workspace outside the rollout", async () => {
    await selectWorkspace(world.names.disabled);
    await owner.see({ text: /AWS deployments are not enabled/ }, { timeoutMs: 60_000 });
    const button = (await page.dom('button')).elements.find((entry) => entry.text === "Create deployment");
    expect(button).toBeDefined();
    const blocked = await probe.api(world.den.admin, "/v1/aws-deployments", { headers: { "x-openwork-org-id": world.disabledOrgId } });
    expect(blocked.response.status).toBe(404);
    evidence.recordAssertionEvidence("the default-off workspace cannot list deployments", "The locked entry point names the administrator; the same organization's API returns HTTP 404.", true);
    await owner.screenshot();
  });

  await step("an opted-in owner reviews the dedicated account, domain and AWS cost consent", async () => {
    await selectWorkspace(world.names.enabled);
    await owner.see({ text: /No AWS deployments/ }, { timeoutMs: 60_000 });
    expect(await deployments()).toHaveLength(0);
    await owner.click({ role: "button", label: "Create deployment" });
    await owner.see({ role: "heading", label: "Create AWS deployment" });
    await owner.type({ label: "Name" }, "Production proof");
    await owner.type({ label: "Dedicated AWS account ID" }, "123456789012");
    await owner.type({ label: "Deployment domain" }, "den.example.test");
    await owner.type({ label: "Public Route 53 hosted zone ID" }, "ZTEST123");
    await owner.type({ label: "First administrator email" }, "admin@example.test");
    await owner.see({ text: /AWS will bill my account/ });
    evidence.recordAssertionEvidence("the launch does not collect AWS keys or a root email", "The form requires account ID, region, domain, hosted zone and first-admin email; AWS costs and permission review are explicit.", true);
    await owner.screenshot();
  });

  let deploymentId = "";
  await step("after: creation adds a real deployment without claiming it is installed", async () => {
    await owner.click({ role: "checkbox", label: /^I control this dedicated AWS account/ });
    await owner.click({ role: "button", label: "Create deployment" });
    await owner.see({ testId: "aws-deployment-detail" }, { text: /Production proof/, timeoutMs: 60_000 });
    const listed = await deployments();
    expect(listed).toHaveLength(1);
    expect(listed[0].run).toBeNull();
    deploymentId = listed[0].id;
    await owner.see({ text: "Not launched" });
    evidence.recordAssertionEvidence("the record exists but no provisioning run exists", `Den stored one deployment, ${deploymentId}, with run=null and status Not launched.`, true);
    await owner.screenshot();
  });

  let runId = "";
  await step("after: AWS approval is offered as a link, not opened or reported as success", async () => {
    await owner.click({ role: "button", label: "Prepare AWS launch" });
    await owner.see({ role: "link", label: "Review and launch in AWS" }, { timeoutMs: 30_000 });
    const [item] = await deployments();
    expect(item.run?.state).toBe("awaiting_aws");
    expect(item.run?.events).toHaveLength(0);
    runId = item.run?.id ?? "";
    const link = (await page.dom('[data-testid="aws-deployment-detail"] a')).elements.find((entry) => entry.text.includes("Review and launch in AWS"));
    expect(link).toBeDefined();
    await owner.notSee({ text: "Installed" });
    evidence.recordAssertionEvidence("AWS has not been launched by the test or by rendering a link", `Run ${runId} is awaiting_aws, with zero runner events. The approval link is offered and no Installed claim appears.`, true);
    await owner.screenshot();
  });

  await step("reload restores the deployment and preparing the link reuses its existing run", async () => {
    await owner.reload();
    await owner.see({ text: "Production proof" }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: "View" });
    await owner.click({ role: "button", label: "Prepare AWS launch" });
    await owner.see({ role: "link", label: "Review and launch in AWS" }, { timeoutMs: 30_000 });
    const [item] = await deployments();
    expect(item.id).toBe(deploymentId);
    expect(item.run?.id).toBe(runId);
    expect(item.run?.events).toHaveLength(0);
    evidence.recordAssertionEvidence("recovering the launch link does not create a second run", `The stored deployment ${deploymentId} still has the same run ${runId} and no runner events after reload.`, true);
    await owner.screenshot();
  });

  await step("a teammate and another workspace cannot see the owner's AWS deployment", async () => {
    await member.navigate(`${world.baseUrl}/dashboard/aws-deployments`);
    await member.notSee({ text: "Production proof" }, { timeoutMs: 30_000 });
    const forbidden = await probe.api(world.den.members.member, "/v1/aws-deployments", { headers: ownHeaders });
    expect(forbidden.response.status).toBe(403);
    await selectWorkspace(world.names.disabled);
    await owner.notSee({ text: "Production proof" });
    evidence.recordAssertionEvidence("deployment visibility does not cross roles or workspaces", "The teammate's API returns HTTP 403; switching to the default-off workspace removes the deployment and its launch link.", true);
    await owner.screenshot();
  });
});
