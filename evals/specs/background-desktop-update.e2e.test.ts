import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { backgroundUpdateWorld } from "../worlds/first-run.ts";

const test = spec.world(backgroundUpdateWorld);

test("updates download outside Settings and offer a persistent, optional restart", async ({ world, user, probe }) => {
  await probe.eventually(world.snapshot, {
    within: 15_000, label: "background download without opening Settings",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "downloads") === 1,
  });
  expect(await world.snapshot()).toMatchObject({ checks: 1, downloads: 1, installs: 0 });
  await user.notSee({ text: "Restart to update" });
  await world.returnToApp();
  expect(await world.snapshot()).toMatchObject({ checks: 1, downloads: 1, installs: 0 });
  await world.finishDownload();
  await user.see({ text: "Restart to update" });
  await world.openSettings();
  await user.see({ text: "Restart to update" });
  await world.openWorkspace();
  await world.returnToApp();
  await user.see({ text: "Restart to update" });
  expect(await world.snapshot()).toMatchObject({ checks: 1, downloads: 1, installs: 0 });
  expect(await world.snapshot()).toMatchObject({ updateInSidebar: true });
  await user.click("Restart to update");
  await user.see({ text: "Restart to update?" });
  await user.click("Cancel");
  await user.notSee({ text: "Restart to update?" });
  expect(await world.snapshot()).toMatchObject({ installs: 0 });
  await user.see({ text: "Restart to update" });
  await user.looks([
    "A quiet Restart to update action appears in the sidebar above the account menu; there is no banner below the workspace",
    "The workspace remains usable and no restart dialog is open",
  ]);
  await user.click("Restart to update");
  await user.click("Install & restart");
  await probe.eventually(world.snapshot, {
    within: 5_000, label: "restart only after confirmation",
    until: (value) => typeof value === "object" && value !== null && Reflect.get(value, "installs") === 1,
  });
});
