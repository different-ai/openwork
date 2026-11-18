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
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

async function revealLatestWork(user: User, probe: Probe) {
  // Wait until sending is available again, then unfold the latest rendered
  // activity if it folded. Do not count old rails: chat virtualizes old turns.
  await user.see("Run task");
  const rails = await probe.dom('[data-testid="completed-work-rail"]');
  if (rails.elements.at(-1)?.tag === "button") await user.click({ testId: "completed-work-rail", nth: rails.elements.length - 1 });
}

live("a member turns off host tools and works in a real guest with only the folders they authorized", async ({ world, user, agent, probe, step, evidence }) => {
  const turn = async (label: string, tool: string, args: Record<string, unknown>) => {
    const prompt = await runToolTurn({ user }, world, label, [{ tool, arguments: args }]);
    await revealLatestWork(user, probe);
    return prompt;
  };
  const settled = (tool: string, matches: (input: Record<string, unknown>) => boolean) => probe.eventually(() => world.toolCall(tool, matches), {
    within: 150_000, label: `the ${tool} call finishes`, until: call => call !== null,
  });

  await step("before: the member can run host tools and the sandbox rollout is verified", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const settings = await probe.eventually(() => probe.desktopApi(world.settingsPath), {
      within: 90_000, label: "the native desktop verifies the member's sandbox rollout",
      until: result => result.status === 200 && JSON.stringify(result.body).includes('"featureEnabled":true'),
    });
    const privateBytes = await world.privateBytes();
    const ok = settings.status === 200 && privateBytes === world.nonce;
    evidence.recordAssertionEvidence("The host-only witness exists before isolation", `settings: ${JSON.stringify(settings.body)}; private host file exists: ${privateBytes === world.nonce}`, ok);
    expect(settings.body).toMatchObject({ allowHostExecution: true, effectiveAllowHostExecution: true, featureEnabled: true });
    expect(privateBytes).toBe(world.nonce);
    await user.screenshot();
  });

  await step("when the member turns off Run tools on this computer in Permissions", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "host-execution-switch" }, { timeoutMs: 60_000 });
    await user.click({ testId: "host-execution-switch" });
    await user.see({ testId: "host-execution-saved" });
    const result = await probe.desktopApi(world.settingsPath);
    evidence.recordAssertionEvidence("The local switch saves a sandbox-only requirement", JSON.stringify(result.body), result.status === 200 && JSON.stringify(result.body).includes('"effectiveAllowHostExecution":false'));
    expect(result.body).toMatchObject({ allowHostExecution: false, effectiveAllowHostExecution: false, managed: false });
    await user.screenshot();
  });

  await step("after: the same shell tool runs on Linux and cannot read the unmounted host file", async () => {
    await user.click("Back to app");
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const command = `uname -s; if [ -f ${quote(world.privateFile)} ]; then cat ${quote(world.privateFile)}; else printf 'UNMOUNTED_HOST_FILE_IS_ABSENT\\n'; fi`;
    const prompt = await turn("Check the operating system and whether the private file is visible.", "shell", { command });
    const call = await settled("shell", input => input.command === command);
    const tools = await world.offeredTools(prompt);
    const output = call?.output ?? "";
    const expectedTools = ["edit", "glob", "grep", "read", "shell", "write"];
    const ok = call?.status === "completed" && output.includes("Linux") && output.includes("UNMOUNTED_HOST_FILE_IS_ABSENT") && !output.includes(world.nonce) && JSON.stringify(tools) === JSON.stringify(expectedTools);
    evidence.recordAssertionEvidence("Real guest execution, not merely renamed tools", `offered: ${tools.join(", ")}; shell: ${call?.status}; error: ${call?.error ?? ""}; output: ${output}`, ok);
    expect(call?.status).toBe("completed");
    expect(output).toContain("Linux");
    expect(output).toContain("UNMOUNTED_HOST_FILE_IS_ABSENT");
    expect(output).not.toContain(world.nonce);
    expect(tools).toEqual(expectedTools);
    // This is the first turn, so its rail is unambiguous even with chat
    // virtualization. Expose the actual command output in the gallery.
    await probe.eventually(() => probe.dom('[data-testid="completed-work-rail"]'), {
      within: 5_000, label: "the guest command's activity is visible", until: snapshot => snapshot.elements.length > 0,
    });
    const folded = await probe.dom('[data-testid="completed-work-rail"][aria-expanded="false"]');
    if (folded.elements.length) await user.click({ testId: "completed-work-rail" });
    await user.click({ role: "button", label: "Show details for Ran a command" });
    await user.see({ text: /Linux/ });
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
    evidence.recordAssertionEvidence("The real Authorized Folders setting contains the new path", `HTTP ${granted.status}; ${JSON.stringify(granted.body)}`, granted.status === 200 && JSON.stringify(granted.body).includes(world.authorizedPath));
    expect(granted.status).toBe(200);
    expect(JSON.stringify(granted.body)).toContain(world.authorizedPath);
    await user.screenshot();
  });

  await step("after: the guest reads the authorized folder at its unchanged absolute host path", async () => {
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

  await step("after: a guest edit updates that same host file without exposing the private sibling", async () => {
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
  await step("given the member requires a sandbox while its runtime directory is unavailable", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    await probe.eventually(() => probe.desktopApi(world.settingsPath), { within: 90_000, label: "sandbox rollout is verified", until: result => JSON.stringify(result.body).includes('"featureEnabled":true') });
    const saved = await agent.desktopApi(world.settingsPath, { method: "PUT", body: { allowHostExecution: false } });
    evidence.recordAssertionEvidence("Sandbox-only stays required despite the runtime outage", JSON.stringify(saved.body), saved.status === 200 && JSON.stringify(saved.body).includes('"effectiveAllowHostExecution":false'));
    expect(saved.body).toMatchObject({ effectiveAllowHostExecution: false, featureEnabled: true });
    await user.screenshot();
  });
  const command = `printf 'HOST_FALLBACK' > ${quote(world.sentinel)}`;
  await step("when the member asks the agent to save a file outside every mount", async () => {
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
});

ordinary("a member outside the sandbox rollout keeps ordinary host execution unchanged", async ({ world, user, probe, step, evidence }) => {
  await step("before: the organization has not enabled sandbox tools", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const settings = await probe.desktopApi(world.settingsPath);
    evidence.recordAssertionEvidence("The flag is off and host execution remains allowed", JSON.stringify(settings.body), settings.status === 200 && JSON.stringify(settings.body).includes('"featureEnabled":false'));
    expect(settings.body).toMatchObject({ allowHostExecution: true, effectiveAllowHostExecution: true, featureEnabled: false });
    await user.screenshot();
  });
  let prompt = "";
  const command = `cat ${quote(world.privateFile)}`;
  await step("when the member reads their ordinary host file with the normal shell tool", async () => {
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
    await user.see({ testId: "host-execution-note" }, { timeoutMs: 60_000 });
    const locked = await probe.eventually(() => probe.dom('[data-testid="host-execution-switch"]:is(:disabled, [aria-disabled="true"])'), {
      within: 5_000, label: "the organization-managed switch is disabled", until: snapshot => snapshot.elements.length === 1,
    });
    const denied = await probe.dom('[data-testid="host-execution-row"][data-host-execution="deny"][data-host-execution-managed="true"]');
    evidence.recordAssertionEvidence("The member sees a disabled, organization-managed restriction", `disabled switches: ${locked.elements.length}; managed deny rows: ${denied.elements.length}`, locked.elements.length === 1 && denied.elements.length === 1);
    expect(locked.elements).toHaveLength(1);
    expect(denied.elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("when a client saves a local allow directly, the effective restriction still stands", async () => {
    const result = await agent.desktopApi(world.settingsPath, { method: "PUT", body: { allowHostExecution: true } });
    await user.reload();
    await user.see({ testId: "host-execution-note" }, { timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("A public-API client cannot bypass the stricter policy either", `HTTP ${result.status}; ${JSON.stringify(result.body)}`, result.status === 200 && JSON.stringify(result.body).includes('"effectiveAllowHostExecution":false'));
    expect(result.body).toMatchObject({ allowHostExecution: true, effectiveAllowHostExecution: false, managed: true });
    await user.screenshot();
  });
});
