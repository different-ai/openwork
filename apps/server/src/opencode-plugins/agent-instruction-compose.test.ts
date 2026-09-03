import { describe, expect, test } from "bun:test";

import {
  appendAgentInstructions,
  combineInstructionSections,
  composeAgentInstructions,
  createInstructionSection,
  deleteInstructionSection,
  expandInstructionSection,
} from "./agent-instruction-compose.js";

describe("agent instruction compose primitives", () => {
  test("create + combine keep first non-empty section per id", () => {
    const sections = combineInstructionSections(
      createInstructionSection("routing", "use cloud tools"),
      createInstructionSection("routing", "ignored duplicate"),
      createInstructionSection("skills", "<available_skills />"),
      createInstructionSection("empty", "   "),
    );
    expect(sections.map((section) => section.id)).toEqual(["routing", "skills"]);
  });

  test("delete and expand are predictable", () => {
    const base = combineInstructionSections(
      createInstructionSection("browser", "use openwork_execute browser.open_url"),
      createInstructionSection("ui", "use openwork_ui_*"),
    );
    const withoutUi = deleteInstructionSection(base, "ui");
    const expanded = expandInstructionSection(withoutUi, "browser", (body) => `${body}\nnever use browser_* on OpenWork`);
    expect(composeAgentInstructions(expanded)).toEqual([
      "use openwork_execute browser.open_url\nnever use browser_* on OpenWork",
    ]);
  });

  test("composeAgentInstructions combines section groups once and returns ordered bodies", () => {
    let observedBodyReads = 0;
    const observedSection = {
      id: "observed",
      get body() {
        observedBodyReads += 1;
        return "three";
      },
    };

    expect(composeAgentInstructions(
      createInstructionSection("a", "one"),
      [
        createInstructionSection("a", "ignored duplicate"),
        createInstructionSection("empty", "  "),
        createInstructionSection("b", "two"),
      ],
      observedSection,
    )).toEqual(["one", "two", "three"]);
    expect(observedBodyReads).toBe(1);
  });

  test("appendAgentInstructions extends the engine system entry without adding a system message, one blank line between sections", () => {
    const system = ["engine header"];
    appendAgentInstructions(system, createInstructionSection("a", "one"), createInstructionSection("b", "two"));
    appendAgentInstructions(system, createInstructionSection("c", "three"));
    expect(system).toEqual(["engine header\n\none\n\ntwo\n\nthree"]);
  });

  test("appendAgentInstructions starts one entry when the engine supplied none", () => {
    const system: string[] = [];
    appendAgentInstructions(system, createInstructionSection("a", "one"));
    appendAgentInstructions(system, createInstructionSection("b", "two"));
    expect(system).toEqual(["one\n\ntwo"]);
  });

  test("appendAgentInstructions leaves the system prompt untouched when every section is empty", () => {
    const system = ["engine header", ""];
    appendAgentInstructions(system, createInstructionSection("empty", "  "), null);
    expect(system).toEqual(["engine header", ""]);
    appendAgentInstructions(system, createInstructionSection("a", "one"));
    expect(system).toEqual(["engine header", "one"]);
  });
});
