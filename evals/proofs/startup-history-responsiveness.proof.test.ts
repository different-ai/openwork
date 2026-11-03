import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { startupHistoryResponsiveness } from "../worlds/startup-history-responsiveness.ts";

const test = spec.world(startupHistoryResponsiveness, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["desktop"], services: [], nativeReason: "The embedded server and history preparation share Electron main, which a headless browser host cannot reproduce." },
});

test("a member can keep using the desktop while large v1 history is checked and safely copied", async ({ world, user, probe, step, evidence }) => {
  await step("given hundreds of retained conversations with oversized synthetic payloads", async () => {
    await user.screenshot();
    const observed = world.fixture;
    evidence.recordAssertionEvidence("Large synthetic history is present before desktop launch", JSON.stringify(observed), observed.sessions === 320 && observed.largePayloadMiB === 64);
    expect(observed.sessions).toBe(320);
  });
  await step("the desktop and its status API remain responsive during history preparation", async () => {
    const status = await world.status();
    await user.screenshot();
    evidence.recordAssertionEvidence("The embedded status API answers without blocking the desktop", `HTTP ${status.http}, ${status.apiMs.toFixed(1)} ms`, status.http === 200 && status.apiMs < 250);
    expect(status.http).toBe(200);
    expect(status.apiMs).toBeLessThan(250);
  });
  await step("after every exact freshness check the unchanged history switches only after its copy completes", async () => {
    const status = await probe.eventually(() => world.status(), { within: 360_000, label: "history copied and v2 selected", until: value => (value.state === "completed" && value.chatRouting) || value.state === "error" });
    const records = (await world.timings()).filter(record => record.phase === "completed");
    const revisions = records.filter(record => record.operation === "revision");
    const maxLag = Math.max(...records.map(record => record.hostMaxLagMs));
    const stalls = records.reduce((total, record) => total + record.hostStalls250ms, 0);
    const ok = status.chatRouting && status.imported === 320 && status.total === 320 && revisions.length >= 5 && maxLag < 250 && stalls === 0;
    evidence.recordAssertionEvidence("All freshness passes stay below 250 ms and all conversations are copied before switching", `imported=${status.imported}/${status.total}; revisions=${revisions.length}; max host lag=${maxLag} ms; stalls=${stalls}`, ok);
    await user.screenshot();
    expect(ok).toBe(true);
  });
});
