import { expect } from "vitest";
import {
  SeedBeforeActError,
  renderPrMarkdown,
  spec,
  test,
} from "@openwork/testkit";
import type {
  Surface,
  StepRecord,
  TestRunRecord,
  TestOutcome,
  TraceEntry,
  User,
} from "@openwork/testkit";

const trace: TraceEntry[] = [];
const steps: StepRecord[] = [];
const outcomes: { outcome: TestOutcome; failure?: string }[] = [];
let clickCount = 0;
const cdpCalls: Array<{ method: string; params: Record<string, unknown> }> = [];

const fakeSurface: Surface = {
  handle: {
    name: "fake-app",
    kind: "electron",
    hostKind: "fake",
    cdpUrl: "http://127.0.0.1:1",
  },
  client: {
    async send(method, params = {}) {
      cdpCalls.push({ method, params });
      if (method === "Runtime.evaluate") {
        return params.expression === "globalThis"
          ? { result: { objectId: "fake-global" } }
          : { result: { value: "evaluated" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: {
              center: { x: 50, y: 20 },
              rect: { x: 0, y: 0, width: 100, height: 40 },
              tag: "div",
              name: "composer",
              visible: true,
              hitTestOk: true,
              editable: true,
              value: "",
              text: "Running 1 command, reading 1 file · Keep this draft",
              covering: null,
            },
          },
        };
      }
      return {};
    },
    close() {},
  },
};

const primitiveTest = spec.world(async (seed) => {
  const workspacePath = seed.tmpPath("world-workspace");
  return { app: fakeSurface, workspacePath };
}, {
  adapters: {
    seed: { tmpPath: (label) => `/fake/${label}` },
    user: {
      async click() {
        clickCount += 1;
      },
    },
    probe: { text: async () => "read-only probe" },
    observe: {
      trace: (entry) => trace.push(entry),
      step: (step) => steps.push(step),
      outcome: (outcome, failure) => outcomes.push({ outcome, failure }),
    },
  },
});

primitiveTest("worlds and capability channels preserve provenance and ordering", async ({ world, seed, user, probe, step }) => {
  expect(world.workspacePath).toBe("/fake/world-workspace");
  expect(await probe.text()).toBe("read-only probe");
  expect(typeof seed.denLink).toBe("function");
  expect(typeof probe.connectState).toBe("function");
  expect(() => seed.tmpPath("too-late")).toThrow(SeedBeforeActError);

  await user.click("Run task");
  expect(seed.tmpPath("mid-flow")).toBe("/fake/mid-flow");
  expect(clickCount).toBe(1);
  expect(await seed.evalIn(fakeSurface, "Promise.resolve('seed')", { awaitPromise: true, timeoutMs: 1_000 })).toBe("evaluated");
  expect(await probe.eval("Promise.resolve('probe')", { awaitPromise: true, timeoutMs: 1_000 })).toBe("evaluated");
  await user.see({ text: /Running 1 command, reading 1 file/ });
  await user.see("composer", { editable: true, text: /Keep this draft/ });
  await user.type("composer", "Replacement text", { replace: true });

  await expect(step("failing step", () => {
    throw new Error("expected step failure");
  })).rejects.toThrow("expected step failure");
  await expect(step("later step", () => "not run")).rejects.toThrow("not reached");

  expect(trace[0]).toMatchObject({ seq: 1, stage: "body", channel: "probe", verb: "text", ok: true });
  expect(trace.map((entry) => entry.seq)).toEqual(trace.map((_entry, index) => index + 1));
  expect(trace).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: "body", channel: "probe", verb: "text", ok: true }),
    expect.objectContaining({ stage: "body", channel: "user", verb: "click", ok: true }),
    expect.objectContaining({ stage: "body", channel: "seed:raw", verb: "evalIn", ok: true }),
    expect.objectContaining({ stage: "body", channel: "probe:raw", verb: "eval", ok: true }),
    expect.objectContaining({ stage: "body", channel: "user", verb: "see", detail: "see(text=/Running 1 command, reading 1 file/)" }),
    expect.objectContaining({ stage: "body", channel: "user", verb: "see", detail: "see(composer, editable, text=/Keep this draft/)" }),
    expect.objectContaining({ stage: "body", channel: "user", verb: "type", detail: "type(composer, \"Replacement text\", replace)" }),
  ]));
  expect(trace.some((entry) => entry.verb === "tmpPath")).toBe(false);
  expect(cdpCalls.filter((call) => call.method === "Runtime.evaluate" && call.params.awaitPromise === true)).toHaveLength(2);
  expect(cdpCalls).toEqual(expect.arrayContaining([
    expect.objectContaining({
      method: "Input.dispatchKeyEvent",
      params: expect.objectContaining({ type: "keyDown", code: "KeyA" }),
    }),
    expect.objectContaining({ method: "Input.insertText", params: { text: "Replacement text" } }),
  ]));
  expect(steps.map(({ name, ok }) => ({ name, ok }))).toEqual([
    { name: "failing step", ok: false },
    { name: "later step", ok: "not-reached" },
  ]);
  expect(outcomes.at(-1)).toMatchObject({ outcome: "failed", failure: "expected step failure" });

  type ForbiddenUserKeys = Extract<keyof User, "evalIn" | "fetch" | "run">;
  const userHasNoForbiddenKeys: ForbiddenUserKeys extends never ? true : false = true satisfies true;
  expect(userHasNoForbiddenKeys).toBe(true);
  expect(Object.keys(user)).not.toEqual(expect.arrayContaining(["evalIn", "fetch", "run"]));

  const record: TestRunRecord = {
    name: "spec primitives",
    dir: "/tmp/spec-primitives",
    createdAt: "2026-09-01T00:00:00.000Z",
    closedAt: "2026-09-01T00:00:01.000Z",
    summary: {
      ok: false,
      totalArtifacts: 0,
      passedArtifacts: 0,
      failedArtifacts: 0,
      unvalidatedArtifacts: 0,
      pendingArtifacts: 0,
      passedExpectations: 0,
      failedExpectations: 0,
      pendingJudgments: 0,
    },
    artifacts: [],
    trace,
    steps,
    outcome: "failed",
    failure: "expected step failure",
  };
  const markdown = renderPrMarkdown(record, {});
  expect(markdown).toContain("**[user]**");
  expect(markdown).toContain("**steps**");
  expect(markdown).toContain("**verdict** failed");

  const passedRecord: TestRunRecord = {
    ...record,
    name: "passed primitive trace",
    summary: { ...record.summary, ok: true },
    trace: [
      { seq: 1, at: record.createdAt, stage: "body", channel: "user", verb: "see", detail: "see(first)", ok: true },
      { seq: 2, at: record.createdAt, stage: "body", channel: "user", verb: "see", detail: "see(second)", ok: true },
      { seq: 3, at: record.createdAt, stage: "body", channel: "user", verb: "see", detail: "see(third)", ok: true },
      { seq: 4, at: record.createdAt, stage: "body", channel: "probe", verb: "storage", detail: "storage(draft)", ok: true },
    ],
    steps: [{ seq: 1, name: "visible result", depth: 0, ok: true }],
    outcome: "passed",
    failure: undefined,
  };
  const passedMarkdown = renderPrMarkdown(passedRecord, {});
  expect(passedMarkdown).toContain("## Test evidence — passed primitive trace — ✅ passed");
  expect(passedMarkdown).toContain("**verdict** passed · 3 user observations (see ×3) · 1 probes · steps 1/1");
});

let skippedWorldRuns = 0;
const skippedWorldTest = spec.world(async () => {
  skippedWorldRuns += 1;
  return { app: fakeSurface };
}, { needs: { optIn: ["OPENWORK_SPEC_PRIMITIVES_MISSING_OPT_IN"] } });

skippedWorldTest("unmet needs skip before building the world", () => {
  throw new Error("body must not run");
});

test("the skipped fixture never invoked its world function", () => {
  expect(skippedWorldRuns).toBe(0);
});
