import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { runToolTurn } from "@openwork/behaviors";
import { packagedSandboxFlagOff, packagedSandboxManaged, packagedSandboxManagedComputer, packagedSandboxRegression, packagedSandboxUnavailable } from "../worlds/packaged-sandbox-regression.ts";

// Prepared, branch-built artifact only. Unlike sandbox-only's ordinary source
// lane, this refuses development Electron and verifies the ASAR server/runtime.
// Real-inference companion: evals/scripts/packaged-sandbox-check.ts (Fable + Sol).
const test = spec.world(packagedSandboxRegression, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The subject is the branch-built macOS .app: its ASAR embedded server, staged native SDK and shipping Electron runtime must boot and run a real microVM." },
  needs: { placement: "local", platform: "darwin", env: ["OPENWORK_EVAL_ELECTRON_BINARY"], optIn: ["MICROSANDBOX_LIVE"] },
});

test("a member of a packaged install disables host tools and edits a live authorized folder in Linux", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: the member opens the packaged app with ordinary host tools allowed", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const settings = await probe.eventually(() => probe.desktopApi(world.settingsPath), {
      within: 90_000, label: "the isolated organization rollout reaches the packaged server",
      until: result => result.status === 200 && JSON.stringify(result.body).includes('"featureEnabled":true'),
    });
    evidence.recordAssertionEvidence("The real packaged app starts with the verified rollout", `${world.artifact.embeddedServer}; packaged: ${world.isPackaged}; settings: ${JSON.stringify(settings.body)}`, world.isPackaged && settings.status === 200);
    expect(settings.body).toMatchObject({ effectiveAllowHostExecution: true, featureEnabled: true });
    await user.screenshot();
  });
  await step("when the member chooses In a sandbox (isolated) and authorizes one folder", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.see("Where the agent runs commands");
    await user.see({ testId: "sandbox-location-computer" });
    await user.click({ testId: "sandbox-location-sandbox" });
    await user.see("Folders the sandbox can see");
    const settings = await probe.eventually(() => probe.desktopApi(world.settingsPath), {
      within: 90_000, label: "the selected sandbox location is persisted", until: result => result.status === 200 && JSON.stringify(result.body).includes('"effectiveAllowHostExecution":false'),
    });
    const folders = await agent.desktopApi(world.foldersPath, { method: "PUT", body: { folders: [world.authorizedPath] } });
    evidence.recordAssertionEvidence("The packaged server requires sandbox-only and mounts the chosen absolute path", `${JSON.stringify(settings.body)}; authorized: ${world.authorizedPath}; HTTP ${folders.status}`, settings.status === 200 && folders.status === 200);
    expect(settings.body).toMatchObject({ allowHostExecution: false, effectiveAllowHostExecution: false });
    expect(folders.status).toBe(200);
    await user.click("Back to app");
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "sandbox-folder-access", text: "Read-write" });
    const headings = (await probe.dom('h4[data-slot="item-title"]')).elements.map(heading => heading.text);
    expect(headings.indexOf("Where the agent runs commands")).toBeGreaterThanOrEqual(0);
    expect(headings.indexOf("Folders the sandbox can see")).toBeGreaterThan(headings.indexOf("Where the agent runs commands"));
    await user.screenshot();
  });
  await step("after: the same shell tool runs in Linux with no host tool in the actual model catalog", async () => {
    await user.click("Back to app");
    await agent.run("session.open", { sessionId: world.session.sessionId });
    const command = `uname -s; cat '${world.sharedFile}'; if [ -f '${world.privateFile}' ]; then cat '${world.privateFile}'; else printf '\\nPRIVATE_HOST_FILE_ABSENT\\n'; fi`;
    const prompt = await runToolTurn({ user }, world, "Check Linux and the folder I allowed, not the private sibling.", [{ tool: "shell", arguments: { command } }]);
    await user.see("Run task", { timeoutMs: 180_000 });
    const call = await probe.eventually(() => world.toolCall("shell", input => input.command === command), {
      within: 150_000, label: "the real packaged guest command settles", until: value => value !== null,
    });
    const tools = await world.offeredTools(prompt);
    const output = call?.output ?? "";
    const ok = call?.status === "completed" && output.includes("Linux") && output.includes(world.initialText) && output.includes("PRIVATE_HOST_FILE_ABSENT") && !output.includes(world.nonce);
    evidence.recordAssertionEvidence("Real Linux execution and exactly six direct tools", `actual API catalog: ${tools.join(", ")}; ${output}`, ok && JSON.stringify(tools) === JSON.stringify(["edit", "glob", "grep", "read", "shell", "write"]));
    expect(ok).toBe(true);
    expect(tools).toEqual(["edit", "glob", "grep", "read", "shell", "write"]);
    await user.see({ testId: "session-sandbox-indicator" });
    expect((await probe.dom('[data-testid="session-sandbox-indicator"][data-sandbox-state="sandbox"]')).elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("when another person updates the host file the guest reads the new bytes and edits them back", async () => {
    await world.hostEditsSharedFile();
    const prompt = await runToolTurn({ user }, world, "Read the live host edit and replace it with the guest edit.", [
      { tool: "read", arguments: { path: world.sharedFile } },
      { tool: "edit", arguments: { path: world.sharedFile, oldString: world.updatedText, newString: world.guestText } },
    ]);
    await user.see("Run task", { timeoutMs: 180_000 });
    const read = await probe.eventually(() => world.toolCall("read", input => input.path === world.sharedFile), {
      within: 150_000, label: "the guest sees the later host edit", until: value => value !== null,
    });
    await probe.eventually(() => world.sharedBytes(), { within: 30_000, label: "the guest edit reaches host disk", until: value => value === world.guestText });
    const bytes = await world.sharedBytes();
    const privateBytes = await world.privateBytes();
    const tools = await world.offeredTools(prompt);
    const ok = read?.status === "completed" && (read.output ?? "").includes(world.updatedText) && bytes === world.guestText && privateBytes === world.nonce;
    evidence.recordAssertionEvidence("The packaged guest and host share one live file, not a startup copy", `read: ${read?.output}; host bytes after guest edit: ${bytes}; private sibling intact: ${privateBytes === world.nonce}; tools: ${tools.join(", ")}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});


test("a member sees real sandbox preparation before commands can run in the packaged app", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: the member explicitly chooses where commands run", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.see("Where the agent runs commands");
    await user.see("On this computer");
    await user.see("In a sandbox (isolated)");
    const selected = await probe.dom('[data-testid="sandbox-location-computer"][aria-checked="true"]');
    evidence.recordAssertionEvidence("The computer is selected before sandbox preparation", JSON.stringify(selected), selected.elements.length === 1);
    expect(selected.elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("when the member selects sandbox the packaged runtime reports real preparation progress", async () => {
    const startupHold = await world.holdNewOwnedRuntime();
    await user.click({ testId: "sandbox-location-sandbox" });
    const held = await startupHold.waitHeld();
    await user.see({ testId: "sandbox-preparation-progress" }, { timeoutMs: 60_000 });
    const result = await probe.eventually(() => probe.desktopApi(world.settingsPath), {
      within: 60_000, label: "a real measured preparation stage is observable",
      until: value => value.status === 200 && JSON.stringify(value.body).includes('"state":"starting"') && JSON.stringify(value.body).includes('"total":2'),
    });
    expect(result.body).toMatchObject({ runtime: { state: "starting", progress: { total: 2 } } });
    await user.see({ testId: "sandbox-preparation-count", text: /[01] \/ 2/ });
    evidence.recordAssertionEvidence("The displayed setup count comes from real file preparation or guest startup, not a fictitious download", JSON.stringify({ settings: result.body, captureBoundary: "Controlled startup slowdown: only this fresh proof's new owned guest is paused; this is not normal startup timing", process: held }), result.status === 200 && held.stopVerified);
    await step("controlled startup slowdown: the new proof-owned guest is paused while real preparation progress remains visible", async () => {
      await user.see({ testId: "sandbox-preparation-count", text: /[01] \/ 2/ });
      evidence.recordAssertionEvidence("SIGSTOP affects only the newly spawned descendant guest of this proof's app", JSON.stringify(held), held.stopVerified && held.state === "held");
      await user.screenshot();
    });
    await world.resumeHeldRuntime();
  });
  await step("after: sandbox readiness and folder access are visible together", async () => {
    await user.see("Sandbox ready", { timeoutMs: 180_000 });
    await user.see("Folders the sandbox can see");
    const result = await probe.desktopApi(world.settingsPath);
    expect(result.body).toMatchObject({ effectiveAllowHostExecution: false, pending: false, runtime: { state: "ready" } });
    const startupControl = world.startupHoldReceipt();
    expect(startupControl).toMatchObject({ state: "resumed", stopVerified: true, resumeVerified: true, readyVerified: true });
    evidence.recordAssertionEvidence("The same embedded server reports a ready guest", JSON.stringify({ settings: result.body, startupControl }), result.status === 200 && startupControl?.readyVerified === true);
    await user.screenshot();
  });
  await step("when this proof's idle guest crashes Settings shows failure rather than a stale ready label", async () => {
    const active = await probe.desktopApi(`/workspace/${world.app.workspaceId}/opencode2/api/session/active`);
    expect(active.status).toBe(200);
    expect(JSON.stringify(active.body)).not.toContain(world.session.sessionId);
    const target = await world.crashOwnedIdleRuntime();
    await user.see({ testId: "sandbox-retry" }, { timeoutMs: 90_000 });
    const result = await probe.desktopApi(world.settingsPath);
    expect(result.body).toMatchObject({ effectiveAllowHostExecution: false, runtime: { state: "failed", canRetry: true } });
    evidence.recordAssertionEvidence("Only the one descendant guest of this proof's app was interrupted while no task was active", JSON.stringify({ target, active: active.body, settings: result.body }), result.status === 200);
    await user.screenshot();
  });
  await step("after: Retry replaces the crashed guest without changing the selected location", async () => {
    await user.click({ testId: "sandbox-retry" });
    await user.see("Sandbox ready", { timeoutMs: 180_000 });
    const result = await probe.desktopApi(world.settingsPath);
    expect(result.body).toMatchObject({ effectiveAllowHostExecution: false, runtime: { state: "ready" } });
    evidence.recordAssertionEvidence("A real guest becomes ready again and host commands stay disabled", JSON.stringify(result.body), result.status === 200);
    await user.screenshot();
  });
});

const unavailableTest = spec.world(packagedSandboxUnavailable, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The subject is the branch-built macOS .app: its ASAR embedded server, staged native SDK and shipping Electron runtime must boot and run a real microVM." },
  needs: { placement: "local", platform: "darwin", env: ["OPENWORK_EVAL_ELECTRON_BINARY"], optIn: ["MICROSANDBOX_LIVE"] },
});
unavailableTest("a member repairs an unsupported sandbox installation and retries without host fallback", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: a fresh packaged install still offers the explicit computer choice", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.see("On this computer");
    const result = await probe.desktopApi(world.settingsPath);
    expect(result.body).toMatchObject({ effectiveAllowHostExecution: true });
    evidence.recordAssertionEvidence("The failure fixture is only a regular file at this world's own MSB_HOME", "Owned filesystem fault; real packaged server and native SDK; no simulated runtime response", result.status === 200 && world.isPackaged);
    await user.screenshot();
  });
  await step("when sandbox cannot start the saved sandbox choice stays selected and Retry is available", async () => {
    await user.click({ testId: "sandbox-location-sandbox" });
    await user.see({ testId: "sandbox-retry" }, { timeoutMs: 180_000 });
    const result = await probe.desktopApi(world.settingsPath);
    expect(result.body).toMatchObject({ effectiveAllowHostExecution: false, runtime: { state: "unsupported", reason: "runtime_unavailable", canRetry: true } });
    const selected = await probe.dom('[data-testid="sandbox-location-sandbox"][aria-checked="true"]');
    await user.see({ testId: "sandbox-runtime-status", text: "Restore access or reinstall OpenWork" });
    evidence.recordAssertionEvidence("A real installation-path failure does not switch to host commands; this is not a claim about unsupported Mac hardware", JSON.stringify(result.body), result.status === 200 && selected.elements.length === 1);
    expect(selected.elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("after: repairing only the owned runtime directory lets the real Retry start a guest", async () => {
    await world.repairOwnedRuntime();
    await user.click({ testId: "sandbox-retry" });
    await user.see("Sandbox ready", { timeoutMs: 180_000 });
    const result = await probe.desktopApi(world.settingsPath);
    expect(result.body).toMatchObject({ effectiveAllowHostExecution: false, runtime: { state: "ready" } });
    evidence.recordAssertionEvidence("Retry prepared the real guest without enabling host commands", JSON.stringify(result.body), result.status === 200);
    await user.screenshot();
  });
});

// These worlds use real isolated Den organizations and the ordinary native host-token
// handoff. They are not renderer props or forged desktop-config policy responses.
const managedSandboxTest = spec.world(packagedSandboxManaged, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The subject is the branch-built macOS .app: its ASAR embedded server, staged native SDK and shipping Electron runtime must boot and run a real microVM." },
  needs: { placement: "local", platform: "darwin", env: ["OPENWORK_EVAL_ELECTRON_BINARY"], optIn: ["MICROSANDBOX_LIVE"] },
});
managedSandboxTest("a member sees the organization's locked sandbox location in the packaged app", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: the organization policy arrives through the normal signed-in host context", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const result = await probe.eventually(() => probe.desktopApi(world.settingsPath), {
      within: 120_000, label: "the signed-in member's organization policy is effective",
      until: value => value.status === 200 && JSON.stringify(value.body).includes('"managed":true') && JSON.stringify(value.body).includes('"effectiveAllowHostExecution":false'),
    });
    expect(result.body).toMatchObject({ managed: true, effectiveAllowHostExecution: false });
    evidence.recordAssertionEvidence("An isolated Den rule, not a renderer override, selects the managed location", JSON.stringify(result.body), result.status === 200);
    await user.screenshot();
  });
  await step("when the member opens Settings both execution choices are locked", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.see("Where the agent runs commands");
    await user.see("Managed by your organization. An admin can change it in agent permissions.");
    const disabled = await probe.dom('[data-testid^="sandbox-location-"][disabled]');
    const selected = await probe.dom('[data-testid="sandbox-location-sandbox"][aria-checked="true"]');
    evidence.recordAssertionEvidence("Both choices are disabled and the policy-selected location remains explicit", JSON.stringify({ disabled, selected }), disabled.elements.length === 2 && selected.elements.length === 1);
    expect(disabled.elements).toHaveLength(2);
    expect(selected.elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("after: revisiting Settings preserves the organization lock", async () => {
    await user.click("Back to app");
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "sandbox-location-sandbox" });
    const result = await probe.desktopApi(world.settingsPath);
    expect(result.body).toMatchObject({ managed: true, effectiveAllowHostExecution: false });
    evidence.recordAssertionEvidence("Revisiting does not turn a managed location into a personal preference", JSON.stringify(result.body), result.status === 200);
    await user.screenshot();
  });
});

const managedComputerTest = spec.world(packagedSandboxManagedComputer, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The subject is the branch-built macOS .app: its ASAR embedded server, staged native SDK and shipping Electron runtime must boot and run a real microVM." },
  needs: { placement: "local", platform: "darwin", env: ["OPENWORK_EVAL_ELECTRON_BINARY"], optIn: ["MICROSANDBOX_LIVE"] },
});
managedComputerTest("a member sees the organization's locked computer location in the packaged app", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: the organization policy arrives through the normal signed-in host context", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const result = await probe.eventually(() => probe.desktopApi(world.settingsPath), {
      within: 120_000, label: "the signed-in member's organization policy is effective",
      until: value => value.status === 200 && JSON.stringify(value.body).includes('"managed":true') && JSON.stringify(value.body).includes('"effectiveAllowHostExecution":true'),
    });
    expect(result.body).toMatchObject({ managed: true, effectiveAllowHostExecution: true });
    evidence.recordAssertionEvidence("An isolated Den rule, not a renderer override, selects the managed location", JSON.stringify(result.body), result.status === 200);
    await user.screenshot();
  });
  await step("when the member opens Settings both execution choices are locked", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.see("Where the agent runs commands");
    await user.see("Managed by your organization. An admin can change it in agent permissions.");
    const disabled = await probe.dom('[data-testid^="sandbox-location-"][disabled]');
    const selected = await probe.dom('[data-testid="sandbox-location-computer"][aria-checked="true"]');
    evidence.recordAssertionEvidence("Both choices are disabled and the policy-selected location remains explicit", JSON.stringify({ disabled, selected }), disabled.elements.length === 2 && selected.elements.length === 1);
    expect(disabled.elements).toHaveLength(2);
    expect(selected.elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("after: revisiting Settings preserves the organization lock", async () => {
    await user.click("Back to app");
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "sandbox-location-computer" });
    const result = await probe.desktopApi(world.settingsPath);
    expect(result.body).toMatchObject({ managed: true, effectiveAllowHostExecution: true });
    evidence.recordAssertionEvidence("Revisiting does not turn a managed location into a personal preference", JSON.stringify(result.body), result.status === 200);
    await user.screenshot();
  });
});

const flagOffTest = spec.world(packagedSandboxFlagOff, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The subject is the branch-built macOS .app: its ASAR embedded server, staged native SDK and shipping Electron runtime must boot and run a real microVM." },
  needs: { placement: "local", platform: "darwin", env: ["OPENWORK_EVAL_ELECTRON_BINARY"], optIn: ["MICROSANDBOX_LIVE"] },
});
flagOffTest("a member outside the sandbox rollout sees no execution-location controls", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: this isolated organization has no sandbox rollout", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const result = await probe.desktopApi(world.settingsPath);
    expect(result.body).toMatchObject({ featureEnabled: false });
    evidence.recordAssertionEvidence("The negative organization has no verified sandbox feature", JSON.stringify(result.body), result.status === 200);
    await user.screenshot();
  });
  await step("when the member opens permissions the ordinary folder controls remain", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.notSee({ testId: "host-execution-row" });
    const rows = await probe.dom('[data-testid="host-execution-row"]');
    evidence.recordAssertionEvidence("The execution-location section is absent rather than disabled", JSON.stringify(rows), rows.elements.length === 0);
    expect(rows.elements).toHaveLength(0);
    await user.screenshot();
  });
  await step("after: revisiting cannot reveal the flagged controls", async () => {
    await user.click("Back to app");
    await agent.run("route.settings.authorized_folders");
    await user.notSee("Where the agent runs commands");
    const result = await probe.desktopApi(world.settingsPath);
    expect(result.body).toMatchObject({ featureEnabled: false });
    evidence.recordAssertionEvidence("Settings navigation did not opt this organization into sandbox execution", JSON.stringify(result.body), result.status === 200);
    await user.screenshot();
  });
});
