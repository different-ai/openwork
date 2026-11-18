import { expect, test } from "bun:test";
import { askDescription, questionToolDefinition, questionWritingGuidance } from "../src/opencode-plugins/openwork-agent-questions";
import { OpenWorkCapabilitiesKnowledge } from "../src/opencode-plugins/openwork-capabilities-knowledge";

test("the engine's question tool and ask_without_waiting both ask for one short sentence", async () => {
  const hooks = await OpenWorkCapabilitiesKnowledge();
  const question = { description: "Ask the user a question." };
  await hooks["tool.definition"]({ toolID: "question" }, question);
  expect(question.description).toBe(`Ask the user a question.\n\n${questionWritingGuidance}`);
  expect(askDescription).toContain(questionWritingGuidance);

  const other = { description: "Read" };
  questionToolDefinition({ toolID: "read" }, other);
  expect(other.description).toBe("Read");
});
