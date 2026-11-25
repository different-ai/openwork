import { describe, expect, test } from "bun:test";
import { askFormArgs, formQuestions } from "../src/opencode-plugins/openwork-agent-questions.ts";
import { answerText } from "../src/opencode-v2-background-questions.ts";

const form = askFormArgs.parse({
  title: "Roadmap details",
  fields: [
    { kind: "choice", question: "Which areas?", multiple: true, display: "cards", options: [
      { label: "Mobile app", description: "iPhone MVP", icon: "smartphone" },
      { label: "Security fixes", icon: "shield-check", tone: "danger" },
    ] },
    { kind: "scale", question: "How polished?", min: 1, max: 5, minLabel: "Rough", maxLabel: "Polished" },
    { kind: "date", question: "Wrap up by?" },
    { kind: "text", question: "Anything else?" },
  ],
});

describe("ask_form", () => {
  test("an older app still gets every field as a plain question", () => {
    const questions = formQuestions(form);
    expect(questions).toHaveLength(4);
    expect(questions[0]).toMatchObject({ header: "Roadmap details", multiple: true, options: [{ label: "Mobile app", description: "iPhone MVP" }, { label: "Security fixes" }] });
    expect(questions[1]?.question).toBe("How polished? (1 = Rough, 5 = Polished)");
    expect(questions[2]?.question).toBe("Wrap up by? (YYYY-MM-DD)");
    expect(questions[3]).not.toHaveProperty("options");
  });

  test("the answers reach the agent as one message", () => {
    expect(answerText(formQuestions(form), { q0: ["Mobile app"], q1: "4", q2: "2026-12-01", q3: "" })).toContain("How polished? (1 = Rough, 5 = Polished)”: 4");
  });

  test("rejects unknown field kinds and icon names with spaces", () => {
    expect(askFormArgs.safeParse({ title: "x", fields: [{ kind: "color", question: "?" }] }).success).toBe(false);
    expect(askFormArgs.safeParse({ title: "x", fields: [{ kind: "choice", question: "?", options: [{ label: "a", icon: "not ok" }, { label: "b" }] }] }).success).toBe(false);
  });
});
