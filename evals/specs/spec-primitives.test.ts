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

const fakeSurface: Surface = {
  handle: {
    name: "fake-app",
    kind: "electron",
    hostKind: "fake",
    cdpUrl: "http://127.0.0.1:1",
  },
  client: {
    async send() {
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
  expect(() => seed.tmpPath("too-late")).toThrow(SeedBeforeActError);

  await user.click("Run task");
  expect(seed.tmpPath("mid-flow")).toBe("/fake/mid-flow");
  expect(clickCount).toBe(1);

  await expect(step("failing step", () => {
    throw new Error("expected step failure");
  })).rejects.toThrow("expected step failure");
  await expect(step("later step", () => "not run")).rejects.toThrow("not reached");

  expect(trace[0]).toMatchObject({ seq: 1, stage: "world", channel: "seed", verb: "tmpPath", ok: true });
  expect(trace.map((entry) => entry.seq)).toEqual(trace.map((_entry, index) => index + 1));
  expect(trace).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: "body", channel: "probe", verb: "text", ok: true }),
    expect.objectContaining({ stage: "body", channel: "seed", verb: "tmpPath", ok: false }),
    expect.objectContaining({ stage: "body", channel: "user", verb: "click", ok: true }),
    expect.objectContaining({ stage: "body", channel: "seed", verb: "tmpPath", ok: true }),
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
  expect(markdown).toContain("**[world]**");
  expect(markdown).toContain("**[user]**");
  expect(markdown).toContain("**steps**");
  expect(markdown).toContain("**verdict** failed");
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
