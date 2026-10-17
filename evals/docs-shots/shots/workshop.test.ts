import assert from "node:assert/strict";
import test from "node:test";
import { documentationShots, shots } from "./index.ts";
import { createWorkshopShotContext, parseWorkshopAttachment, workshopShots, workshopStateHash, WORKSHOP_SHOT_IDS } from "./workshop.ts";

const frame = {
  cdpUrl: "http://127.0.0.1:9222", url: "http://127.0.0.1:3992/jira/browse/ITSD-17",
  expect: ["Reset a password", "Windows login"], never: ["Request failed"], route: "/jira/browse/ITSD-17$",
};
const manifest = (entry: unknown = frame) => ({ organization: "Acme Robotics", fictional: true, frames: { "workshop-t07-final": entry } });

test("all workshop scenes are discoverable without provisioning and have unique private outputs", () => {
  assert.equal(workshopShots.length, 16);
  assert.equal(new Set(workshopShots.map((shot) => shot.id)).size, WORKSHOP_SHOT_IDS.length);
  assert.ok(workshopShots.every((shot) => shot.out.startsWith("evals/results/workshop-docshots/")));
  assert.ok(!documentationShots.some((shot) => shot.id.startsWith("workshop-")));
  assert.deepEqual(shots, documentationShots); // No attached world in the default docs run.
});

test("CLI accepts only explicit fictional loopback attachments and nonempty object gates", () => {
  assert.deepEqual(parseWorkshopAttachment(manifest(), "workshop-t07-final"), frame);
  assert.throws(() => parseWorkshopAttachment({ ...manifest(), fictional: false }, "workshop-t07-final"), /fictional/);
  assert.throws(() => parseWorkshopAttachment(manifest({ ...frame, url: "https://example.com/jira" }), "workshop-t07-final"), /loopback/);
  assert.throws(() => parseWorkshopAttachment(manifest({ ...frame, cdpUrl: "http://user:secret@localhost:9222" }), "workshop-t07-final"), /loopback/);
  assert.throws(() => parseWorkshopAttachment(manifest({ ...frame, expect: [] }), "workshop-t07-final"), /object-specific/);
  assert.throws(() => parseWorkshopAttachment(manifest({ ...frame, route: "" }), "workshop-t07-final"), /route gate/);
  assert.throws(() => parseWorkshopAttachment(manifest(), "workshop-t06-final"), /record/);
});

test("semantic business-state hashes ignore object order, not changed facts or array order", () => {
  assert.equal(workshopStateHash({ issues: [{ id: "ITSD-17", application: "Windows login" }], files: [] }), workshopStateHash({ files: [], issues: [{ application: "Windows login", id: "ITSD-17" }] }));
  assert.notEqual(workshopStateHash({ application: "Windows login" }), workshopStateHash({ application: "" }));
  assert.notEqual(workshopStateHash([1, 2]), workshopStateHash([2, 1]));
  assert.throws(() => workshopStateHash(undefined), /JSON business state/);
});

test("native adapter rejects unscoped output and CLI refuses to provision a missing world", async () => {
  assert.throws(() => createWorkshopShotContext({ directory: "packages/docs/images", readState: async () => ({}), assertSafe: async () => undefined }), /named run/);
  const context = createWorkshopShotContext({ directory: "evals/results/workshop-docshots/unit-only", readState: async () => ({ issues: [] }), assertSafe: async () => undefined });
  // Rejection occurs before touching a CDP surface: no fake browser or DocShot is used.
  const shot = workshopShots.find((entry) => entry.id === "workshop-after-regression");
  assert.ok(shot);
  await assert.rejects(shot.run(new (await import("../ctx.ts")).Ctx()), /OPENWORK_WORKSHOP_DOCSHOT_INPUT/);
  await context.dispose();
});
