import { expect, test } from "bun:test";

import {
  combineInstructionSections,
  composeAgentInstructions,
  createInstructionSection,
} from "./agent-instruction-compose.js";

test("per-turn instruction assembly dedupes once and stays behaviorally equivalent", () => {
  const groups = [
    createInstructionSection("routing", "route the turn"),
    [
      createInstructionSection("routing", "ignored duplicate"),
      createInstructionSection("skills", "   "),
      createInstructionSection("skills", "use the skill index"),
      createInstructionSection("browser", "browser guidance"),
    ],
    null,
    undefined,
    createInstructionSection("session", "session guidance"),
  ];
  const legacy = combineInstructionSections(...groups).map((section) => section.body);
  const composed = composeAgentInstructions(...groups);
  expect(composed).toEqual(legacy);
  expect(composed).toEqual([
    "route the turn",
    "use the skill index",
    "browser guidance",
    "session guidance",
  ]);
  expect(composeAgentInstructions(combineInstructionSections(...groups))).toEqual(legacy);
  expect(composeAgentInstructions(
    createInstructionSection("only", ""),
    createInstructionSection("only", "real body"),
  )).toEqual(["real body"]);

  let bodyReads = 0;
  const observedSection = {
    id: "observed",
    get body() {
      bodyReads += 1;
      return "observed body";
    },
  };
  expect(composeAgentInstructions(
    createInstructionSection("routing", "route the turn"),
    observedSection,
  )).toEqual(["route the turn", "observed body"]);
  expect(bodyReads).toBe(1);

  let duplicateReads = 0;
  const duplicateSection = {
    id: "routing",
    get body() {
      duplicateReads += 1;
      return "should not be read";
    },
  };
  composeAgentInstructions(
    createInstructionSection("routing", "route the turn"),
    duplicateSection,
  );
  expect(duplicateReads).toBe(0);
});
