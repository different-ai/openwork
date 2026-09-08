import assert from "node:assert/strict";
import test from "node:test";
import { assertAbsent, locate, TargetNotFoundError, mapKey, parseTarget, waitForLocated } from "../src/input.ts";
import type { Surface } from "../src/surface.ts";

function surfaceReturning(value: unknown): Surface {
  return {
    handle: { name: "input-test", kind: "electron", hostKind: "test", cdpUrl: "http://127.0.0.1:1" },
    client: {
      async send(method) {
        if (method === "Runtime.evaluate") return { result: { objectId: "global" } };
        if (method === "Runtime.callFunctionOn") return { result: { value } };
        throw new Error(`Unexpected CDP method ${method}.`);
      },
      close() {},
    },
  };
}

test("parseTarget normalizes bare, structured, and regular-expression targets", () => {
  assert.deepEqual(parseTarget("composer"), {
    bare: { kind: "string", value: "composer" },
    nth: 0,
    composer: true,
  });
  assert.deepEqual(parseTarget({ role: "textbox", label: /password/i, nth: 1 }), {
    text: undefined,
    role: "textbox",
    label: { kind: "regexp", value: "password", flags: "i" },
    placeholder: undefined,
    testId: undefined,
    nth: 1,
    composer: false,
  });
  assert.deepEqual(parseTarget({ role: "button", text: /^Model\b/i }), {
    text: { kind: "regexp", value: "^Model\\b", flags: "i" },
    role: "button",
    label: undefined,
    placeholder: undefined,
    testId: undefined,
    nth: 0,
    composer: false,
  });
});

test("mapKey produces CDP key fields and modifier bits", () => {
  assert.deepEqual(mapKey("Enter"), {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    modifiers: 0,
  });
  assert.deepEqual(mapKey("Meta+R"), {
    key: "R",
    code: "KeyR",
    windowsVirtualKeyCode: 82,
    modifiers: 4,
  });
  assert.throws(() => mapKey("Hyper+R"), /Unsupported modifier/);
});

test("locate reports visible button and link names when no target matches", async () => {
  const surface = surfaceReturning({
    notFound: true,
    candidates: ['button "Model · gpt-5"', 'link "Provider docs"'],
  });
  await assert.rejects(
    locate(surface, { role: "button", text: "Missing" }),
    /Visible button\/link candidates: button "Model · gpt-5", link "Provider docs"/,
  );
});

test("waitForLocated identifies the element covering a visible target", async () => {
  const surface = surfaceReturning({
    center: { x: 50, y: 25 },
    rect: { x: 0, y: 0, width: 100, height: 50 },
    tag: "button",
    name: "Run task",
    visible: true,
    hitTestOk: false,
    editable: false,
    value: "",
    text: "Run task",
    covering: { tag: "div", role: "dialog", text: "Blocking overlay" },
  });
  await assert.rejects(
    waitForLocated(surface, "Run task", { mustHitTest: true, timeoutMs: 10 }),
    /visible=true, hitTestOk=false\. Covered by div role="dialog" text="Blocking overlay"/,
  );
});


test("only a successful browser inspection can report a missing target", async () => {
  await assert.rejects(locate(surfaceReturning({ notFound: true }), "Missing"), TargetNotFoundError);
  await assert.rejects(locate(surfaceReturning(null), "Missing"), error =>
    error instanceof Error && !(error instanceof TargetNotFoundError));
  const disconnected = surfaceReturning(null);
  disconnected.client.send = async () => { throw new Error("CDP disconnected"); };
  await assert.rejects(locate(disconnected, "Missing"), /CDP disconnected/);
});


test("absence never turns disconnection or malformed browser results into a pass", async () => {
  await assertAbsent(surfaceReturning({ notFound: true }), "Missing", 10);
  await assert.rejects(assertAbsent(surfaceReturning(null), "Missing", 10), /Could not locate/);
  await assert.rejects(assertAbsent(surfaceReturning({ center: {}, rect: {} }), "Missing", 10), /invalid located-element geometry/);
  const disconnected = surfaceReturning(null);
  disconnected.client.send = async () => { throw new Error("CDP disconnected"); };
  await assert.rejects(assertAbsent(disconnected, "Missing", 10), /CDP disconnected/);
  await assert.rejects(assertAbsent(surfaceReturning(null), "Missing", 0), /positive duration/);
});

test("absence distinguishes a hidden target from a visible target", async () => {
  const target = { center: { x: 1, y: 1 }, rect: { x: 0, y: 0, width: 2, height: 2 }, tag: "div", name: "Error", visible: false, hitTestOk: false, editable: false, value: "", text: "Error", covering: null };
  await assertAbsent(surfaceReturning(target), "Error", 10);
  await assert.rejects(assertAbsent(surfaceReturning({ ...target, visible: true }), "Error", 10), /remained visible/);
});
