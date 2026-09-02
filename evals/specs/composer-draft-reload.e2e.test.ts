import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { emptySession } from "../worlds/desktop.ts";

const test = spec.world(emptySession);

test("reloading a session with a persisted composer draft keeps the renderer stable", async ({ user, probe, step }) => {
  const draft = "Keep this persisted draft through reload";
  await user.type("composer", draft);
  const revision = await probe.storage("openwork.session-drafts.v2", (value) => {
    if (typeof value !== "object" || value === null || !("nextRevision" in value)) return undefined;
    return value.nextRevision;
  });
  await step("draft survives three reloads", async () => {
    for (let reload = 1; reload <= 3; reload += 1) {
      await user.reload();
      await user.see("composer", { editable: true, text: draft });
    }
  });
  expect(await probe.storage("openwork.session-drafts.v2", (value) => {
    if (typeof value !== "object" || value === null || !("nextRevision" in value)) return undefined;
    return value.nextRevision;
  })).toBe(revision);
});
