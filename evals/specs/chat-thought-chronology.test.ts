import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { getAssistantRenderGroups } from "../../apps/app/src/components/chat/utils";

type Parts = Parameters<typeof getAssistantRenderGroups>[0];
type Part = Parts[number];

function bashPart(id: string): Part {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: id,
    state: "output-available",
    input: { command: `echo ${id}`, description: "run" },
    output: "ok",
  };
}

function reasoningPart(text: string): Part {
  return { type: "reasoning", text, state: "done" };
}

test("interleaved thoughts render chronologically between tool aggregates", ({ evidence }) => {
  // The user-reported shape: R T T R T T — the model thinks, runs two
  // commands, thinks again, runs two more.
  const parts: Parts = [
    reasoningPart("plan the first probe"),
    bashPart("c1"),
    bashPart("c2"),
    reasoningPart("interpret and go deeper"),
    bashPart("c3"),
    bashPart("c4"),
  ];

  const visible = getAssistantRenderGroups(parts, true);

  // Chronology: thought, aggregate, thought, aggregate — a later call is
  // never absorbed into the aggregate above a thought, and interleaved
  // thoughts are never merged into one block below the run.
  expect(visible.map((group) => group.kind)).toEqual([
    "reasoning",
    "tool-aggregate",
    "reasoning",
    "tool-aggregate",
  ]);
  const aggregates = visible.flatMap((group) =>
    group.kind === "tool-aggregate" ? [group.parts.map((part) => part.toolCallId)] : []
  );
  expect(aggregates).toEqual([["c1", "c2"], ["c3", "c4"]]);
  const thoughts = visible.flatMap((group) => (group.kind === "reasoning" ? [group.text] : []));
  expect(thoughts).toEqual(["plan the first probe", "interpret and go deeper"]);

  // Negative half 1: with thinking hidden, the same turn still collapses to
  // one compact aggregate — chronology never degrades hidden-thinking runs.
  const hidden = getAssistantRenderGroups(parts, false);
  expect(hidden.map((group) => group.kind)).toEqual(["tool-aggregate"]);
  expect(
    hidden[0].kind === "tool-aggregate" ? hidden[0].parts.map((part) => part.toolCallId) : []
  ).toEqual(["c1", "c2", "c3", "c4"]);

  // Negative half 2: whitespace-only reasoning forms no thought and must not
  // fragment the aggregate even when thinking is shown.
  const blank = getAssistantRenderGroups(
    [bashPart("c1"), reasoningPart("  \n"), bashPart("c2")],
    true
  );
  expect(blank.map((group) => group.kind)).toEqual(["tool-aggregate"]);

  evidence.recordAssertionEvidence(
    "Interleaved thoughts stay chronological between tool aggregates",
    "An R T T R T T turn rendered as thought, two-call aggregate, thought, two-call aggregate in model order; hiding thinking kept one four-call aggregate; whitespace-only reasoning did not fragment the run.",
    true,
  );
});
