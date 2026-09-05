import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { backgroundUpdateWorld } from "../worlds/first-run.ts";

const test = spec.world(backgroundUpdateWorld);

test("updates download outside Settings and offer a persistent, optional restart", async ({ world, user, probe }) => {
  await probe.eventually(world.snapshot, {
    within: 15_000, label: "background download without opening Settings",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "downloads") === 1,
  });
  expect(await world.snapshot()).toMatchObject({ checks: 1, downloads: 1, installs: 0, sidebarName: "OpenWork" });
  await user.notSee({ text: "Update ready" });
  await world.returnToApp();
  expect(await world.snapshot()).toMatchObject({ checks: 1, downloads: 1, installs: 0 });
  await world.finishDownload();
  await user.see({ text: "Update ready" });
  await user.notSee({ text: "Ready when you are." });
  await world.openSettings();
  await user.see({ text: "Update ready" });
  await world.openWorkspace();
  await world.returnToApp();
  await user.see({ text: "Update ready" });
  expect(await world.snapshot()).toMatchObject({ checks: 1, downloads: 1, installs: 0, updateInTitlebar: true, updateInSidebar: false });
  await user.looks([
    "A small sage Update ready capsule is in the titlebar, and the OpenWork name is above the sidebar navigation",
    "No update banner covers or reduces the workspace",
  ]);
  await user.click("Update ready");
  await user.see({ text: "Ready when you are." });
  await user.see({ text: "Downloaded and ready to install" });
  await user.looks([
    "The update panel is aligned below the capsule with the heading Ready when you are., a dark Restart OpenWork button, and a quieter Later action",
  ]);
  await user.click("Later");
  await user.notSee({ text: "Ready when you are." });
  await user.see({ text: "Update ready" });
  expect(await world.snapshot()).toMatchObject({ installs: 0 });
  await user.click("Update ready");
  await user.click("Restart OpenWork");
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
  await user.click("Update ready");
  await user.see({ text: "Restart Studio" });
  await user.notSee({ text: "Restart OpenWork" });
  await user.click("Restart Studio");
  await user.see({ text: "Restart Studio?" });
  await user.click("Restart & update");
  await probe.eventually(world.snapshot, {
    within: 5_000, label: "restart only after confirmation",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "installs") === 1,
  });
});
