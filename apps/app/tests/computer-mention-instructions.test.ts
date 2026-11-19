import { expect, test } from "bun:test";
import { computerMentionInstruction, searchFirstComputerMentionInstruction } from "../src/react-app/domains/session/surface/composer/computer-mentions";
import { splitComposerPillText } from "../src/react-app/domains/session/surface/composer/composer-pills";
import { connectorPrompt } from "../src/react-app/domains/session/surface/composer/connector-token";
import { sentTokensFromInstructions } from "../src/react-app/domains/session/surface/composer/sent-message-tokens";

for (const target of ["cloud", "desktop"] as const) {
  test(`${target}: new handoffs leave progress and answers to the chat`, () => {
    const instruction = computerMentionInstruction(target);
    expect(instruction).toContain("end your turn instead of checking on it");
    expect(instruction).not.toContain("remote-session:read");
    expect(splitComposerPillText(`@${target}${instruction}`)).toEqual([{ kind: "computer", target }]);
  });

  test(`${target}: the handoff works whether Connect lists the create tool or only search`, () => {
    const instruction = computerMentionInstruction(target);
    expect(instruction).toContain("remote-session create tool");
    expect(instruction).toContain("when Connect lists no such tool, find remote-session:create with search_capabilities");
  });

  test(`${target}: historical instructions remain readable as a single pill`, () => {
    const ending = target === "cloud"
      ? "Return the session link and use remote-session:read to check replies."
      : "Use remote-session:read with commandId to check delivery. A delivered receipt means the task was started, not that it finished; return the desktop session reference.";
    const searchFirst = searchFirstComputerMentionInstruction(target);
    expect(searchFirst).toContain("Use OpenWork Connect search_capabilities to find remote-session:create, then execute it");
    for (const historical of [searchFirst, searchFirst.replace(/OpenWork shows the started task.*(?=\]$)/, ending)]) {
      expect(splitComposerPillText(`@${target}${historical} Next message`)).toEqual([{ kind: "computer", target }, " Next message"]);
      expect(sentTokensFromInstructions(historical)).toEqual([{ kind: "pill", pill: { kind: "computer", target } }]);
    }
  });
}

test("connector: the chip's instruction covers both Connect views and earlier sends keep their chip", () => {
  const current = connectorPrompt("GitHub");
  expect(current).toContain("call the connector's own tools when Connect lists them; otherwise discover capabilities with search_capabilities, omitting intent connect.");
  const earlier = current.replace(
    "call the connector's own tools when Connect lists them; otherwise discover capabilities with search_capabilities, omitting intent connect.",
    "discover capabilities normally with search_capabilities, omitting intent connect.",
  );
  for (const sent of [current, earlier]) {
    expect(splitComposerPillText(`[connector GitHub]${sent} list my pull requests`)).toEqual([{ kind: "connector", name: "GitHub" }, " list my pull requests"]);
    expect(sentTokensFromInstructions(sent)).toEqual([{ kind: "pill", pill: { kind: "connector", name: "GitHub" } }]);
  }
});
