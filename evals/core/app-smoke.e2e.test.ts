import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appSmokeWorld } from "../worlds/first-run.ts";

const test = spec.world(appSmokeWorld);

test("app boots with a control route and meaningful visible content", async ({ world, user, probe }) => {
  expect(await probe.hash()).toBeTruthy();
  expect((await probe.text()).trim().length).toBeGreaterThan(40);
  if (world.packaged) {
    await probe.eventually(() => probe.hash(), {
      within: 30_000,
      label: "packaged startup selects its empty workspace route",
      until: (hash) => /^#\/workspace\/[^/]+\/session$/.test(hash),
    });
    await user.see("composer", { editable: true, text: "" });
    const expectedRuntime = {
      bridge: true, protocol: "file:", health: 200, emptySession: true, signedOut: true, onboarding: false, crash: false,
    };
    // The renderer can remount while the asynchronous IPC/health probe runs.
    // Wait for one coherent ready snapshot instead of combining observations
    // from different startup frames. Keep every positive and negative condition.
    const runtime = await probe.eventually(() => world.packagedRuntime(), {
      within: 30_000,
      label: "packaged renderer, bridge and server are ready together",
      until: (value) => typeof value === "object" && value !== null
        && Object.entries(expectedRuntime).every(([key, expected]) => Reflect.get(value, key) === expected),
    });
    expect(runtime).toEqual(expectedRuntime);
    await user.see("composer", { editable: true, text: "" });
    await user.see("Run task");
    const workspaceId = /^#\/workspace\/([^/]+)\/session$/.exec(await probe.hash())?.[1];
    if (!workspaceId) throw new Error("The packaged app did not open its empty workspace route.");
    const sessions = await probe.desktopApi(`/workspace/${workspaceId}/opencode2/api/session`);
    expect(sessions.status).toBe(200);
    expect(sessions.body).toMatchObject({ data: [] });
    const plugins = await probe.eventually(() => world.packagedPlugins(), {
      within: 60_000, label: "the packaged context plugin is active",
      until: plugins => plugins.some(plugin => plugin.id === "openwork.context" && plugin.status === "active"),
    });
    expect(plugins).toEqual(expect.arrayContaining([{ id: "openwork.context", status: "active" }]));
  } else {
    expect(world.workspace?.workspaceId).toBeTruthy();
    await user.looks([
      "A ready OpenWork workspace composer with meaningful visible content is on screen",
      "No generic error or 'Something went wrong' crash message is visible",
    ]);
  }
});
