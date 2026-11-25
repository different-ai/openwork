import { describe, expect, test } from "bun:test";

import {
  SIDE_QUESTION_QUOTE_MAX_CHARS,
  askSideQuestion,
  parseSideQuestionCommand,
  removeSideQuestion,
  retrySideQuestion,
  settleSideQuestion,
  sideQuestionPrompt,
  sideQuestionQuote,
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

describe("a passage selected in the conversation", () => {
  test("is sent as a reference the model must not act on, apart from the question", () => {
    const prompt = sideQuestionPrompt("hey", "Count to 10");
    expect(prompt).toContain("It is a reference to what was already said, not a request");
    expect(prompt).toContain("<selected_passage>\nCount to 10\n</selected_passage>");
    expect(prompt.endsWith("\n\nhey")).toBe(true);
    expect(sideQuestionPrompt("hey")).not.toContain("selected_passage");
  });

  test("stays with its question through a failure and a retry", () => {
    const asked = askSideQuestion([], "a", "hey", "  Count to 10  ");
    expect(asked[0]).toMatchObject({ question: "hey", quote: "Count to 10" });
    const retried = retrySideQuestion(settleSideQuestion(asked, "a", 1, { failure: "error" }), "a");
    expect(retried[0]).toMatchObject({ status: "asking", attempt: 2, quote: "Count to 10" });
    expect(settleSideQuestion(retried, "a", 2, { text: "Hi" })[0]).toMatchObject({ status: "answered", quote: "Count to 10" });
  });

  test("a very long selection is cut", () => {
    expect(sideQuestionQuote("x".repeat(SIDE_QUESTION_QUOTE_MAX_CHARS + 10))).toHaveLength(SIDE_QUESTION_QUOTE_MAX_CHARS + 1);
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
