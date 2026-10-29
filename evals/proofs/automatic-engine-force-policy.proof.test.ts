import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { automaticEngineForcePolicy, retainedHistoryText } from "../worlds/automatic-engine-force-policy.ts";

const test = spec.world(automaticEngineForcePolicy, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { commands: ["bun"] },
});

test("a member's existing v1 chat migrates by default and an old policy opt-out cannot revert it", async ({ world, user, probe, step, evidence }) => {
  async function noUpgradeUi() {
    for (const testId of ["engine-migration-consent", "engine-migration-banner", "engine-migration-progress", "engine-switch-prompt"]) {
      await user.notSee({ testId });
    }
  }
  await step("before: a real v1 engine saved the member's project note before OpenWork started", async () => {
    expect(world.source.messages).toContain(retainedHistoryText);
    evidence.recordAssertionEvidence("The source engine persisted the original chat before the host booted", JSON.stringify(world.source), world.source.messages.includes(retainedHistoryText));
  });

  await step("after: the member reads that same chat on v2 without Den, an opt-in, or an upgrade notice", async () => {
    const status = await probe.eventually(() => world.status(), {
      within: 120_000,
      label: "the default host copies the existing v1 chat to the real v2 engine",
      until: value => value.chatRouting && value.running && value.migration.state === "completed",
    });
    expect(status.version).toBe(world.engineVersions.v2);
    expect(status.migration.imported).toBe(1);
    expect(status.migration.total).toBe(1);
    expect(status.migration.backupPath).toBeTruthy();
    expect(await world.messages()).toContain(retainedHistoryText);
    await user.reload();
    await user.see({ text: retainedHistoryText });
    await noUpgradeUi();
    evidence.recordAssertionEvidence("Default migration serves the original chat on v2 and retains a backup", JSON.stringify(status), status.chatRouting && status.running && status.migration.imported === 1 && Boolean(status.migration.backupPath));
    await user.screenshot();
  });

  await step("an older client's policy-off message cannot return the member to v1 or hide their chat", async () => {
    await world.sendLegacyOptOut();
    const status = await world.status();
    expect(status.chatRouting).toBe(true);
    expect(status.running).toBe(true);
    expect(status.engineOrigin).not.toBe("reverted");
    expect(status.migration.state).toBe("completed");
    expect(await world.messages()).toContain(retainedHistoryText);
    await user.reload();
    await user.see({ text: retainedHistoryText });
    await noUpgradeUi();
    const afterReload = await world.status();
    expect(afterReload.chatRouting).toBe(true);
    expect(afterReload.engineOrigin).not.toBe("reverted");
    evidence.recordAssertionEvidence("Legacy upgrade:false leaves the migrated chat on the healthy v2 engine", JSON.stringify(afterReload), afterReload.chatRouting && afterReload.running && afterReload.engineOrigin !== "reverted");
    await user.screenshot();
  });
});
