import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { desktopUpdateCheckNowWorld } from "../worlds/desktop-update-check-now.ts";

const test = spec.world(desktopUpdateCheckNowWorld, {
  resources: { surfaces: ["desktop"], services: [], nativeReason: "The Electron renderer owns Settings updates and the unchanged titlebar restart capsule." },
  needs: { placement: "local" },
  timeout: 180_000,
});

const staged = "0.18.47-alpha.2962";
const newer = "0.18.47-alpha.2966";
const downloadLabel = `Download v${newer} (123 MB)`;

for (const replaceStaged of [false, true]) {
  test(replaceStaged
    ? "Settings explicitly downloads B before replacing staged A; the titlebar still confirms restart"
    : "Settings Check now discovers B without replacing A or changing its restart capsule", async ({ world, user, probe, evidence }) => {
    await world.openSettings();
    await user.click({ role: "combobox", label: "Release channel" });
    await user.click({ role: "option", label: "Alpha" });
    await probe.eventually(world.snapshot, { within: 10_000, label: "the renderer selects Alpha", until: (value) => value.channel === "alpha" && value.checks.at(-1)?.channel === "alpha" });
    await user.see({ text: "You're up to date" });
    await world.publishInitial();
    await user.click({ role: "button", text: "Check now" });
    await probe.eventually(world.snapshot, { within: 10_000, label: "the initial release downloads", until: (value) => value.downloads.length === 1 });
    await world.finishDownload();
    await user.see({ text: `Ready to install: v${staged}` });
    await user.see({ text: "Restart to update" });
    const ready = await world.snapshot();
    expect(ready).toMatchObject({ stagedVersion: staged, downloads: [staged], installs: [], automaticChecksEnabled: true, automaticDownloadsEnabled: true, capsuleText: "Restart to update", updateInSidebar: false });

    await user.click("Restart to update");
    await user.see({ text: "Restart OpenWork?" });
    await user.see({ text: /Eligible running tasks resume gradually after restart/ });
    const panel = (await world.snapshot()).panelText;
    expect(panel).toContain("Keep working");
    expect(panel).toContain("Restart & update");
    await user.click("Keep working");
    await user.notSee({ text: "Restart OpenWork?" });
    await world.advanceFeed();
    await world.triggerAutomaticChecks();
    const quietUntil = Date.now() + 750;
    await probe.eventually(async () => {
      expect(await world.snapshot()).toMatchObject({ checks: ready.checks, downloads: [staged], stagedVersion: staged, installs: [] });
      return Date.now() >= quietUntil;
    }, { within: 5_000, label: "automatic timer, focus, online and visibility leave ready A alone", until: Boolean });

    await user.click({ role: "button", text: "Check now" });
    await user.see({ text: downloadLabel });
    await user.see({ text: `Ready to install: v${staged}` });
    await user.notSee({ text: `Install v${newer} & restart` });
    const discovered = await world.snapshot();
    expect(discovered.checks).toHaveLength(ready.checks.length + 1);
    expect(discovered.checks.at(-1)).toMatchObject({ channel: "alpha", preserveStaged: true });
    expect(discovered).toMatchObject({ downloads: [staged], stagedVersion: staged, installs: [], capsuleText: "Restart to update", updateInSidebar: false });
    expect(discovered.settingsActions).toEqual([
      { text: `Install v${staged} & restart`, disabled: false, primary: true, secondary: false },
      { text: downloadLabel, disabled: false, primary: false, secondary: true },
    ]);
    await world.triggerAutomaticChecks();
    const candidateQuietUntil = Date.now() + 750;
    await probe.eventually(async () => {
      expect(await world.snapshot()).toMatchObject({ checks: discovered.checks, downloads: [staged], stagedVersion: staged, installs: [] });
      return Date.now() >= candidateQuietUntil;
    }, { within: 5_000, label: "automatic checks cannot download the discovered candidate", until: Boolean });
    await user.click("Restart to update");
    await user.see({ text: "Restart OpenWork?" });
    expect((await world.snapshot()).panelText).toBe(panel);
    await user.click("Keep working");
    await user.notSee({ text: "Restart OpenWork?" });
    expect((await world.snapshot()).installs).toEqual([]);
    evidence.recordAssertionEvidence(
      "Manual Alpha discovery preserves A, offers explicit B, and leaves the titlebar panel and background checks unchanged",
      JSON.stringify({ ready, discovered, unchangedPanel: panel }),
      true,
    );

    if (!replaceStaged) {
      await user.click({ role: "button", text: `Install v${staged} & restart` });
      await probe.eventually(world.snapshot, { within: 10_000, label: "Settings installs A, not the discovered B", until: (value) => value.installs.length === 1 });
      const installed = await world.snapshot();
      expect(installed).toMatchObject({ checks: discovered.checks, downloads: [staged], installs: [staged] });
      evidence.recordAssertionEvidence("Settings still installs staged A without downloading B (fake installer)", JSON.stringify(installed), true);
      return;
    }

    await user.click({ role: "button", text: downloadLabel });
    await probe.eventually(world.snapshot, { within: 10_000, label: "only the explicit Download action starts B", until: (value) => value.downloads.length === 2 });
    await user.notSee({ text: `Install v${staged} & restart` });
    await user.notSee({ text: "Restart to update" });
    expect(await world.snapshot()).toMatchObject({ downloads: [staged, newer], stagedVersion: null, installs: [] });
    await world.finishDownload();
    await user.see({ text: `Ready to install: v${newer}` });
    await user.see({ text: `Install v${newer} & restart` });
    await user.notSee({ text: downloadLabel });
    await world.triggerAutomaticChecks();
    const replacementQuietUntil = Date.now() + 750;
    await probe.eventually(async () => {
      expect(await world.snapshot()).toMatchObject({ checks: discovered.checks, downloads: [staged, newer], stagedVersion: newer, installs: [] });
      return Date.now() >= replacementQuietUntil;
    }, { within: 5_000, label: "automatic checks also leave ready B alone", until: Boolean });
    await world.openWorkspace();
    await user.see({ text: "Restart to update" });
    expect(await world.snapshot()).toMatchObject({ checks: discovered.checks, downloads: [staged, newer], stagedVersion: newer, installs: [], capsuleText: "Restart to update", updateInSidebar: false });
    await user.click("Restart to update");
    await user.see({ text: "Restart OpenWork?" });
    expect((await world.snapshot()).panelText).toBe(panel);
    expect((await world.snapshot()).installs).toEqual([]);
    await user.click("Restart & update");
    await probe.eventually(world.snapshot, { within: 10_000, label: "the unchanged titlebar confirmation installs B", until: (value) => value.installs.length === 1 });
    const installed = await world.snapshot();
    expect(installed).toMatchObject({ checks: discovered.checks, downloads: [staged, newer], installs: [newer] });
    evidence.recordAssertionEvidence("Explicit Download replaces A with B; unchanged titlebar confirmation installs B (fake installer)", JSON.stringify(installed), true);
  });
}
