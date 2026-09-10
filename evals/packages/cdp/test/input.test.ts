import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertAbsent, locate, MISS_CANDIDATE_LIMIT, TargetNotFoundError, mapKey, parseTarget, readDom, waitForLocated } from "../src/input.ts";
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
  assert.equal(parseTarget({ role: "switch", label: "Check automatically" }).role, "switch");
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
    /Visible button\/link candidates \(2\): button "Model · gpt-5", link "Provider docs"\./,
  );
});

test("a miss names the route, the page roots, and every candidate of the requested role", async () => {
  const surface = surfaceReturning({
    notFound: true,
    candidateRole: "menuitem",
    candidates: ['menuitem "Remove Team briefing from dashboard"', 'menuitem "Delete Team briefing"'],
    route: "#/dashboard",
    roots: { appHeader: true, dashboardPage: false },
  });
  await assert.rejects(
    locate(surface, { role: "menuitem", text: "Missing" }),
    /Route #\/dashboard\. Page roots: appHeader=true dashboardPage=false\. Visible menuitem candidates \(2\): menuitem "Remove Team briefing from dashboard", menuitem "Delete Team briefing"\./,
  );
});

test("a miss caps the candidate list and says how many the page really had", async () => {
  const candidates = Array.from({ length: MISS_CANDIDATE_LIMIT + 3 }, (_, index) => `button "Control ${index}"`);
  const surface = surfaceReturning({ notFound: true, candidateRole: "button", candidates });
  await assert.rejects(
    locate(surface, { role: "button", text: "Missing" }),
    (error: unknown) => {
      assert.ok(error instanceof TargetNotFoundError);
      assert.match(error.message, new RegExp(`Visible button candidates \\(${MISS_CANDIDATE_LIMIT + 3}\\) \\(showing first ${MISS_CANDIDATE_LIMIT} of ${MISS_CANDIDATE_LIMIT + 3}\\): `));
      assert.match(error.message, /button "Control 39"\.$/);
      assert.doesNotMatch(error.message, /Control 40/);
      return true;
    },
  );
  await assert.rejects(
    locate(surfaceReturning({ notFound: true, candidateRole: "tab", candidates: [] }), { role: "tab", text: "Missing" }),
    /No visible tab candidates\./,
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

test("DOM inspection projects geometry and focus without exposing input values", async () => {
  const input = { tagName: "INPUT", textContent: "", value: "private-password", getBoundingClientRect: () => ({ left: 1, right: 101, top: 2, bottom: 22, width: 100, height: 20 }) };
  const surface = surfaceReturning(null);
  surface.client.send = async (method, params) => {
    if (method === "Runtime.evaluate") return { result: { objectId: "global" } };
    assert.equal(method, "Runtime.callFunctionOn");
    assert.ok(params && typeof params.functionDeclaration === "string");
    assert.deepEqual(params.arguments, [{ value: "input" }]);
    const value = runInNewContext(`(${params.functionDeclaration})("input")`, {
      document: { documentElement: { clientWidth: 390, scrollWidth: 400 }, activeElement: input,
        querySelectorAll(selector: string) { assert.equal(selector, "input"); return [input]; } },
    });
    return { result: { value } };
  };
  const result = await readDom(surface, "input");
  assert.equal(result.elements[0]?.focused, true);
  assert.equal(result.elements[0]?.rect.width, 100);
  assert.equal(result.documentWidth > result.viewportWidth, true);
  assert.equal(JSON.stringify(result).includes("private-password"), false);
  assert.equal(input.value, "private-password");
  await assert.rejects(readDom(surfaceReturning(null), "input"), /invalid snapshot/);
  await assert.rejects(readDom(surfaceReturning({ viewportWidth: 390, documentWidth: 390, elements: [{}] }), "input"), /invalid snapshot/);
});
