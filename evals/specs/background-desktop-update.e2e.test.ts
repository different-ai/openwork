import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { backgroundUpdateWorld } from "../worlds/first-run.ts";

const test = spec.world(backgroundUpdateWorld);

test("updates download outside Settings and offer a persistent, optional restart", async ({ world, user, probe }) => {
  await probe.eventually(world.snapshot, {
    within: 15_000, label: "initial background check finds no update",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "checks") === 2,
  });
  expect(await world.snapshot()).toMatchObject({ checks: 2, downloads: 0 });
  await world.returnToApp();
  await probe.eventually(world.snapshot, {
    within: 5_000, label: "return after the interval checks again while idle",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "checks") === 3,
  });
  await world.tickUpdateInterval();
  await probe.eventually(world.snapshot, {
    within: 15_000, label: "background download without opening Settings",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "downloads") === 1,
  });
  expect(await world.snapshot()).toMatchObject({ checks: 4, downloads: 1, installs: 0, sidebarName: "OpenWork" });
  await user.notSee({ text: "Restart to update" });
  await world.returnToApp();
  expect(await world.snapshot()).toMatchObject({ checks: 4, downloads: 1, installs: 0 });
  await world.finishDownload();
  await user.see({ text: "Restart to update" });
  await user.notSee({ text: "Ready when you are." });
  await world.openSettings();
  await user.see({ text: "Restart to update" });
  await world.openWorkspace();
  await world.returnToApp();
  await user.see({ text: "Restart to update" });
  expect(await world.snapshot()).toMatchObject({ checks: 4, downloads: 1, installs: 0, updateInTitlebar: true, updateInSidebar: false });
  await user.looks([
    "A compact neutral Restart to update button sits in the titlebar with the app's other controls",
    "The OpenWork name remains above the sidebar navigation and no update card or banner covers the workspace",
  ]);
  await user.click("Restart to update");
  await user.notSee({ text: "Ready when you are." });
  await user.see({ text: "Restart OpenWork?" });
  await user.click("Keep working");
  await user.notSee({ text: "Restart OpenWork?" });
  expect(await world.snapshot()).toMatchObject({ installs: 0 });

  await world.setCustomBranding();
  await probe.eventually(world.snapshot, {
    within: 5_000, label: "custom logo is preserved instead of the default wordmark",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "customLogoLoaded") === true,
  });
  expect(await world.snapshot()).toMatchObject({ sidebarName: null, customLogoLoaded: true });
  await user.click("Restart to update");
  await user.see({ text: "Restart Studio?" });
  await user.click("Restart & update");
  await probe.eventually(world.snapshot, {
    within: 5_000, label: "restart only after confirmation",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "installs") === 1,
  });
});
