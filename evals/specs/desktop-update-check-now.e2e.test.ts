import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { desktopUpdateCheckNowWorld } from "../worlds/desktop-update-check-now.ts";

const test = spec.world(desktopUpdateCheckNowWorld, {
  resources: { surfaces: ["desktop"], services: [], nativeReason: "The Electron renderer owns Settings updates and the unchanged titlebar restart capsule." },
  needs: { placement: "local" },
  timeout: 180_000,
});

type UpdateLayout = Awaited<ReturnType<Awaited<ReturnType<typeof desktopUpdateCheckNowWorld>>["layout"]>>;

function geometry(layout: UpdateLayout) {
  return {
    versions: layout.versions,
    actions: layout.actions,
    values: layout.values.map(({ x, y, width, height }) => ({ x, y, width, height })),
    buttons: layout.buttons.map(({ x, y, width, height }) => ({ x, y, width, height })),
  };
}

function expectReadableControls(layout: UpdateLayout) {
  expect(layout.fits).toBe(true);
  expect(layout.values.every((value) => value.fits)).toBe(true);
  expect(layout.buttons.map((button) => button.text)).toEqual(["Check now", "Download", "Install & restart"]);
  expect(layout.buttons.every((button) => button.x >= 0 && button.x + button.width <= layout.viewportWidth)).toBe(true);
  expect(layout.actions.x + layout.actions.width).toBeCloseTo(layout.versions.x + layout.versions.width, 1);
  expect(layout.status.x + layout.status.width).toBeLessThanOrEqual(layout.actions.x);
  expect(layout.status.y).toBeCloseTo(layout.actions.y, 1);
}

for (const replaceStaged of [false, true]) {
  test(replaceStaged
    ? "A desktop user downloads a newer update with a version-free button before restarting"
    : "A desktop user discovers a newer update and can still install the downloaded version", async ({ world, user, probe, evidence, step }) => {
    const { staged, newer, channel } = world.releases;
    await world.openSettings();
    if (channel === "alpha") {
      await user.click({ role: "combobox", label: "Release channel" });
      await user.click({ role: "option", label: "Alpha" });
    }
    // Re-arm the real timer after the world installs its interval witness.
    await user.click({ role: "switch", label: "Check automatically" });
    await user.click({ role: "switch", label: "Check automatically" });
    await user.click({ role: "button", text: "Check now" });
    await user.see({ text: "You're up to date" });
    await step("the downloaded update is ready to install", async () => {
      await world.publishInitial();
      await user.click({ role: "button", text: "Check now" });
      await probe.eventually(world.snapshot, { within: 10_000, label: "the initial release downloads", until: (value) => value.downloads.length === 1 });
      await world.finishDownload();
      await user.see({ text: `Ready to install: v${staged}` });
      await user.see({ text: "Restart to update" });
      await user.screenshot();
    });
    const ready = await world.snapshot();
    const readyLayout = await world.layout();
    expectReadableControls(readyLayout);
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

    const checkingLayout = await step("checking keeps the version rows and plain action buttons in place", async () => {
      await world.holdNextCheck();
      await user.click({ role: "button", text: "Check now" });
      await user.see({ text: "Checking for updates…" });
      await user.see({ text: `Ready to install: v${staged}` });
      const layout = await probe.eventually(world.layout, {
        within: 3_000, label: "checking leaves control bounds unchanged",
        until: (value) => JSON.stringify(geometry(value)) === JSON.stringify(geometry(readyLayout)),
      });
      expectReadableControls(layout);
      expect(layout.buttons.map((button) => button.disabled)).toEqual([true, true, false]);
      expect((await world.snapshot()).latestVersionText).toBe(`v${staged}`);
      await user.screenshot();
      return layout;
    });

    const discoveredLayout = await step("after: Latest version is readable and Download is a plain, stationary action", async () => {
      await world.finishCheck();
      await probe.eventually(world.snapshot, {
        within: 10_000, label: "the newer version is shown separately from the downloaded version",
        until: (value) => value.latestVersionText === `v${newer}`,
      });
      await user.see({ text: "Current version" });
      await user.see({ text: "Latest version" });
      await user.see({ role: "button", text: "Download" });
      await user.see({ text: `Ready to install: v${staged}` });
      await user.notSee({ text: `Release ${newer}` });
      const layout = await world.layout();
      expectReadableControls(layout);
      expect(geometry(layout)).toEqual(geometry(readyLayout));
      expect(layout.buttons.map((button) => button.disabled)).toEqual([true, false, false]);
      await user.screenshot();
      return layout;
    });
    const discovered = await world.snapshot();
    expect(discovered.checks).toHaveLength(ready.checks.length + 1);
    expect(discovered.checks.at(-1)).toMatchObject({ channel, preserveStaged: true });
    if (channel === "stable") expect(discovered.checks.at(-1)?.targetVersion).toBe(newer);
    expect(discovered).toMatchObject({ downloads: [staged], stagedVersion: staged, installs: [], capsuleText: "Restart to update", updateInSidebar: false });
    expect(discovered.settingsActions).toEqual([
      { text: "Download", disabled: false, primary: false, secondary: true },
      { text: "Install & restart", disabled: false, primary: true, secondary: false },
    ]);
    evidence.recordAssertionEvidence(
      "Long version values stay readable and all three action bounds remain unchanged through checking and cooldown",
      JSON.stringify({ readyLayout, checkingLayout, discoveredLayout }),
      true,
    );
    await step("long versions and all three actions fit a narrow desktop window", async () => {
      await world.resize(860);
      await user.see({ text: "Latest version" });
      await user.see({ role: "button", text: "Install & restart" });
      const layout = await world.layout();
      expectReadableControls(layout);
      expect(layout.values.map((value) => value.height)).toEqual(readyLayout.values.map((value) => value.height));
      await user.screenshot();
      evidence.recordAssertionEvidence("Version values remain single-line and the action row stays inside an 860px viewport", JSON.stringify(layout), true);
      await world.resize(1200);
    });
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
      "Manual discovery preserves A, offers explicit B, and leaves the titlebar panel and background checks unchanged",
      JSON.stringify({ ready, discovered, unchangedPanel: panel }),
      true,
    );

    if (!replaceStaged) {
      await step("the already downloaded update remains installable", async () => {
        await user.click({ role: "button", text: "Install & restart" });
        await probe.eventually(world.snapshot, { within: 10_000, label: "Settings installs A, not the discovered B", until: (value) => value.installs.length === 1 });
        const installed = await world.snapshot();
        expect(installed).toMatchObject({ checks: discovered.checks, downloads: [staged], installs: [staged] });
        evidence.recordAssertionEvidence("Settings still installs staged A without downloading B (fake installer)", JSON.stringify(installed), true);
      });
      return;
    }

    await step("Download fetches the newer update and makes it ready to install", async () => {
      await user.click({ role: "button", text: "Download" });
      await probe.eventually(world.snapshot, { within: 10_000, label: "only the explicit Download action starts B", until: (value) => value.downloads.length === 2 });
      await user.notSee({ text: "Restart to update" });
      expect(await world.snapshot()).toMatchObject({ downloads: [staged, newer], stagedVersion: null, installs: [] });
      const downloadingLayout = await world.layout();
      expect(geometry(downloadingLayout)).toEqual(geometry(readyLayout));
      expect(downloadingLayout.buttons.map((button) => button.disabled)).toEqual([true, true, true]);
      await world.finishDownload();
      await user.see({ text: `Ready to install: v${newer}` });
      await user.see({ role: "button", text: "Install & restart" });
      const installedLayout = await world.layout();
      expect(geometry(installedLayout)).toEqual(geometry(readyLayout));
      expect(installedLayout.buttons.map((button) => button.disabled)).toEqual([false, true, false]);
      await user.screenshot();
    });
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
