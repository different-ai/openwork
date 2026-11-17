import { describe, expect, test } from "bun:test";

import {
  askSideQuestion,
  parseSideQuestionCommand,
  removeSideQuestion,
  retrySideQuestion,
  settleSideQuestion,
  sideQuestionPrompt,
} from "../src/react-app/domains/session/links/side-question";

describe("side question command", () => {
  test("reads the question after /btw", () => {
    expect(parseSideQuestionCommand("/btw what did that mean?")).toBe("what did that mean?");
    expect(parseSideQuestionCommand("  /BTW\nwhich file?  ")).toBe("which file?");
  });

  test("a bare /btw opens the side chat with nothing to ask", () => {
    expect(parseSideQuestionCommand("/btw")).toBe("");
  });

  test("leaves every other message alone", () => {
    expect(parseSideQuestionCommand("/btwx hello")).toBeNull();
    expect(parseSideQuestionCommand("say /btw hello")).toBeNull();
    expect(parseSideQuestionCommand("/review")).toBeNull();
  });

  test("the prompt tells the model to answer without tools, then asks", () => {
    const prompt = sideQuestionPrompt("  which file?  ");
    expect(prompt).toContain("Do not call any tools");
    expect(prompt.endsWith("\n\nwhich file?")).toBe(true);
  });
});

describe("side questions", () => {
  const asked = askSideQuestion([], "a", " which file? ");

  test("a question waits for its answer", () => {
    expect(asked).toEqual([{ id: "a", question: "which file?", status: "asking", attempt: 1 }]);
    expect(askSideQuestion(asked, "b", "   ")).toBe(asked);
  });

  test("an answer settles it", () => {
    expect(settleSideQuestion(asked, "a", 1, { text: " app.ts \n" })[0]).toEqual({
      id: "a", question: "which file?", status: "answered", attempt: 1, answer: "app.ts",
    });
  });

  test("a reply with no text fails as empty, and a failure keeps its reason", () => {
    expect(settleSideQuestion(asked, "a", 1, { text: "  " })[0]).toMatchObject({ status: "failed", failure: "empty" });
    expect(settleSideQuestion(asked, "a", 1, { failure: "timeout" })[0]).toMatchObject({ status: "failed", failure: "timeout" });
  });

  test("retry asks again, and the first attempt's late answer is dropped", () => {
    const failed = settleSideQuestion(asked, "a", 1, { failure: "error" });
    const retried = retrySideQuestion(failed, "a");
    expect(retried[0]).toEqual({ id: "a", question: "which file?", status: "asking", attempt: 2 });
    expect(settleSideQuestion(retried, "a", 1, { text: "late" })).toBe(retried);
    expect(settleSideQuestion(retried, "a", 2, { text: "app.ts" })[0]).toMatchObject({ status: "answered", answer: "app.ts" });
  });

  test("an answer for a removed question is dropped", () => {
    const removed = removeSideQuestion(asked, "a");
    expect(removed).toEqual([]);
    expect(settleSideQuestion(removed, "a", 1, { text: "app.ts" })).toBe(removed);
  });
});
