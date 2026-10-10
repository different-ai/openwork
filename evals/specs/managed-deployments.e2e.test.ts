import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { managedDeploymentListSchema } from "@openwork/types/den/managed-deployments";
import { managedDeployments } from "../worlds/managed-deployments.ts";

// No paid infrastructure is launched here. This proves the real Den screens,
// records, approval handoff and access boundaries. The AWS installer and health
// agent are validated separately in an approved, dedicated AWS account.
const test = spec.world(managedDeployments, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner prepares AWS installs without claiming they are running and can cancel or confirm Remove", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const ownHeaders = { "x-openwork-org-id": world.enabledOrgId };
  const stagingName = "Staging release rehearsal and infrastructure validation";
  const targets = [
    { name: stagingName, accountId: "123456789013", domain: "staging.example.test" },
    // Sandbox uses an existing VPC and ECS cluster; these IDs are configuration.
    { name: "Sandbox", accountId: "123456789014", domain: "sandbox.example.test", existing: true },
  ];
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
    await owner.type({ label: "AWS account ID" }, "123456789012");
    await owner.type({ label: "Address" }, "openwork.example.test");
    await owner.type({ label: "Route 53 hosted zone ID for that address" }, "ZTEST123");
    await owner.type({ label: "First administrator email" }, "admin@example.test");
    await owner.see({ text: /AWS bills my account/ });
    await owner.see({ testId: "network-dedicated" });
    const [dialog] = (await page.dom('[data-testid="create-deployment-dialog"]')).elements;
    const options = (await page.dom('[data-testid="deployment-network-options"] > label')).elements;
    expect(options).toHaveLength(2);
    const outerRadius = Number.parseFloat(dialog.style.borderTopLeftRadius);
    const innerRadii = options.map((option) => Number.parseFloat(option.style.borderTopLeftRadius));
    expect(outerRadius).toBe(16);
    expect(innerRadii).toEqual([8, 8]);
    expect(innerRadii.every((radius) => radius < outerRadius)).toBe(true);
    evidence.recordAssertionEvidence("AWS configuration stays explicit and the network choices fit their dialog", `The form keeps account ID, region, address, hosted zone, first-administrator email and AWS costs; both network choices use ${innerRadii.join(" / ")}px corners inside the ${outerRadius}px dialog.`, true);
    await owner.screenshot();
  });

  await step("the complete AWS cost and approval consent is readable before creating the deployment", async () => {
    await owner.see({ testId: "deployment-cost-consent" });
    const [consentBox] = (await page.dom('[data-testid="deployment-cost-consent"]')).elements;
    const [dialog] = (await page.dom('[data-testid="create-deployment-dialog"]')).elements;
    const { consent } = await world.deploymentTextReadability();
    expect(consent?.textNodeCount).toBe(1);
    expect(consent?.inlineChildren).toBe(0);
    expect(consent?.fits).toBe(true);
    expect(consent?.text).toContain("and NAT gateway (about $100–150 a month at the small size)");
    expect(consent?.text).toContain("I'll review the installer's permissions in AWS before approving.");
    expect(consentBox.rect.top).toBeGreaterThanOrEqual(dialog.rect.top);
    expect(consentBox.rect.bottom).toBeLessThanOrEqual(dialog.rect.bottom);
    expect(consentBox.rect.left).toBeGreaterThanOrEqual(dialog.rect.left);
    expect(consentBox.rect.right).toBeLessThanOrEqual(dialog.rect.right);
    evidence.recordAssertionEvidence("the complete consent is visible as one coherent text block", `The AWS account/hosted-zone consent, $100–150 monthly estimate and permission-review obligation occupy one text node, fit the dialog horizontally, and are fully inside its bounds (${consentBox.rect.top.toFixed(1)}–${consentBox.rect.bottom.toFixed(1)}px).`, true);
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

  await step("after: all six unfinished installation checks are readable without claiming completion", async () => {
    await owner.see({ text: "Waiting for approval in AWS." });
    await owner.see({ testId: "managed-deployment-steps" });
    const { labels, neutralColor } = await world.deploymentTextReadability();
    expect(labels).toHaveLength(6);
    expect(neutralColor).not.toBeNull();
    for (const label of labels) {
      expect(label.contrast).toBeGreaterThanOrEqual(4.5);
      expect(label.opacity).toBe(1);
      expect(label.color).toBe(neutralColor);
      expect(label.pendingMarker).toBe(true);
      expect(label.otherMarker).toBe(false);
    }
    const [item] = await deployments();
    expect(item.run?.state).toBe("awaiting_approval");
    expect(item.run?.events).toHaveLength(0);
    expect(item.installedVersion).toBeNull();
    evidence.recordAssertionEvidence("readable pending labels do not invent installer progress", `All six labels use the same neutral ink as Waiting for approval in AWS, at ${Math.min(...labels.map((label) => label.contrast)).toFixed(2)}:1 minimum contrast. Six dashed pending markers remain; Den still reports awaiting_approval, zero events and no installed version.`, true);
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

  await step("the owner adds a long-named staging deployment and a sandbox in an existing AWS network", async () => {
    const existingNetwork = {
      vpcId: "vpc-0a1b2c3d4e5f60718", serviceSubnetIds: ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"],
      loadBalancerSubnetIds: ["subnet-0bbbbbbbbbbbbbbb1", "subnet-0bbbbbbbbbbbbbbb2"], ecsClusterArn: "arn:aws:ecs:us-east-1:123456789014:cluster/platform",
    };
    for (const target of targets) {
      await owner.click({ role: "button", label: "Create deployment" });
      await owner.see({ role: "heading", label: "Create deployment" });
      await owner.type({ label: "Name" }, target.name, { replace: true });
      await owner.type({ label: "AWS account ID" }, target.accountId, { replace: true });
      await owner.type({ label: "Address" }, target.domain, { replace: true });
      await owner.type({ label: "Route 53 hosted zone ID for that address" }, "ZTEST123", { replace: true });
      await owner.type({ label: "First administrator email" }, "admin@example.test", { replace: true });
      if (target.existing) {
        await owner.click({ testId: "network-existing" });
        await owner.type({ label: "VPC ID" }, existingNetwork.vpcId, { replace: true });
        await owner.type({ label: /^Private subnet IDs/ }, existingNetwork.serviceSubnetIds.join(", "), { replace: true });
        await owner.type({ label: /^Public subnet IDs/ }, existingNetwork.loadBalancerSubnetIds.join(", "), { replace: true });
        await owner.type({ label: /^ECS cluster ARN/ }, existingNetwork.ecsClusterArn, { replace: true });
      }
      await owner.click({ role: "checkbox", label: /^I control this AWS account/ });
      await owner.click({ testId: "create-deployment-submit" });
      await owner.see({ role: "heading", label: target.name }, { timeoutMs: 60_000 });
    }
    const sandbox = (await deployments()).find((item) => item.name === "Sandbox");
    expect(sandbox?.target.network).toEqual({ mode: "existing", ...existingNetwork });
    await owner.see({ text: `${existingNetwork.vpcId} · cluster platform` });
    expect((await deployments()).filter((item) => item.target.network.mode === "dedicated")).toHaveLength(2);
    const before = await deployments();
    expect(before).toHaveLength(3);
    expect(new Set(before.map((item) => item.id)).size).toBe(3);
    const added = before.filter((item) => item.id !== deploymentId);
    expect(added.every((item) => item.run === null && item.installedVersion === null)).toBe(true);
    evidence.recordAssertionEvidence("the existing AWS network is saved without hiding its configuration", `Three deployments exist: Production awaits approval, while the long-named Staging and Sandbox are Not launched. Sandbox retains VPC ${existingNetwork.vpcId}, both pairs of subnet IDs and ECS cluster ${existingNetwork.ecsClusterArn}; its network is shown in the detail.`, true);
    await owner.screenshot();
  });

  await step("after: mixed deployment states and a long name keep straight lanes on a wide screen", async () => {
    await owner.click({ role: "button", label: new RegExp(`^${stagingName}\\s*AWS`) });
    await owner.see({ role: "heading", label: stagingName });
    await owner.see({ testId: "managed-deployment-status" }, { text: "Not launched" });
    const statuses = (await page.dom('[data-deployment-status]')).elements;
    const versions = (await page.dom('[data-deployment-version]')).elements;
    const names = (await page.dom('[data-deployment-name]')).elements;
    const [detailStatus] = (await page.dom('[data-testid="managed-deployment-status"]')).elements;
    expect(statuses).toHaveLength(3);
    expect(versions).toHaveLength(3);
    expect(names).toHaveLength(3);
    expect(new Set(statuses.map((status) => status.text))).toEqual(new Set(["Awaiting AWS approval", "Not launched"]));
    for (const [index, status] of statuses.entries()) {
      expect(Math.abs(status.rect.right - detailStatus.rect.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(status.rect.width - 208)).toBeLessThanOrEqual(1);
      expect(Math.abs(versions[index].rect.width - 80)).toBeLessThanOrEqual(1);
      expect(Math.abs(versions[index].rect.right - versions[0].rect.right)).toBeLessThanOrEqual(1);
      expect(names[index].rect.width).toBeGreaterThan(0);
      expect(names[index].rect.right).toBeLessThanOrEqual(versions[index].rect.left);
      expect(versions[index].rect.right).toBeLessThanOrEqual(status.rect.left);
    }
    evidence.recordAssertionEvidence("mixed states share fixed lanes and the detail edge", `At 1440px, three rows include Awaiting AWS approval and Not launched; version lanes are ${versions.map((version) => version.rect.width).join(" / ")}px, status lanes are ${statuses.map((status) => status.rect.width).join(" / ")}px, and list/detail statuses end at ${detailStatus.rect.right}px within 1px. The ${stagingName.length}-character name has its own non-overlapping lane.`, true);
    await owner.screenshot();
  });

  await step("after: at 320 pixels the long name, deployment states and AWS details stay inside the page", async () => {
    await owner.resizeViewport({ width: 320, height: 1000, deviceScaleFactor: 1 });
    await owner.see({ role: "heading", label: stagingName });
    await owner.see({ testId: "managed-deployment-status" }, { text: "Not launched" });
    const layout = await page.dom('[data-testid="managed-deployment-row"]');
    const statuses = (await page.dom('[data-deployment-status]')).elements;
    const versions = (await page.dom('[data-deployment-version]')).elements;
    const names = (await page.dom('[data-deployment-name]')).elements;
    const [heading] = (await page.dom('[data-testid="managed-deployment-detail"] h2')).elements;
    const [detailStatus] = (await page.dom('[data-testid="managed-deployment-status"]')).elements;
    expect(layout.viewportWidth).toBe(320);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.elements).toHaveLength(3);
    expect(statuses).toHaveLength(3);
    expect(names).toHaveLength(3);
    expect(versions).toHaveLength(3);
    for (const [index, row] of layout.elements.entries()) {
      expect(row.rect.left).toBeGreaterThanOrEqual(0);
      expect(row.rect.right).toBeLessThanOrEqual(layout.viewportWidth);
      expect(names[index].rect.width).toBeGreaterThan(0);
      expect(names[index].rect.right).toBeLessThanOrEqual(versions[index].rect.left);
      expect(names[index].rect.bottom).toBeLessThanOrEqual(statuses[index].rect.top);
      expect(Math.abs(statuses[index].rect.right - detailStatus.rect.right)).toBeLessThanOrEqual(1);
    }
    expect(heading.text).toBe(stagingName);
    expect(heading.rect.right).toBeLessThanOrEqual(layout.viewportWidth);
    const configurationRows = (await page.dom('[data-testid="managed-deployment-configuration"] > div')).elements;
    expect(configurationRows.map((row) => row.text).join(" ")).toContain("123456789013");
    for (const row of configurationRows) {
      expect(row.rect.right).toBeLessThanOrEqual(layout.viewportWidth);
    }
    evidence.recordAssertionEvidence("a small screen keeps the full name and configuration without sideways scrolling", `Viewport/document widths are ${layout.viewportWidth}/${layout.documentWidth}px. All three rows fit; statuses move below their name/version lanes and align with the detail. The full ${stagingName.length}-character heading and AWS account 123456789013 remain readable.`, true);
    await owner.screenshot();
  });

  await step("after: the complete first-sign-in directions fit a 320-pixel screen", async () => {
    await owner.click({ testId: "deployment-technical-details-toggle" });
    await owner.see({ testId: "deployment-setup-directions" }, { text: /OpenWork never receives it\.$/ });
    const layout = await page.dom('[data-testid="deployment-setup-directions"]');
    const [directions] = layout.elements;
    const { setup } = await world.deploymentTextReadability();
    const deployment = (await deployments()).find((item) => item.name === stagingName);
    if (!deployment) throw new Error("The staging deployment is missing while reading setup directions.");
    expect(layout.viewportWidth).toBe(320);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.elements).toHaveLength(1);
    expect(setup?.disclosed).toBe(true);
    expect(setup?.textNodeCount).toBe(1);
    expect(setup?.inlineChildren).toBe(0);
    expect(setup?.fits).toBe(true);
    expect(directions.text).toContain(`First sign-in: open ${deployment.webUrl}/setup`);
    expect(directions.text).toContain("AWS Secrets Manager secret, field DEN_INITIAL_ADMIN_BOOTSTRAP_CODE.");
    expect(directions.text).toContain("OpenWork never receives it.");
    expect(directions.rect.left).toBeGreaterThanOrEqual(0);
    expect(directions.rect.right).toBeLessThanOrEqual(320);
    expect(directions.rect.top).toBeGreaterThanOrEqual(0);
    expect(directions.rect.bottom).toBeLessThanOrEqual(1000);
    evidence.recordAssertionEvidence("the setup address and secret-field directions are fully visible", `At ${layout.viewportWidth}px, the complete ${deployment.webUrl}/setup address, AWS Secrets Manager field DEN_INITIAL_ADMIN_BOOTSTRAP_CODE and OpenWork never receives it statement wrap as one text node. The paragraph is fully on screen (${directions.rect.top.toFixed(1)}–${directions.rect.bottom.toFixed(1)}px), and document width is ${layout.documentWidth}px with no sideways overflow.`, true);
    await owner.screenshot();
    await owner.click({ testId: "deployment-technical-details-toggle" });
  });

  await step("three deployments keep independent AWS approvals after a reload", async () => {
    await owner.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    // Prepare each from its own row while the other approvals stay pending.
    const added = (await deployments()).filter((item) => item.id !== deploymentId);
    for (const item of added) {
      await owner.click({ role: "button", label: new RegExp(`^${item.name}\\s*AWS`) });
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
      await owner.see({ role: "button", label: new RegExp(`^${name}\\s*AWS`) }, { timeoutMs: 60_000 });
    }
    const after = await deployments();
    expect(after).toHaveLength(3);
    expect(after.find((item) => item.id === deploymentId)?.run?.id).toBe(runId);
    for (const approval of approvals) {
      expect(after.find((item) => item.id === approval.id)?.run?.id).toBe(approval.run?.id);
    }
    expect(after.every((item) => item.run?.state === "awaiting_approval" && item.run.events.length === 0 && item.installedVersion === null)).toBe(true);
    await owner.notSee({ text: "Operational" });
    evidence.recordAssertionEvidence("three independent customer-cloud installs", "Production, Staging (dedicated networks) and Sandbox (an existing VPC and ECS cluster, entered in the form) remain listed after reload, with three distinct deployment/run IDs and account-bound AWS approvals. Preparing each leaves Production unchanged; none falsely claims to be running.", true);
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

  const removal = await step("Remove names the deployment and its consequence before anything is deleted", async () => {
    await owner.click({ role: "button", label: new RegExp(`^${stagingName}\\s*AWS`) });
    await owner.see({ role: "heading", label: stagingName });
    const before = await deployments();
    const deployment = before.find((item) => item.name === stagingName);
    if (!deployment) throw new Error("The staging deployment is missing before Remove.");
    expect(deployment.run?.state).toBe("awaiting_approval");
    expect(deployment.installedVersion).toBeNull();
    await owner.click({ testId: "managed-deployment-remove" });
    await owner.see({ testId: "confirm-dialog" }, { text: new RegExp(`Remove ${stagingName}\\?`) });
    await owner.see({ text: "This removes the deployment record and its pending approval from this workspace. AWS resources and charges are unchanged. This cannot be undone." });
    const dialogs = (await page.dom('[role="alertdialog"][data-testid="confirm-dialog"]')).elements;
    const [cancel] = (await page.dom('[data-testid="confirm-dialog-cancel"]')).elements;
    const buttons = (await page.dom('[data-testid="confirm-dialog"] button')).elements;
    expect(dialogs).toHaveLength(1);
    expect(cancel.focused).toBe(true);
    expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Remove"]);
    expect(await deployments()).toHaveLength(3);
    evidence.recordAssertionEvidence("Remove opens a safe confirmation without deleting the record", `One alert dialog names ${stagingName}, says the record and pending approval are removed but AWS resources and charges are unchanged, and offers Cancel / Remove. Cancel receives focus; all three deployments still exist.`, true);
    await owner.screenshot();
    return { before, deployment };
  });

  await step("after: Cancel keeps the deployment and every pending AWS approval", async () => {
    await owner.click({ testId: "confirm-dialog-cancel" });
    await owner.notSee({ testId: "confirm-dialog" });
    await owner.see({ role: "heading", label: stagingName });
    await owner.see({ testId: "managed-deployment-status" }, { text: "Awaiting AWS approval" });
    const after = await deployments();
    expect(after).toHaveLength(3);
    for (const item of removal.before) {
      const preserved = after.find((entry) => entry.id === item.id);
      expect(preserved?.target).toEqual(item.target);
      expect(preserved?.run?.id).toBe(item.run?.id);
      expect(preserved?.run?.state).toBe("awaiting_approval");
    }
    await owner.see({ role: "button", label: new RegExp(`^${stagingName}\\s*AWS`) });
    evidence.recordAssertionEvidence("Cancel has no destructive side effect", `All three deployment IDs, AWS targets and pending approval IDs are unchanged; ${stagingName} stays selected with Awaiting AWS approval.`, true);
    await owner.screenshot();
  });

  await step("after: confirming Remove deletes only that record and the other deployments stay tracked", async () => {
    await owner.click({ testId: "managed-deployment-remove" });
    await owner.see({ testId: "confirm-dialog" }, { text: new RegExp(`Remove ${stagingName}\\?`) });
    // The shared confirmation starts on Cancel; Tab reaches its destructive
    // Remove rather than the page's identically named control behind the modal.
    const [cancel] = (await page.dom('[data-testid="confirm-dialog-cancel"]')).elements;
    expect(cancel.focused).toBe(true);
    await owner.press("Tab");
    const focused = (await page.dom('[data-testid="confirm-dialog"] button')).elements.filter((button) => button.focused);
    expect(focused.map((button) => button.text)).toEqual(["Remove"]);
    await owner.press("Enter");
    await owner.notSee({ role: "button", label: new RegExp(`^${stagingName}\\s*AWS`) }, { timeoutMs: 60_000 });
    await owner.notSee({ testId: "confirm-dialog" });
    await owner.reload();
    await owner.see({ role: "button", label: /^Production\s*AWS/ }, { timeoutMs: 60_000 });
    await owner.see({ role: "button", label: /^Sandbox\s*AWS/ });
    await owner.notSee({ role: "button", label: new RegExp(`^${stagingName}\\s*AWS`) });
    const after = await deployments();
    expect(after).toHaveLength(2);
    expect(after.some((item) => item.id === removal.deployment.id)).toBe(false);
    for (const item of removal.before.filter((entry) => entry.id !== removal.deployment.id)) {
      const preserved = after.find((entry) => entry.id === item.id);
      expect(preserved?.target).toEqual(item.target);
      expect(preserved?.run?.id).toBe(item.run?.id);
      expect(preserved?.run?.state).toBe("awaiting_approval");
    }
    evidence.recordAssertionEvidence("only the confirmed deployment is gone after reload", `${stagingName} is absent from the page and Den's list. Production and Sandbox remain, with their original AWS targets and pending approvals; the count is 2, not 0.`, true);
    await owner.screenshot();
  });
});
