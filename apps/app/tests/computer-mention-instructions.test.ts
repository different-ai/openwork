import { expect, test } from "bun:test";
import { computerMentionInstruction } from "../src/react-app/domains/session/surface/composer/computer-mentions";
import { splitComposerPillText } from "../src/react-app/domains/session/surface/composer/composer-pills";

for (const target of ["cloud", "desktop"] as const) {
  test(`${target}: new handoffs leave progress and answers to the chat`, () => {
    const instruction = computerMentionInstruction(target);
    expect(instruction).toContain("end your turn instead of checking on it");
    expect(instruction).not.toContain("remote-session:read");
    expect(splitComposerPillText(`@${target}${instruction}`)).toEqual([{ kind: "computer", target }]);
  });

  test(`${target}: historical polling instructions remain readable as a single pill`, () => {
    const ending = target === "cloud"
      ? "Return the session link and use remote-session:read to check replies."
      : "Use remote-session:read with commandId to check delivery. A delivered receipt means the task was started, not that it finished; return the desktop session reference.";
    const historical = computerMentionInstruction(target).replace(/OpenWork shows the started task.*(?=\]$)/, ending);
    expect(splitComposerPillText(`@${target}${historical} Next message`)).toEqual([{ kind: "computer", target }, " Next message"]);
  });
}
