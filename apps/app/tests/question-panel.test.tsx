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
