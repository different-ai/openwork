import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { retiredV1Runtime, retiredV1SessionTitle } from "../worlds/retired-v1-runtime.ts";

const test = spec.world(retiredV1Runtime, {
  timeout: 240_000,
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { commands: ["bun", "opencode2"] },
});

test("a member starts a real v2-only session without an installed v1 engine or a way back to it", async ({ world, user, probe, step, evidence }) => {
  let enginePid: number | undefined;
  async function noMigrationUi() {
    for (const testId of ["engine-upgrade-notice", "engine-migration-consent", "engine-migration-banner", "engine-migration-progress", "engine-switch-prompt"]) {
      await user.notSee({ testId }, { timeoutMs: 500 });
    }
  }

  await step("a real v2 session opens even though the configured v1 executable does not exist", async () => {
    const status = await probe.eventually(() => world.status(), {
      within: 90_000,
      label: "the real v2-only engine is healthy",
      until: value => value.enabled && value.chatRouting && value.running && Boolean(value.version) && Boolean(value.pid),
    });
    enginePid = status.pid;
    expect(status.version).toMatch(/^2\./);
    expect(status.lastError).toBeUndefined();
    await user.see({ text: retiredV1SessionTitle });
    await user.see("composer", { editable: true });
    await noMigrationUi();
    evidence.recordAssertionEvidence("The app opens a healthy v2 session with an unusable v1 binary path", JSON.stringify({ unavailableV1Binary: world.unavailableV1Binary, status }), status.running && status.chatRouting && Boolean(status.pid));
    await user.screenshot();
  });

  await step("turning force policy off cannot select the retired v1 engine", async () => {
    const acknowledgement = await world.turnForcePolicyOff();
    expect(acknowledgement.status).toBe(200);
    const status = await world.status();
    expect(status.running).toBe(true);
    expect(status.chatRouting).toBe(true);
    expect(status.pid).toBe(enginePid);
    await user.reload();
    await user.see({ text: retiredV1SessionTitle });
    await user.see("composer", { editable: true });
    await noMigrationUi();
    evidence.recordAssertionEvidence("Policy off leaves the same healthy v2 process serving the session", JSON.stringify({ acknowledgement, status }), acknowledgement.status === 200 && status.running && status.chatRouting && status.pid === enginePid);
    await user.screenshot();
  });

  await step("explicit requests to switch to v1 or disable v2 are refused without changing the session", async () => {
    const selectV1 = await world.requestV1Selection();
    const disableV2 = await world.requestV1Selection(true);
    for (const response of [selectV1, disableV2]) {
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "engine_v1_retired" });
    }
    const status = await world.status();
    expect(status.running).toBe(true);
    expect(status.chatRouting).toBe(true);
    expect(status.pid).toBe(enginePid);
    await user.see({ text: retiredV1SessionTitle });
    await user.see("composer", { editable: true });
    evidence.recordAssertionEvidence("Both manual fallback requests return engine_v1_retired and the v2 process stays healthy", JSON.stringify({ selectV1, disableV2, status }), selectV1.status === 409 && disableV2.status === 409 && status.running && status.chatRouting && status.pid === enginePid);
    await user.screenshot();
  });

  await step("the web command palette has no engine switch actions or retired settings destination", async () => {
    // The app accepts either OS's command modifier; both make this portable
    // between local macOS Chrome and Linux CI without reading browser internals.
    await user.press("Control+Meta+k");
    await user.type({ role: "combobox" }, "OpenCode");
    await user.notSee({ role: "option", label: /Switch to OpenCode|Migrate chats to OpenCode/ }, { timeoutMs: 500 });
    await user.type({ role: "combobox" }, "Experimental engine", { replace: true });
    await user.notSee({ role: "option", label: /Experimental engine/ }, { timeoutMs: 500 });
    const options = await probe.dom('[role="option"]');
    const retiredDestination = options.elements.some(option => /Experimental engine|Switch to OpenCode|Migrate chats/.test(option.text));
    expect(retiredDestination).toBe(false);
    evidence.recordAssertionEvidence("Searching the web palette exposes no retired engine action or destination", JSON.stringify({ query: "Experimental engine", options: options.elements.map(option => option.text) }), !retiredDestination);
    await user.screenshot();
  });

  await step("real Advanced settings show runtime health without an engine migration section", async () => {
    await user.type({ role: "combobox" }, "Advanced settings", { replace: true });
    await user.click({ role: "option", label: /^Advanced settings/ });
    await user.see({ text: "Organization server" });
    await user.notSee({ text: "Experimental engine" }, { timeoutMs: 500 });
    await noMigrationUi();
    const text = await probe.text();
    expect(text).not.toMatch(/Migrate chats to OpenCode|Switch to OpenCode/);
    evidence.recordAssertionEvidence("Advanced settings contain runtime health and no retired migration controls", `Organization server present; retired engine controls absent; v2 process ${enginePid}.`, text.includes("Organization server") && !/Experimental engine|Migrate chats to OpenCode|Switch to OpenCode/.test(text));
    await user.screenshot();
  });
});
