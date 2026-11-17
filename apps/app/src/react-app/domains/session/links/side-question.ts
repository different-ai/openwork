export const SIDE_QUESTION_COMMAND = "btw";

export const SIDE_QUESTION_TIMEOUT_MS = 300_000;

const INSTRUCTIONS = [
  "The user is asking a quick side question about the conversation so far.",
  "Answer directly and concisely in markdown from what you already know.",
  "Do not call any tools and do not take any actions.",
].join(" ");

export function sideQuestionPrompt(question: string): string {
  return [INSTRUCTIONS, question.trim()].join("\n\n");
}

export function parseSideQuestionCommand(text: string): string | null {
  const match = /^\/btw(?:[ \t\r\n]+([\s\S]*))?$/i.exec(text.trim());
  return match ? (match[1] ?? "").trim() : null;
}

export type SideQuestionFailure = "empty" | "timeout" | "error";

export type SideQuestion =
  | { id: string; question: string; status: "asking"; attempt: number }
  | { id: string; question: string; status: "answered"; attempt: number; answer: string }
  | { id: string; question: string; status: "failed"; attempt: number; failure: SideQuestionFailure };

export function askSideQuestion(list: readonly SideQuestion[], id: string, question: string): readonly SideQuestion[] {
  const text = question.trim();
  if (!text || list.some((item) => item.id === id)) return list;
  return [...list, { id, question: text, status: "asking", attempt: 1 }];
}

export function settleSideQuestion(
  list: readonly SideQuestion[],
  id: string,
  attempt: number,
  result: { text: string } | { failure: SideQuestionFailure },
): readonly SideQuestion[] {
  const current = list.find((item) => item.id === id);
  if (!current || current.status !== "asking" || current.attempt !== attempt) return list;
  const answer = "text" in result ? result.text.trim() : "";
  const settled: SideQuestion = answer
    ? { id, question: current.question, status: "answered", attempt, answer }
    : { id, question: current.question, status: "failed", attempt, failure: "failure" in result ? result.failure : "empty" };
  return list.map((item) => (item.id === id ? settled : item));
}

export function retrySideQuestion(list: readonly SideQuestion[], id: string): readonly SideQuestion[] {
  return list.map((item) => item.id === id && item.status === "failed"
    ? { id, question: item.question, status: "asking", attempt: item.attempt + 1 }
    : item);
}

export function removeSideQuestion(list: readonly SideQuestion[], id: string): readonly SideQuestion[] {
  return list.some((item) => item.id === id) ? list.filter((item) => item.id !== id) : list;
}
