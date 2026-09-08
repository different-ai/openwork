import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appSmokeWorld } from "../worlds/first-run.ts";

const test = spec.world(appSmokeWorld);

test("app boots with a control route and meaningful visible content", async ({ world, user, probe, evidence }) => {
  expect(await probe.hash()).toBeTruthy();
  expect((await probe.text()).trim().length).toBeGreaterThan(40);
  if (world.packaged) {
    await user.see("composer", { editable: true, text: "" });
    expect(await world.packagedRuntime()).toEqual({
      bridge: true, protocol: "file:", health: 200, emptySession: true, signedOut: true, onboarding: false, crash: false,
    });
    await user.see("Run task");
    const workspaceId = /^#\/workspace\/([^/]+)\/session$/.exec(await probe.hash())?.[1];
    if (!workspaceId) throw new Error("The packaged app did not open its empty workspace route.");
    const sessions = await probe.desktopApi(`/workspace/${workspaceId}/opencode/session`);
    expect(sessions.status).toBe(200);
    expect(sessions.body).toEqual([]);
    const tools = await world.packagedToolIds();
    expect(tools).toEqual(expect.arrayContaining(["openwork_docs_search", "openwork_query"]));
    evidence.recordAssertionEvidence(
      "The packaged engine loads OpenWork Connect canary tools",
      "The automatically selected default workspace exposes openwork_docs_search and openwork_query through the real engine tool registry without test-driven workspace creation or engine startup. The engine resolves the shipped plugins outside app.asar without repository dependencies.",
      true,
    );
    evidence.recordAssertionEvidence(
      "The packaged desktop loads its renderer, preload bridge, and embedded server without a development server",
      "The installed-layout binary opened an empty editable session through file: assets, signed out and without onboarding gates or a blank session. A preload IPC round trip returned its embedded server endpoint and HTTP health returned 200. No crash screen was present. The host used a fresh isolated profile.",
      true,
    );
  } else {
    expect(world.workspace?.workspaceId).toBeTruthy();
    await user.looks([
      "A ready OpenWork workspace composer with meaningful visible content is on screen",
      "No generic error or 'Something went wrong' crash message is visible",
    ]);
  }
});
