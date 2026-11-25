import { expect, test } from "bun:test";
import { askDescription, questionToolDefinition, questionWritingGuidance } from "../src/opencode-plugins/openwork-agent-questions";
import { OpenWorkCapabilitiesKnowledge } from "../src/opencode-plugins/openwork-capabilities-knowledge";

test("the engine's question tool and ask_without_waiting both ask for short questions", async () => {
  const hooks = await OpenWorkCapabilitiesKnowledge();
  const question = { description: "Ask the user a question." };
  await hooks["tool.definition"]({ toolID: "question" }, question);
  expect(question.description).toBe(`Ask the user a question.\n\n${questionWritingGuidance}`);
  expect(askDescription).toContain(questionWritingGuidance);

  const other = { description: "Read" };
  questionToolDefinition({ toolID: "read" }, other);
  expect(other.description).toBe("Read");
});

test("questions say what they refer to and are not used to ask whether a step is done", () => {
  expect(questionWritingGuidance).toContain("not tool output or your thinking");
  expect(questionWritingGuidance).toContain("instead of asking whether they are done");
  expect(askDescription).not.toContain("tell you when they are done");
});
