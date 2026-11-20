import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { runToolTurn } from "@openwork/behaviors";
import { packagedSandboxRegression } from "../worlds/packaged-sandbox-regression.ts";

// Prepared, branch-built artifact only. Unlike sandbox-only's ordinary source
// lane, this refuses development Electron and verifies the ASAR server/runtime.
// Real-inference companion: evals/scripts/packaged-sandbox-check.ts (Fable + Sol).
const test = spec.world(packagedSandboxRegression, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "The subject is the branch-built macOS .app: its ASAR embedded server, staged native SDK and shipping Electron runtime must boot and run a real microVM." },
  needs: { placement: "local", platform: "darwin", env: ["OPENWORK_EVAL_ELECTRON_BINARY"], optIn: ["MICROSANDBOX_LIVE"] },
});

test("a packaged desktop member can add Linux tools and then confine all tools to the sandbox", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: the member opens the packaged app with ordinary host tools allowed", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const settings = await probe.eventually(() => probe.desktopApi(world.settingsPath), {
      within: 90_000, label: "the isolated organization rollout reaches the packaged server",
      until: result => result.status === 200 && JSON.stringify(result.body).includes('"featureEnabled":true'),
    });
    evidence.recordAssertionEvidence("The real packaged app starts with the verified rollout", `${world.artifact.embeddedServer}; packaged: ${world.isPackaged}; settings: ${JSON.stringify(settings.body)}`, world.isPackaged && settings.status === 200);
    expect(settings.body).toMatchObject({ useSandbox: false, forceSandbox: false, featureEnabled: true });
    await user.screenshot();
  });
  await step("when: the member adds a sandbox alongside the computer’s tools", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "sandbox-use-switch" });
    await user.click({ testId: "sandbox-use-switch" });
    await user.see({ testId: "sandbox-ready" }, { timeoutMs: 90_000 });
    await user.screenshot();
    await user.click("Back to app");
    await agent.run("session.open", { sessionId: world.session.sessionId });
    const sandboxCommand = "uname -s; printf 'USE_GUEST_WITNESS\\n'";
    const hostCommand = "uname -s; printf 'USE_HOST_WITNESS\\n'";
    const prompt = await runToolTurn({ user }, world, "Compare the sandbox and this computer in the same turn.", [
      { tool: "sandbox_shell", arguments: { command: sandboxCommand } },
      { tool: "shell", arguments: { command: hostCommand } },
    ]);
    await user.see("Run task", { timeoutMs: 180_000 });
    const sandbox = await world.toolCall("sandbox_shell", input => input.command === sandboxCommand);
    const host = await world.toolCall("shell", input => input.command === hostCommand);
    const catalogs = (await world.offeredCatalogs(prompt)).filter(names => names.length > 0);
    const expected = ["edit", "glob", "grep", "read", "shell", "write"];
    const both = catalogs.length > 0 && catalogs.every(names => expected.every(tool => names.includes(tool) && names.includes(`sandbox_${tool}`)));
    const distinct = sandbox?.status === "completed" && host?.status === "completed" && /\bLinux\b/.test(sandbox.output) && /\bDarwin\b/.test(host.output);
    evidence.recordAssertionEvidence("Use adds six tools while preserving the computer tools", `${JSON.stringify(catalogs)}; sandbox ${sandbox?.output}; computer ${host?.output}`, distinct && both);
    expect(distinct).toBe(true);
    expect(both).toBe(true);
    await user.click({ role: "button", label: /^Worked for/ });
    await user.see({ testId: "sandbox-tag" });
    await user.screenshot();
  });
  await step("when: the member enables Force and authorizes one folder", async () => {
    await agent.run("route.settings.authorized_folders");
    await user.see({ testId: "sandbox-force-switch" });
    await user.click({ testId: "sandbox-force-switch" });
    const settings = await probe.eventually(() => probe.desktopApi(world.settingsPath), {
      within: 90_000, label: "Force applies after the previous turn", until: result => result.status === 200 && JSON.stringify(result.body).includes('"effectiveForceSandbox":true'),
    });
    const folders = await agent.desktopApi(world.foldersPath, { method: "PUT", body: { folders: [world.authorizedPath] } });
    evidence.recordAssertionEvidence("The packaged server requires sandbox-only and mounts the chosen absolute path", `${JSON.stringify(settings.body)}; authorized: ${world.authorizedPath}; HTTP ${folders.status}`, settings.status === 200 && folders.status === 200);
    expect(settings.body).toMatchObject({ useSandbox: true, forceSandbox: true, effectiveForceSandbox: true });
    expect(folders.status).toBe(200);
    await user.see({ testId: "sandbox-ready" }, { timeoutMs: 90_000 });
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
