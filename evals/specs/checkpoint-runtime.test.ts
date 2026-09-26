import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { checkpointCapability, spec } from "@openwork/testkit";
import type { CheckpointCapability, Surface } from "@openwork/testkit";

// Exercises the testkit wiring with a synthetic world: which calls save a
// checkpoint, the end state of tagged tests, and the warning when a world
// cannot capture. The capture rule itself is covered in evidence-checkpoint.test.ts.
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
/** Every capture, by world label; lets a later test see an earlier test's end state. */
const captureLog: string[] = [];

function surface(name: string): Surface {
  return { handle: { kind: "chrome", hostKind: "synthetic", name, cdpUrl: "http://127.0.0.1:1" }, client: {
    close() {}, async send(method) {
      if (method === "Page.captureScreenshot") return { data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") };
      if (method === "Runtime.evaluate") return { result: { value: { route: "/", visibleText: "synthetic world" } } };
      return {};
    },
  } };
}

function capableWorld(label: string) {
  const app = surface("capable-app");
  let captured = 0;
  const capability: CheckpointCapability = {
    surface: app, available: () => true,
    async capture({ imageHash }) {
      captured++;
      captureLog.push(label);
      return { saved: Promise.resolve(), checkpoint: { version: 1, provider: "freestyle", id: `ow-evidence-v1-${String(captured).padStart(32, "0")}`,
        sourceSha, imageHash, capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() } };
    },
  };
  return { app, other: surface("other-surface"), [checkpointCapability]: capability, captures: () => captured };
}

const capable = spec.world(async () => capableWorld("capable"));
const tagged = spec.world(async () => capableWorld("tagged"));
const taggedIdle = spec.world(async () => capableWorld("tagged-idle"));
const plain = spec.world(async () => ({ app: surface("plain-app") }));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.OPENWORK_EVIDENCE_CHECKPOINTS = "1";
  process.env.OPENWORK_EVIDENCE_CHECKPOINT_HOLD_MS = "1";
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env.OPENWORK_EVIDENCE_CHECKPOINTS;
  delete process.env.OPENWORK_EVIDENCE_CHECKPOINT_HOLD_MS;
  warn.mockRestore();
});

capable("a marked step saves one checkpoint captioned with the step", async ({ world, user, step }) => {
  await step("Saved sessions", async () => { await user.screenshot(); }, { checkpoint: true });
  await step("Unmarked step", async () => { await user.screenshot(); });
  expect(world.captures()).toBe(1);
  const picture = await user.checkpoint("Explicit moment");
  expect(picture?.checkpoint?.sourceSha).toBe(sourceSha);
  expect(picture?.checkpointMatch).toBe("exact");
  expect(world.captures()).toBe(2);
});

capable("only the world's own surface can be checkpointed", async ({ world, user }) => {
  expect(await user.on(world.other).checkpoint()).toBeUndefined();
  expect(world.captures()).toBe(0);
  expect(warn).toHaveBeenCalledTimes(1);
});

tagged("tagged tests keep their end state", { tags: ["checkpoints"] }, async ({ world, user }) => {
  await user.screenshot();
  expect(world.captures()).toBe(0); // Saved after the body passes.
});

taggedIdle("a tagged test that just checkpointed does not save the same state twice", { tags: ["checkpoints"] }, async ({ user }) => {
  await user.screenshot();
  await user.checkpoint("Last moment");
});

capable("end states were saved after the tagged tests above passed", async () => {
  expect(captureLog.filter((label) => label === "tagged")).toHaveLength(1);
  expect(captureLog.filter((label) => label === "tagged-idle")).toHaveLength(1);
});

capable("nothing is saved unless the run asked for checkpoints", async ({ world, user, step }) => {
  delete process.env.OPENWORK_EVIDENCE_CHECKPOINTS;
  await step("Marked but not requested", async () => { await user.screenshot(); }, { checkpoint: true });
  expect(await user.checkpoint()).toBeUndefined();
  expect(world.captures()).toBe(0);
  expect(warn).not.toHaveBeenCalled();
});

plain("a world that cannot capture warns once and the test runs normally", async ({ user, step }) => {
  await step("Marked", async () => { await user.screenshot(); }, { checkpoint: true });
  expect(await user.checkpoint()).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("Checkpoints skipped");
});
