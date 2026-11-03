import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { pinDurability } from "../worlds/pin-durability.ts";

const test = spec.world(pinDurability, {
  timeout: 420_000,
  resources: { surfaces: ["desktop"], services: [], nativeReason: "Pins must survive Electron quit and process death on the same profile and renderer origin." },
});

for (const scenario of ["quit", "busy", "kill", "read", "corrupt", "unavailable"] as const) {
  test(`a member keeps pinned conversations after ${scenario}`, async ({ world, user, step, evidence }) => {
    const expected = world.sessions.slice(0, 2).map(session => session.sessionId);
    let before: Awaited<ReturnType<typeof world.snapshot>>;
    await step("given: two conversations are pinned and a third is not", async () => {
      await user.see({ text: "Pinned", exact: true });
      before = await world.snapshot();
      expect(before.pins).toEqual(expected);
      evidence.recordAssertionEvidence("Two pins are present before the fault", JSON.stringify(before), true);
    });
    await step(`when: the isolated desktop encounters ${scenario}`, async () => {
      if (scenario === "quit" || scenario === "busy" || scenario === "kill") await world.restart(scenario);
      else await world.fault(scenario);
      const after = await world.snapshot();
      evidence.recordAssertionEvidence("The same profile retains both pins without pinning the third conversation", JSON.stringify({ before, after }), JSON.stringify(after.pins) === JSON.stringify(expected));
      expect(after.origin).toBe(before.origin);
      expect(after.pins).toEqual(expected);
      expect(after.pins).not.toContain(world.sessions[2]?.sessionId);
      if (scenario === "read") expect(after.key).toBe(before.key);
      if (scenario === "corrupt") expect(after.key).toBe("{broken");
    });
    await step("after: both pinned conversations remain available in the sidebar", async () => {
      if (scenario !== "unavailable") {
        await user.on(world.app).see({ text: "Pinned", exact: true });
        await user.on(world.app).see({ text: "Durable pin 1", exact: true });
        await user.on(world.app).see({ text: "Durable pin 2", exact: true });
      }
      evidence.recordAssertionEvidence("No stored pin is pruned by missing session inventory", JSON.stringify(await world.snapshot()), true);
      if (scenario !== "unavailable") await user.on(world.app).looks(["The OpenWork sidebar shows a Pinned section containing Durable pin 1 and Durable pin 2."]);
    });
  });
}
