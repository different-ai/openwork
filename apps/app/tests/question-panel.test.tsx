/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuestionInfo } from "@opencode-ai/sdk/v2/client";
import { QuestionPanel } from "../src/react-app/domains/session/modals/question-modal";

const questions: QuestionInfo[] = [{
  header: "Settle sessions",
  question: "Organize, archive, or wrap up?",
  options: [{ label: "Archive sessions", description: "Clear them from the sidebar." }],
}];

describe("question panel dismissal", () => {
  test("offers Dismiss when the question can be declined", () => {
    const html = renderToStaticMarkup(<QuestionPanel questions={questions} busy={false} onReply={() => {}} onDismiss={() => {}} />);
    expect(html).toContain("Dismiss");
    expect(html).toContain("Archive sessions");
  });
  test("hides Dismiss when nothing can decline the question", () => {
    const html = renderToStaticMarkup(<QuestionPanel questions={questions} busy={false} onReply={() => {}} />);
    expect(html).not.toContain("Dismiss");
  });
});

describe("question panel answer box", () => {
  test("offers the typed answer as an alternative when there are options", () => {
    const html = renderToStaticMarkup(<QuestionPanel questions={questions} busy={false} onReply={() => {}} />);
    expect(html).toContain("Or type a custom answer");
  });
  test("asks for the answer directly when the question has no options", () => {
    const textOnly: QuestionInfo[] = [{ header: "Failing check", question: "Which branch is this on?", options: [] }];
    const html = renderToStaticMarkup(<QuestionPanel questions={textOnly} busy={false} onReply={() => {}} />);
    expect(html).not.toContain("Or type a custom answer");
    expect(html).toContain('aria-label="Which branch is this on?"');
    expect(html).toContain("Send");
  });
});
