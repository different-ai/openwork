import { browserScript } from "@openwork/testkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
let primitiveEvidenceDir = "";
let redactedTraceMarkdown = "";

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
              disabled: null,
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

primitiveTest("worlds and capability channels preserve provenance and ordering", async ({ world, seed, user, probe, step, evidence }) => {
  primitiveEvidenceDir = evidence.dir;
  expect(world.workspacePath).toBe("/fake/world-workspace");
  expect(await probe.text()).toBe("read-only probe");
  expect(typeof seed.denLink).toBe("function");
  expect(typeof probe.connectState).toBe("function");
  expect(() => seed.tmpPath("too-late")).toThrow(SeedBeforeActError);

  await user.click("Run task");
  expect(seed.tmpPath("mid-flow")).toBe("/fake/mid-flow");
  expect(clickCount).toBe(1);
  expect(await seed.evalIn(fakeSurface, () => (Promise.resolve('seed')), { awaitPromise: true, timeoutMs: 1_000 })).toBe("evaluated");
  expect(await probe.eval(() => (Promise.resolve('probe')), { awaitPromise: true, timeoutMs: 1_000 })).toBe("evaluated");
  await probe.eval(browserScript((value) => value, ["argument value"]), { awaitPromise: true, timeoutMs: 1_000 });
  await user.see({ text: /Running 1 command, reading 1 file/ });
  await user.see("composer", { editable: true, text: /Keep this draft/ });
  await user.see({ text: "alice@example.com Bearer abc accessToken=token-value secret='secret-value' password=password-value" });
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
  expect(cdpCalls.filter((call) => call.method === "Runtime.evaluate" && call.params.awaitPromise === true)).toHaveLength(3);
  expect(cdpCalls).toEqual(expect.arrayContaining([
    expect.objectContaining({
      method: "Input.dispatchKeyEvent",
      params: expect.objectContaining({ type: "keyDown", code: "KeyA" }),
    }),
    expect.objectContaining({ method: "Input.insertText", params: { text: "Replacement text" } }),
    expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({
        expression: expect.stringContaining('"argument value"'),
        awaitPromise: true,
      }),
    }),
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
    engine: "v1",
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
  redactedTraceMarkdown = markdown;
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

test("trace details redact identities and credentials in persisted and rendered evidence", async () => {
  const testRunJson = await readFile(join(primitiveEvidenceDir, "test-run.json"), "utf8");
  for (const output of [testRunJson, redactedTraceMarkdown]) {
    expect(output).toContain("<email>");
    expect(output).toContain("Bearer <redacted>");
    expect(output).not.toContain("alice@example.com");
    expect(output).not.toContain("Bearer abc");
    expect(output).not.toContain("token-value");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("password-value");
  }
});

const domStyle = {
  colorScheme: "dark",
  borderTopWidth: "1px",
  borderBottomWidth: "0px",
  borderTopLeftRadius: "12px",
};
const domElement = {
  tag: "header",
  text: "Workspace",
  focused: false,
  rect: { left: 0, right: 640, top: 0, bottom: 48, width: 640, height: 48 },
  style: domStyle,
};

function inspectionSurface(name: string) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const response: { snapshot: unknown } = {
    snapshot: { viewportWidth: 640, documentWidth: 640, elements: [domElement] },
  };
  const surface: Surface = {
    handle: { ...fakeSurface.handle, name },
    client: {
      async send(method, params = {}) {
        calls.push({ method, params });
        if (method === "Runtime.evaluate") return { result: { objectId: `${name}-global` } };
        if (method === "Runtime.callFunctionOn") return { result: { value: response.snapshot } };
        return {};
      },
      close() {},
    },
  };
  return { surface, calls, response };
}

const inspectionTrace: TraceEntry[] = [];
const inspectionTest = spec.world(async () => {
  const primary = inspectionSurface("primary-app");
  const bound = inspectionSurface("bound-app");
  inspectionTrace.length = 0;
  return { app: primary.surface, primary, bound };
}, {
  adapters: { observe: { trace: (entry) => inspectionTrace.push(entry) } },
});

inspectionTest("resizeViewport forwards desktop metrics and traces the selected user surface", async ({ world, user }) => {
  const narrow = { width: 640, height: 480, deviceScaleFactor: 2 };
  const wide = { width: 1280, height: 800, deviceScaleFactor: 1 };
  const restored = { width: 1024, height: 768, deviceScaleFactor: 1.5 };
  await user.resizeViewport(narrow);
  await user.on(world.bound.surface).resizeViewport(wide);
  await user.resizeViewport(restored);

  expect(world.primary.calls).toEqual([
    { method: "Emulation.setDeviceMetricsOverride", params: { ...narrow, mobile: false } },
    { method: "Emulation.setDeviceMetricsOverride", params: { ...restored, mobile: false } },
  ]);
  expect(world.bound.calls).toEqual([
    { method: "Emulation.setDeviceMetricsOverride", params: { ...wide, mobile: false } },
  ]);
  expect(inspectionTrace).toMatchObject([
    { seq: 1, stage: "body", channel: "user", verb: "resizeViewport", surface: "primary-app", ok: true },
    { seq: 2, stage: "body", channel: "user", verb: "resizeViewport", surface: "bound-app", ok: true },
    { seq: 3, stage: "body", channel: "user", verb: "resizeViewport", surface: "primary-app", ok: true },
  ]);
});

inspectionTest("probe.dom preserves computed styles and read-only provenance on its bound surface", async ({ world, probe }) => {
  const snapshot = await probe.on(world.bound.surface).dom("header");

  expect(snapshot).toEqual({ viewportWidth: 640, documentWidth: 640, elements: [domElement] });
  expect(snapshot.elements[0]?.style).toEqual(domStyle);
  expect(world.primary.calls).toEqual([]);
  expect(world.bound.calls.map(({ method }) => method)).toEqual([
    "Runtime.evaluate", "Runtime.callFunctionOn",
  ]);
  expect(world.bound.calls).toEqual(expect.arrayContaining([
    expect.objectContaining({
      method: "Runtime.callFunctionOn",
      params: expect.objectContaining({ arguments: [{ value: "header" }] }),
    }),
  ]));
  expect(inspectionTrace).toMatchObject([
    { stage: "body", channel: "probe", verb: "dom", surface: "bound-app", ok: true },
  ]);
});

const invalidDomStyles: Array<{ name: string; style: unknown }> = [
  { name: "absent style", style: undefined },
  { name: "null style", style: null },
  { name: "string style", style: "dark" },
];
for (const field of Object.keys(domStyle)) {
  invalidDomStyles.push(
    { name: `absent ${field}`, style: Object.fromEntries(Object.entries(domStyle).filter(([key]) => key !== field)) },
    { name: `non-string ${field}`, style: { ...domStyle, [field]: 1 } },
  );
}
for (const { name, style } of invalidDomStyles) {
  inspectionTest(`probe.dom rejects ${name}`, async ({ world, probe }) => {
    const { style: _style, ...element } = domElement;
    world.primary.response.snapshot = {
      viewportWidth: 640,
      documentWidth: 640,
      elements: [{ ...element, ...(style === undefined ? {} : { style }) }],
    };

    await expect(probe.dom("header")).rejects.toThrow("DOM inspection returned an invalid snapshot.");
    expect(inspectionTrace).toMatchObject([
      { stage: "body", channel: "probe", verb: "dom", surface: "primary-app", ok: false },
    ]);
    expect(world.bound.calls).toEqual([]);
  });
}

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
