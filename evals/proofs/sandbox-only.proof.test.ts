import { spec } from "@openwork/testkit";
import type { Probe, User } from "@openwork/testkit";
import { expect } from "vitest";
import { runToolTurn } from "@openwork/behaviors";
import { sandboxFlagOffDesktop, sandboxManagedDesktop, sandboxOnlyDesktop, sandboxUnavailableDesktop } from "../worlds/sandbox-only.ts";

// Run all four checks explicitly:
// MICROSANDBOX_LIVE=1 MICROSANDBOX_PRODUCT_PROOF=1 pnpm evals:e2e sandbox-only --local --engine v2 --surface electron
// This is the shipping Electron Node runtime plus an actual Linux microVM, not
// an in-memory provider. The separate sandbox-controls proof is portable to
// Daytona and makes no guest-isolation claim.
const live = spec.world(sandboxOnlyDesktop, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The native desktop forwards the seeded member's verified Den policy to its embedded server; the microVM and live host mounts run on this computer." },
  needs: { placement: "local", platform: "darwin", optIn: ["MICROSANDBOX_LIVE"] } });
const unavailable = spec.world(sandboxUnavailableDesktop, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The native desktop forwards the seeded member's verified Den policy to its embedded server; the microVM and live host mounts run on this computer." },
  needs: { placement: "local", optIn: ["MICROSANDBOX_PRODUCT_PROOF"] } });
const ordinary = spec.world(sandboxFlagOffDesktop, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The native desktop forwards the seeded member's verified Den policy to its embedded server; the microVM and live host mounts run on this computer." },
  needs: { placement: "local", optIn: ["MICROSANDBOX_PRODUCT_PROOF"] } });
const managed = spec.world(sandboxManagedDesktop, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den"],
    nativeReason: "The native desktop forwards the seeded member's verified Den policy to its embedded server; the microVM and live host mounts run on this computer." },
  needs: { placement: "local", optIn: ["MICROSANDBOX_PRODUCT_PROOF"] } });
const directTools = ["edit", "glob", "grep", "read", "shell", "write"];
const stepIds = ["download", "start", "folders"];
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

async function revealLatestWork(user: User, probe: Probe) {
  // Wait until sending is available again, then unfold the latest rendered
  // activity if it folded. Do not count old rails: chat virtualizes old turns.
  await user.see("Run task");
  const rails = await probe.dom('[data-testid="completed-work-rail"]');
  if (rails.elements.at(-1)?.tag === "button") await user.click({ testId: "completed-work-rail", nth: rails.elements.length - 1 });
}

live("a member adds sandbox tools, then limits the agent to the sandbox and authorized folders", async ({ world, user, agent, probe, step, evidence }) => {
  const turn = async (label: string, tool: string, args: Record<string, unknown>) => {
    const prompt = await runToolTurn({ user }, world, label, [{ tool, arguments: args }]);
    await revealLatestWork(user, probe);
    return prompt;
  };
  const settled = (tool: string, matches: (input: Record<string, unknown>) => boolean) => probe.eventually(() => world.toolCall(tool, matches), {
    within: 150_000, label: `the ${tool} call finishes`, until: call => call !== null,
  });

  const waitMode = (key: "effectiveUseSandbox" | "effectiveForceSandbox") => probe.eventually(() => probe.desktopApi(world.settingsPath), {
    within: 90_000, label: "the selected sandbox mode applies", until: result => result.status === 200 && JSON.stringify(result.body).includes(`"${key}":true`),
  });
  const openChat = async () => {
    await user.click("Back to app");
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
  };

  await step("before: an eligible member has not opted in and no sandbox tools are offered", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const settings = await probe.eventually(() => probe.desktopApi(world.settingsPath), {
      within: 90_000, label: "the sandbox rollout is verified",
      until: result => result.status === 200 && JSON.stringify(result.body).includes('"featureEnabled":true'),
    });
    const privateBytes = await world.privateBytes();
    expect(settings.body).toMatchObject({ useSandbox: false, forceSandbox: false, effectiveUseSandbox: false, effectiveForceSandbox: false, featureEnabled: true });
    expect(privateBytes).toBe(world.nonce);
    const prompt = await turn("Identify the operating system before turning on the sandbox.", "shell", { command: "uname -s", description: "Identify this computer" });
    const tools = await world.offeredTools(prompt);
    const call = await settled("shell", input => input.command === "uname -s");
    expect(call?.status).toBe("completed");
    expect(call?.output).toContain("Darwin");
    expect(tools).toContain("shell");
    expect(tools.filter(tool => tool.startsWith("sandbox_"))).toEqual([]);
    await user.notSee({ testId: "sandbox-mode-pill" });
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "sandbox-use-switch" });
    evidence.recordAssertionEvidence("The rollout alone does not change the catalog", `shell: ${call?.output}; sandbox tools: ${tools.filter(tool => tool.startsWith("sandbox_")).length}; private file unchanged: ${privateBytes === world.nonce}`, call?.output?.includes("Darwin") === true && !tools.some(tool => tool.startsWith("sandbox_")));
    await user.screenshot();
  });

  await step("when the member turns on Use, Permissions shows the preparation steps", async () => {
    await user.click({ testId: "sandbox-use-switch" });
    await user.see({ testId: "sandbox-step-download" }, { timeoutMs: 30_000 });
    const steps = (await probe.dom(stepIds.map(id => `[data-testid="sandbox-step-${id}"]`).join(","))).elements;
    evidence.recordAssertionEvidence("Download, start, and connect folders are visible", steps.map(item => item.text).join("; "), steps.length === 3);
    expect(steps).toHaveLength(3);
    await user.screenshot();
  });

  await step("after: the sandbox is ready and the project is editable", async () => {
    await user.see({ testId: "sandbox-ready" }, { timeoutMs: 180_000 });
    const settings = await waitMode("effectiveUseSandbox");
    const folders = (await probe.dom('[data-testid="sandbox-folder"]')).elements.map(item => item.text);
    const canEdit = folders.some(text => text.includes(world.workspacePath) && text.includes("Can edit"));
    evidence.recordAssertionEvidence("Ready lists the editable project", folders.join("; "), canEdit);
    expect(canEdit).toBe(true);
    expect(settings.body).toMatchObject({ useSandbox: true, forceSandbox: false, effectiveForceSandbox: false });
    await user.screenshot();
  });

  await step("after: the same chat runs one Linux command in the sandbox and one Mac command outside it", async () => {
    await openChat();
    await user.see({ testId: "sandbox-mode-pill" }, { text: /^Sandbox$/ });
    const hostCommand = "uname -s # Same chat outside the sandbox";
    const prompt = await runToolTurn({ user }, world, "Identify the operating system in both environments.", [
      { tool: "sandbox_shell", arguments: { command: "uname -s", description: "Identify the sandbox system" } },
      { tool: "shell", arguments: { command: hostCommand, description: "Identify the Mac system" } },
    ]);
    await revealLatestWork(user, probe);
    const guest = await settled("sandbox_shell", input => input.command === "uname -s");
    const host = await settled("shell", input => input.command === hostCommand);
    const catalogs = await world.offeredCatalogs(prompt);
    const tools = catalogs[0] ?? [];
    expect(tools).toEqual(expect.arrayContaining([...directTools, ...directTools.map(tool => `sandbox_${tool}`)]));
    expect(guest?.status).toBe("completed");
    expect(guest?.output).toContain("Linux");
    expect(host?.status).toBe("completed");
    expect(host?.output).toContain("Darwin");
    await user.see({ testId: "sandbox-group-tag" }, { text: /^1 in sandbox$/ });
    await user.click({ testId: "sandbox-group-tag" });
    await user.see({ testId: "sandbox-tag" }, { text: /^Sandbox$/ });
    const tagged = (await probe.dom('[data-tool-aggregate-row]:has([data-testid="sandbox-tag"])')).elements;
    const mac = (await probe.dom('[data-tool-aggregate-row]:has(button[aria-label*="Identify the Mac system"])')).elements;
    const taggedMac = (await probe.dom('[data-tool-aggregate-row]:has(button[aria-label*="Identify the Mac system"]):has([data-testid="sandbox-tag"])')).elements;
    expect(tagged).toHaveLength(1);
    expect(mac).toHaveLength(1);
    expect(taggedMac).toHaveLength(0);
    evidence.recordAssertionEvidence("Only the Linux line is marked Sandbox and both sets of tools were offered", `sandbox: ${guest?.output}; computer: ${host?.output}; tags: ${tagged.length}; offered: ${tools.join(", ")}`, tagged.length === 1 && mac.length === 1 && taggedMac.length === 0);
    await user.screenshot();
  });

  await step("when the member turns on Force, Use is included", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "sandbox-force-switch" }, { timeoutMs: 60_000 });
    await user.click({ testId: "sandbox-force-switch" });
    await user.see({ text: "Included in Force OpenWork Sandbox" });
    const result = await waitMode("effectiveForceSandbox");
    evidence.recordAssertionEvidence("Force requires the sandbox for every tool", JSON.stringify(result.body), result.status === 200 && JSON.stringify(result.body).includes('"effectiveForceSandbox":true'));
    expect(result.body).toMatchObject({ useSandbox: true, forceSandbox: true, effectiveForceSandbox: true, managedForce: false });
    await user.screenshot();
  });

  await step("after: the same shell tool runs on Linux and cannot read the unmounted host file", async () => {
    await openChat();
    await user.see({ testId: "sandbox-mode-pill" }, { text: /^Sandbox only$/ });
    const command = `uname -s; if [ -f ${quote(world.privateFile)} ]; then cat ${quote(world.privateFile)}; else printf 'UNMOUNTED_HOST_FILE_IS_ABSENT\\n'; fi`;
    const prompt = await turn("Check the operating system and whether the private file is visible.", "shell", { command });
    const call = await settled("shell", input => input.command === command);
    const tools = await world.offeredTools(prompt);
    const output = call?.output ?? "";
    const expectedTools = directTools;
    const ok = call?.status === "completed" && output.includes("Linux") && output.includes("UNMOUNTED_HOST_FILE_IS_ABSENT") && !output.includes(world.nonce) && JSON.stringify(tools) === JSON.stringify(expectedTools);
    evidence.recordAssertionEvidence("Real guest execution, not merely renamed tools", `offered: ${tools.join(", ")}; shell: ${call?.status}; error: ${call?.error ?? ""}; output: ${output}`, ok);
    expect(call?.status).toBe("completed");
    expect(output).toContain("Linux");
    expect(output).toContain("UNMOUNTED_HOST_FILE_IS_ABSENT");
    expect(output).not.toContain(world.nonce);
    expect(tools).toEqual(expectedTools);
    await user.see({ role: "button", label: "Show details for Ran a command" });
    const disclosures = await probe.dom('button[aria-label="Show details for Ran a command"]');
    await user.click({ role: "button", label: "Show details for Ran a command", nth: disclosures.elements.length - 1 });
    await user.see({ text: /UNMOUNTED_HOST_FILE_IS_ABSENT/ });
    const visibleOutput = (await probe.dom('[data-text-command-output]')).elements.map(element => element.text).join("\n");
    expect(visibleOutput).toContain("Linux");
    expect(visibleOutput).toContain("UNMOUNTED_HOST_FILE_IS_ABSENT");
    await user.screenshot();
  });

  await step("before: a sibling folder is not readable until the member authorizes it", async () => {
    await turn("Read the shared briefing before granting access.", "read", { path: world.sharedFile });
    const call = await settled("read", input => input.path === world.sharedFile);
    const ok = call?.status === "error" && !(call.output ?? "").includes(world.initialText);
    evidence.recordAssertionEvidence("An unmounted sibling stays private", `${call?.status}: ${call?.error ?? ""} ${call?.output ?? ""}`, ok);
    expect(call?.status).toBe("error");
    expect(call?.output ?? "").not.toContain(world.initialText);
    await user.screenshot();
  });

  await step("when the member grants the shared folder through the Authorized Folders API", async () => {
    const granted = await agent.desktopApi(world.foldersPath, { method: "PUT", body: { folders: [world.authorizedPath] } });
    await agent.run("route.settings.authorized_folders");
    await user.see({ text: world.authorizedPath }, { timeoutMs: 60_000 });
    const folderList = await probe.eventually(async () => (await probe.dom('[data-testid="sandbox-folder"]')).elements.map(item => item.text), {
      within: 180_000, label: "the Ready list includes the authorized folder", until: entries => entries.some(text => text.includes(world.authorizedPath) && text.includes("Can edit")),
    });
    await user.see({ testId: "sandbox-ready" });
    evidence.recordAssertionEvidence("The Ready list contains the new editable folder", `HTTP ${granted.status}; ${folderList.join("; ")}`, granted.status === 200 && folderList.some(text => text.includes(world.authorizedPath) && text.includes("Can edit")));
    expect(granted.status).toBe(200);
    expect(JSON.stringify(granted.body)).toContain(world.authorizedPath);
    await user.screenshot();
  });

  await step("after: the sandbox reads the authorized folder at the same path", async () => {
    await user.click("Back to app");
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await turn("Read the newly authorized briefing at the same path.", "read", { path: world.sharedFile });
    // Distinguish this successful call from the earlier denied call.
    const command = `printf 'GUEST_PATH='; pwd; cat ${quote(world.sharedFile)}`;
    await turn("Check the authorized folder's absolute path and current bytes.", "shell", { command, cwd: world.authorizedPath });
    const call = await settled("shell", input => input.command === command);
    const output = call?.output ?? "";
    const ok = call?.status === "completed" && output.includes(`GUEST_PATH=${world.authorizedPath}`) && output.includes(world.initialText);
    evidence.recordAssertionEvidence("The mount preserves the absolute path and original host bytes", output, ok);
    expect(call?.status).toBe("completed");
    expect(output).toContain(`GUEST_PATH=${world.authorizedPath}`);
    expect(output).toContain(world.initialText);
    await user.screenshot();
  });

  await step("when another person edits the host file, the running guest sees the new bytes", async () => {
    await world.hostEditsSharedFile();
    // Bind-mount metadata can lag a host-side file growth briefly. Repeat only
    // read-only user turns, with a hard bound; never accept truncated bytes.
    let output = "";
    let status = "";
    let attempts = 0;
    for (const attempt of [1, 2, 3, 4, 5]) {
      attempts = attempt;
      const command = `cat ${quote(world.sharedFile)}; printf '\\nLIVE_HOST_EDIT_${attempt}\\n'`;
      await turn("Read the latest briefing after the host edited it.", "shell", { command });
      const call = await settled("shell", input => input.command === command);
      output = call?.output ?? "";
      status = call?.status ?? "missing";
      if (status === "completed" && output.includes(world.updatedText)) break;
    }
    const ok = status === "completed" && output.includes(world.updatedText) && !output.includes(world.initialText);
    evidence.recordAssertionEvidence("This is a live bind mount, not an upload or startup copy", `read attempts: ${attempts}; ${output}`, ok);
    expect(status).toBe("completed");
    expect(output).toContain(world.updatedText);
    expect(output).not.toContain(world.initialText);
    await user.screenshot();
  });

  await step("after: an edit in the sandbox changes the same file and leaves the private file intact", async () => {
    await turn("Replace the briefing through the guest edit tool.", "edit", { path: world.sharedFile, oldString: world.updatedText, newString: world.guestText });
    const call = await settled("edit", input => input.path === world.sharedFile);
    const bytes = await world.sharedBytes();
    const privateBytes = await world.privateBytes();
    const ok = call?.status === "completed" && bytes === world.guestText && privateBytes === world.nonce;
    evidence.recordAssertionEvidence("Guest-to-host edits are live and the private witness is unchanged", `edit: ${call?.status}; shared bytes: ${bytes}; private file unchanged: ${privateBytes === world.nonce}`, ok);
    expect(call?.status).toBe("completed");
    expect(bytes).toBe(world.guestText);
    expect(privateBytes).toBe(world.nonce);
    await user.screenshot();
  });
});

unavailable("a member whose sandbox cannot start gets an error and never silently runs the command on their computer", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: Force stays on when the sandbox cannot start, and Permissions offers Retry", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    await probe.eventually(() => probe.desktopApi(world.settingsPath), { within: 90_000, label: "sandbox rollout is verified", until: result => JSON.stringify(result.body).includes('"featureEnabled":true') });
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "sandbox-force-switch" }, { timeoutMs: 60_000 });
    await user.click({ testId: "sandbox-force-switch" });
    await user.see({ testId: "sandbox-error" }, { timeoutMs: 180_000 });
    await user.see({ testId: "sandbox-retry" }, { text: "Retry" });
    const saved = await probe.desktopApi(world.settingsPath);
    const message = (await probe.dom('[data-testid="sandbox-error"]')).elements[0]?.text ?? "";
    const plain = /sandbox/i.test(message) && !/microvm|bridge|host|fallback|engine|guest|ENOTDIR/i.test(message);
    evidence.recordAssertionEvidence("The failure is explained without technical details", message, plain);
    expect(saved.body).toMatchObject({ effectiveForceSandbox: true, featureEnabled: true });
    expect(plain).toBe(true);
    await user.screenshot();
  });
  const command = `printf 'HOST_FALLBACK' > ${quote(world.sentinel)}`;
  await step("when the member asks the agent to save a file outside every mount", async () => {
    await user.click("Back to app");
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await user.see({ testId: "sandbox-mode-pill" }, { text: /^Sandbox only\s+Sandbox needs attention$/ });
    await runToolTurn({ user }, world, "Save a note while the sandbox service is unavailable.", [{ tool: "shell", arguments: { command } }]);
    await revealLatestWork(user, probe);
    const call = await probe.eventually(() => world.toolCall("shell", input => input.command === command), { within: 150_000, label: "the unavailable sandbox reports its error", until: value => value !== null });
    evidence.recordAssertionEvidence("The attempted guest shell call fails instead of falling back", `${call?.status}: ${call?.error ?? ""} ${call?.output ?? ""}`, call?.status === "error");
    expect(call?.status).toBe("error");
    await user.screenshot();
  });
  await step("after: the host-only sentinel was never created", async () => {
    await user.see("composer", { editable: true });
    const exists = await world.sentinelExists();
    evidence.recordAssertionEvidence("No host fallback ran", `host sentinel exists: ${exists}`, !exists);
    expect(exists).toBe(false);
    await user.screenshot();
  });
  await step("after: Retry prepares the sandbox once the runtime is available again", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "sandbox-retry" });
    await world.restoreRuntime();
    await user.click({ testId: "sandbox-retry" });
    await user.see({ testId: "sandbox-ready" }, { timeoutMs: 180_000 });
    await user.notSee({ testId: "sandbox-error" });
    const status = await probe.desktopApi(world.statusPath);
    evidence.recordAssertionEvidence("Retry reaches Ready without restarting the app", JSON.stringify(status.body), status.status === 200 && JSON.stringify(status.body).includes('"state":"ready"'));
    expect(status.body).toMatchObject({ mode: "force", state: "ready", error: null });
    await user.screenshot();
  });
});

ordinary("a member outside the sandbox rollout keeps ordinary host execution unchanged", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: the organization has not enabled sandbox tools", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "authorized-folders-panel" }, { timeoutMs: 60_000 });
    const hidden = await probe.eventually(() => probe.dom('[data-testid="sandbox-panel"][data-ready="true"][hidden]'), { within: 60_000, label: "Permissions settles without a sandbox section", until: result => result.elements.length === 1 });
    await user.notSee({ testId: "sandbox-panel" });
    const settings = await probe.desktopApi(world.settingsPath);
    evidence.recordAssertionEvidence("The flag is off and Permissions omits the sandbox section", JSON.stringify(settings.body), settings.status === 200 && hidden.elements.length === 1);
    expect(settings.body).toMatchObject({ useSandbox: false, forceSandbox: false, effectiveForceSandbox: false, allowHostExecution: true, effectiveAllowHostExecution: true, featureEnabled: false });
    await user.screenshot();
  });
  let prompt = "";
  const command = `cat ${quote(world.privateFile)}`;
  await step("when the member reads their ordinary host file with the normal shell tool", async () => {
    await user.click("Back to app");
    await agent.run("session.open", { sessionId: world.session.sessionId });
    prompt = await runToolTurn({ user }, world, "Read the private note on this computer.", [{ tool: "shell", arguments: { command, description: "Read a local note" } }]);
    await revealLatestWork(user, probe);
    const call = await probe.eventually(() => world.toolCall("shell", input => input.command === command), { within: 60_000, label: "the ordinary host call settles", until: value => value !== null });
    const output = call?.output ?? "";
    evidence.recordAssertionEvidence("The normal host tool still reads the host-only witness", `${call?.status}; private nonce present: ${output.includes(world.nonce)}`, call?.status === "completed" && output.includes(world.nonce));
    expect(call?.status).toBe("completed");
    expect(output).toContain(world.nonce);
    await user.screenshot();
  });
  await step("after: no sandbox-prefixed tools were added to the ordinary catalog", async () => {
    await user.see("composer", { editable: true });
    const tools = await world.offeredTools(prompt);
    evidence.recordAssertionEvidence("The rollout leaves the ordinary catalog alone", tools.join(", "), tools.includes("shell") && !tools.some(tool => tool.startsWith("sandbox_")));
    expect(tools).toContain("shell");
    expect(tools.some(tool => tool.startsWith("sandbox_"))).toBe(false);
    await user.screenshot();
  });
});

managed("a managed member cannot weaken the team's sandbox-only requirement with a local preference", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: the desktop receives the team's stricter host-execution rule", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const settings = await probe.eventually(() => probe.desktopApi(world.settingsPath), {
      within: 90_000, label: "the native desktop receives the verified team restriction",
      until: result => JSON.stringify(result.body).includes('"managed":true'),
    });
    evidence.recordAssertionEvidence("The team restriction wins over the default local allow", JSON.stringify(settings.body), settings.status === 200 && JSON.stringify(settings.body).includes('"effectiveAllowHostExecution":false'));
    expect(settings.body).toMatchObject({ allowHostExecution: true, effectiveAllowHostExecution: false, managed: true });
    await user.screenshot();
  });
  await step("after: Permissions explains the organization lock and disables the local switch", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "sandbox-use-managed" }, { text: "Managed by your organization", timeoutMs: 60_000 });
    await user.see({ testId: "sandbox-force-managed" }, { text: "Managed by your organization" });
    const locked = await probe.dom('[data-testid="sandbox-panel"] [role="switch"][aria-checked="true"]:is(:disabled,[aria-disabled="true"])');
    evidence.recordAssertionEvidence("Both switches are on and managed by the organization", `locked and on: ${locked.elements.length}`, locked.elements.length === 2);
    expect(locked.elements).toHaveLength(2);
    await user.screenshot();
  });
  await step("when a client saves a local allow directly, the effective restriction still stands", async () => {
    const result = await agent.desktopApi(world.settingsPath, { method: "PUT", body: { allowHostExecution: true } });
    await user.reload();
    await user.see({ testId: "sandbox-force-managed" }, { text: "Managed by your organization", timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("A public-API client cannot bypass the stricter policy either", `HTTP ${result.status}; ${JSON.stringify(result.body)}`, result.status === 200 && JSON.stringify(result.body).includes('"effectiveAllowHostExecution":false'));
    expect(result.body).toMatchObject({ allowHostExecution: true, effectiveAllowHostExecution: false, managed: true });
    await user.screenshot();
  });
});
