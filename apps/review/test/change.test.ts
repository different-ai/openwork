import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewEvidence } from "@openwork/review";
import { closesStep, describeAction, describeChange, isRepeat, stepChecks } from "../lib/change.ts";

type ImageEvidence = Extract<ReviewEvidence, { kind: "image" }>;

function image(id: string, step: string | undefined, change?: Partial<NonNullable<ImageEvidence["change"]>>): ImageEvidence {
  return {
    id,
    sourceId: "run",
    kind: "image",
    caption: step ?? id,
    asset: `${id}.png`,
    description: "",
    judgments: [],
    ...(step === undefined ? {} : { step }),
    ...(change ? { change: { since: "previous.png", actions: [], ratio: 0.01, boxes: [], added: [], addedCount: 0, removed: [], removedCount: 0, ...change } } : {}),
  };
}

test("traced actions read as what the person did", () => {
  assert.equal(describeAction("click(text=Advanced options)"), "Clicked “Advanced options”");
  assert.equal(describeAction("rightClick(label=Organization witness)"), "Right-clicked “Organization witness”");
  assert.equal(describeAction('type(composer, "Keep this draft while choosing a model.")'), "Typed “Keep this draft while choosing a model.” into composer");
  assert.equal(describeAction("type(label=Password, <redacted>)"), "Typed into “Password”");
  assert.equal(describeAction("press(Control+Alt+2)"), "Pressed Control+Alt+2");
  assert.equal(describeAction("reload"), "Reloaded the page");
  assert.equal(describeAction("navigate(/settings)"), "Opened “/settings”");
  assert.equal(describeAction("click(label=/^Switch to this model/)"), "Clicked “Switch to this model”");
  assert.equal(describeAction("click(label=/Looked up.*Show steps/i)"), "Clicked “Looked up…Show steps”");
});

test("each image says what the person did and what appeared or went away", () => {
  assert.equal(describeChange(image("1", "before", { since: null, ratio: 1 })), "");
  assert.equal(
    describeChange(image("2", "before", { actions: ["click(text=Advanced options)"], added: ["Auto manages its model settings."], addedCount: 1 })),
    "Clicked “Advanced options”. “Auto manages its model settings.” appeared.",
  );
  assert.equal(
    describeChange(image("3", "after", { actions: ["press(Escape)"], removed: ["Pinned", "Auto", "Recent"], removedCount: 3 })),
    "Pressed Escape. “Pinned” and “Auto” and 1 more line went away.",
  );
  assert.equal(describeChange(image("4", "after", { actions: ["reload"], ratio: 0 }), 3), "Reloaded the page. Same screen as screenshot 3.");
  assert.equal(describeChange(image("5", "after", { ratio: 0.004 })), "Less than 1% of the screen changed.");
  assert.equal(
    describeChange(image("8", "after", { actions: ["hover(testId=row)", "click(label=Pin to top)", "hover(testId=row)", "click(label=Change model)"], ratio: 0.01 })),
    "Clicked “Pin to top”, then clicked “Change model”. 1% of the screen changed.",
  );
  assert.equal(isRepeat(image("6", "after", { ratio: 0 })), true);
  assert.equal(isRepeat(image("7", "after", { since: null, ratio: 0 })), false);
});

test("a step's checks sit under its last image", () => {
  const images = [image("a", "before"), image("b", "before"), image("c", "after"), image("d", undefined)];
  const check: ReviewEvidence = { id: "check", sourceId: "run", kind: "assertion", caption: "Panel closed", step: "before", judgments: [{ expectation: "Panel closed", state: "passed", reasoning: "0 panels" }] };
  const elsewhere: ReviewEvidence = { ...check, id: "other", sourceId: "another-run" };
  assert.deepEqual(images.map((_, index) => closesStep(images, index)), [false, true, true, false]);
  assert.deepEqual(stepChecks({ evidence: [check, elsewhere] }, images[1]).map((entry) => entry.id), ["check"]);
  assert.deepEqual(stepChecks({ evidence: [check] }, images[2]), []);
  assert.deepEqual(stepChecks({ evidence: [check] }, images[3]), []);
});
