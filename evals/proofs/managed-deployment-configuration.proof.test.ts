import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { managedDeploymentConfigurationWorld } from "../worlds/managed-deployment-configuration.ts";

const test = spec.world(managedDeploymentConfigurationWorld, {
  timeout: 600_000,
  needs: { commands: ["pnpm"] },
  resources: { surfaces: ["web"], services: ["den"] },
});

const WITHIN = 45_000;
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openwork/daytona-key-Ab12Cd";
const SNAPSHOT = "openwork-computer";
const id = (testId: string) => `[data-testid="${testId}"]`;

test("an owner turns on the gateway runtime and cloud computers for an installed deployment, and it changes only after AWS approval", async ({ world, user, probe, step, evidence }) => {
  const person = user.on(world.owner);
  const page = probe.on(world.owner);

  /** What Den records for the deployment right now, read from its API. */
  async function recorded() {
    const shown = await world.deployment();
    if (shown.provider !== "aws") throw new Error("The deployment is not on AWS");
    return {
      email: shown.ownerEmail, profile: shown.target.runtimeProfile, computers: shown.target.assistants.computerProvider,
      installedVersion: shown.installedVersion, run: shown.run, canEdit: shown.configuration !== undefined, change: shown.configuration?.change ?? null,
    };
  }
  /** The text of every element a selector finds on a page, hidden or not. */
  const texts = async (selector: string, on = page) => (await on.dom(selector)).elements.map((element) => element.text);
  /** Waits until the page shows the text in the element with this test id. Each step then looks at one landmark, which frames its screenshot. */
  const shows = (testId: string, text: string, on = page) => on.eventually(() => texts(id(testId), on), {
    within: WITHIN, label: `"${text}" on the page`, until: (found) => found.some((entry) => entry.includes(text)),
  });
  /** Each requested change as the page lists it: "label: before → after". */
  async function changeRows() {
    const cells = (selector: string) => texts(`${id("deployment-configuration-change")} ${selector}`);
    const [labels, before, after] = await Promise.all([cells("p"), cells("[data-change-before]"), cells("[data-change-after]")]);
    return labels.map((label, index) => `${label}: ${before[index]} → ${after[index]}`);
  }

  await step("before: an installed deployment has no way to change its configuration", async () => {
    await person.see({ text: "Status checks" }, { timeoutMs: 120_000 });
    await shows("managed-deployment-status", "Operational");
    const controls = await texts(`${id("managed-deployment-detail")} > div > button, ${id("managed-deployment-detail")} > div > a`);
    const before = await recorded();
    const refused = await world.requestChange("owner", { ownerEmail: "not.requested@example.com" });
    expect(controls).toContain("Open OpenWork");
    expect(controls).not.toContain("Edit configuration");
    expect(before.installedVersion).toBe(world.installedVersion);
    expect(before.profile).toBe("legacy");
    expect(before.canEdit).toBe(false);
    expect(refused.status).toBe(404);
    expect(refused.error).toBe("feature_disabled");
    evidence.recordAssertionEvidence("With the feature off there is no edit control and Den refuses a change",
      `Installed ${before.installedVersion}, runtime ${before.profile}, computers ${before.computers}; the deployment's actions are ${controls.join(" and ")}; the deployment list has no configuration block; the owner's own change request answers ${refused.status} ${refused.error}`,
      !before.canEdit && refused.status === 404 && !controls.includes("Edit configuration"));
    await person.screenshot();
  });

  await step("the owner opens Edit configuration and sees current values, with installation values locked", async () => {
    await world.setConfigurationChanges(true);
    await person.reload();
    await page.eventually(() => texts(id("managed-deployment-edit-configuration")), { within: WITHIN, label: "Edit configuration is offered", until: (found) => found.length === 1 });
    await person.click({ role: "button", label: "Edit configuration" });
    await person.see({ text: "Fixed at installation" }, { timeoutMs: WITHIN });
    const fields = await page.dom(`${id("deployment-configuration-form")} input`);
    const fixed = await texts(`${id("deployment-configuration-fixed")} [data-field]`);
    const fixedControls = (await page.dom(`${id("deployment-configuration-fixed")} input, ${id("deployment-configuration-fixed")} select, ${id("deployment-configuration-fixed")} button`)).elements.length;
    const reviewLocked = (await page.dom(`${id("deployment-configuration-review")}:disabled`)).elements.length;
    expect(await texts(`${id("deployment-configuration-form")} label > span`)).toEqual(["Name", "First administrator email"]);
    expect(fields.elements).toHaveLength(2);
    expect(await texts(id("deployment-configuration-runtime"))).toEqual(["RuntimeCore services onlyAdd gateway runtime"]);
    expect(fixed).toEqual(["Addressopenwork.example.com", `AWS account${world.account}`, "Regionus-east-1", "Hosted zoneZ0123456789ABC", "NetworkDedicated VPC", "SizeSmall"]);
    expect(fixedControls).toBe(0);
    expect(reviewLocked).toBe(1);
    evidence.recordAssertionEvidence("Current values are editable; installation values are read-only",
      `The name and the first administrator email are the only fields; the runtime reads "Core services only" with an "Add gateway runtime" button; ${fixed.length} values under "Fixed at installation" (address, AWS account, region, hosted zone, network, size) have no control; Review changes is locked until something changes`,
      fixed.length === 6 && fixedControls === 0 && reviewLocked === 1);
    await person.screenshot();
  });

  await step("the owner adds the gateway runtime and Daytona computers and reviews before and after", async () => {
    await person.click({ role: "button", label: "Add gateway runtime" });
    await person.click({ label: "Cloud computers (optional)" });
    await person.press("ArrowDown");
    await person.press("Enter");
    await person.type({ label: "Daytona key secret ARN" }, SECRET_ARN);
    await person.type({ label: "Daytona computer snapshot" }, SNAPSHOT);
    await person.click({ role: "button", label: "Review changes" });
    await person.see({ testId: "deployment-configuration-changes" }, { timeoutMs: WITHIN });
    const rows = await changeRows();
    const effects = await texts(id("deployment-configuration-change-effect"));
    const consent = (await texts(id("deployment-configuration-consent")))[0] ?? "";
    const blocked = (await page.dom(`${id("deployment-configuration-submit")}:disabled`)).elements.length;
    expect(rows).toEqual([
      "Runtime: Core services only → Gateway runtime",
      "Cloud computers: Off → Daytona",
      `Computer provider key secret ARN: Not set → ${SECRET_ARN}`,
      `Daytona computer snapshot: Not set → ${SNAPSHOT}`,
    ]);
    expect(effects.join(" ")).toContain("They can't be removed later. The OpenWork API and web app restart.");
    expect(consent).toContain(`I'll approve this in AWS account ${world.account} by running one command in AWS CloudShell; nothing changes until I do.`);
    expect(consent).toContain("The OpenWork API and web app restart");
    expect(consent).toContain("Daytona computers run outside my AWS account and are billed by Daytona");
    expect(blocked).toBe(1);
    evidence.recordAssertionEvidence("The review lists each value before and after, says what restarts, and cannot be sent without the owner's agreement",
      `${rows.join(" | ")}; the review says the OpenWork API and web app restart and that the gateway runtime can't be removed later; Prepare AWS approval is locked until the owner ticks the agreement`, rows.length === 4 && blocked === 1);
    await person.screenshot();
  });

  let command = "";
  await step("after: the owner gets one command for AWS CloudShell and the deployment still records the old configuration", async () => {
    await person.click({ testId: "deployment-configuration-consent" });
    await person.click({ role: "button", label: "Prepare AWS approval" });
    await shows("managed-deployment-status", "Awaiting AWS approval");
    await shows("managed-deployment-configuration-change-state", "Nothing has changed yet.");
    await person.click({ testId: "managed-deployment-command-toggle" });
    await person.see({ text: "Configuration change" }, { timeoutMs: WITHIN });
    const commands = await texts(id("managed-deployment-command"));
    const dialogs = (await page.dom(id("deployment-configuration-dialog"))).elements.length;
    const pending = await recorded();
    command = commands[0] ?? "";
    expect(commands).toHaveLength(1);
    expect(dialogs).toBe(0);
    expect(command).toContain("aws cloudformation update-stack");
    expect(await changeRows()).toHaveLength(4);
    expect(pending.profile).toBe("legacy");
    expect(pending.computers).toBe("off");
    expect(pending.run?.kind).toBe("configure");
    expect(pending.run?.state).toBe("awaiting_approval");
    expect(pending.run?.version).toBe(world.installedVersion);
    expect(pending.change?.state).toBe("awaiting_approval");
    evidence.recordAssertionEvidence("Preparing a change records the request, not the configuration",
      `One command on the page; Den still records runtime ${pending.profile} and computers ${pending.computers}; the run is a ${pending.run?.kind} run at ${pending.run?.version}, the installed version, in state ${pending.run?.state}`,
      pending.profile === "legacy" && pending.run?.kind === "configure" && pending.run.version === world.installedVersion);
    await person.screenshot();
  });

  await step("while AWS applies the approved command, the deployment still records the old configuration", async () => {
    const run = await world.aws.start(command);
    const sent = run.approval.parameters;
    await world.aws.progress(run, 5);
    await shows("managed-deployment-status", "Applying configuration change");
    await person.see({ text: "Configuration change" }, { timeoutMs: WITHIN });
    const applying = await recorded();
    expect(sent.OpenWorkVersion).toBe(world.installedVersion);
    expect(sent.ManagedRuntimeProfile).toBe("gateway");
    expect(sent.HeadlessComputerProvider).toBe("daytona");
    expect(sent.HeadlessComputerSecretArn).toBe(SECRET_ARN);
    expect(applying.profile).toBe("legacy");
    expect(applying.run?.events).toHaveLength(5);
    evidence.recordAssertionEvidence("Five of six installer milestones change nothing Den records",
      `The command carries OpenWorkVersion ${sent.OpenWorkVersion}, ManagedRuntimeProfile ${sent.ManagedRuntimeProfile} and HeadlessComputerProvider ${sent.HeadlessComputerProvider}; after ${applying.run?.events.length} milestones Den still records runtime ${applying.profile} and computers ${applying.computers}`,
      applying.profile === "legacy" && applying.run?.events.length === 5);
    await person.screenshot();
    await world.aws.progress(run, 6);
  });

  await step("after: once the command is approved in AWS the deployment records the gateway runtime", async () => {
    await world.aws.reportHealth(world.deploymentId, { gateway: true });
    await shows("managed-deployment-status", "Operational");
    await person.click({ text: "Managed runtime" });
    await person.see({ label: "Cloud computers (optional)" }, { timeoutMs: WITHIN, text: "Daytona (preferred)" });
    const summaries = (await page.dom(id("managed-deployment-configuration-change"))).elements.length;
    const applied = await recorded();
    expect(summaries).toBe(0);
    expect(applied.profile).toBe("gateway");
    expect(applied.computers).toBe("daytona");
    expect(applied.installedVersion).toBe(world.installedVersion);
    expect(applied.run?.state).toBe("ready");
    expect(applied.change).toBeNull();
    evidence.recordAssertionEvidence("The approved run's last milestone records the new configuration at the same installer version",
      `Den records runtime ${applied.profile} and computers ${applied.computers}; installed version ${applied.installedVersion}, unchanged; the ${applied.run?.kind} run is ${applied.run?.state} and no change is pending`,
      applied.profile === "gateway" && applied.computers === "daytona" && applied.installedVersion === world.installedVersion);
    await person.screenshot();
  });

  await step("a workspace admin who can view but not manage deployments sees the control locked and cannot prepare a change", async () => {
    const teammate = user.on(world.teammate);
    const theirs = probe.on(world.teammate);
    await teammate.reload();
    await teammate.see({ testId: "managed-deployment-configuration-lock" }, { timeoutMs: 120_000 });
    const reason = (await texts(id("managed-deployment-configuration-lock"), theirs))[0] ?? "";
    const locked = (await theirs.dom(`${id("managed-deployment-edit-configuration")}:disabled`)).elements.length;
    const refused = await world.requestChange("teammate", { ownerEmail: "not.requested@example.com" });
    const after = await recorded();
    expect(reason).toBe("Needs the “Manage deployments” permission. Ask the organization owner.");
    expect(locked).toBe(1);
    expect(refused.status).toBe(403);
    expect(after.change).toBeNull();
    expect(after.email).toBe("admin@example.com");
    evidence.recordAssertionEvidence("Viewing deployments does not allow changing them",
      `Edit configuration is shown locked with "${reason}"; the admin's own change request to Den answers ${refused.status}; Den records no pending change and still lists first administrator ${after.email}`,
      locked === 1 && refused.status === 403 && after.change === null);
    await teammate.screenshot();
  });

  await step("nothing left this machine for AWS: every identity check Den made was answered by the local fixture", async () => {
    const traffic = await world.awsTraffic();
    const roles = [...new Set(traffic.answered.map((entry) => entry.role.replace(/^openwork-[0-9a-f]+-/, "")))].sort();
    expect(traffic.refused).toEqual([]);
    expect(traffic.answered).toHaveLength(4);
    expect(traffic.answered.every((entry) => entry.account === world.account && entry.region === "us-east-1")).toBe(true);
    expect(roles).toEqual(["health", "runner"]);
    evidence.recordAssertionEvidence("Den's only AWS call is the STS identity replay, and it was answered inside the Den API process",
      `${traffic.answered.length} STS GetCallerIdentity replays answered locally for account ${world.account} (the installer twice, the health agent twice); ${traffic.denied} denied; ${traffic.refused.length} requests to any other amazonaws.com host were attempted`,
      traffic.refused.length === 0 && traffic.answered.length === 4);
  });
});
