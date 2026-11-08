import type { WorkbotTurn } from "./data";

/**
 * Acknowledges an accepted request, not a result. The model still writes its own first sentence (as Slack does), but
 * a slow first token mustn't leave a person staring at typing dots. Only explicit work requests get this fallback;
 * an instant answer or a social message doesn't need it. Never claim a page opened, a job started or a time estimate.
 * It is replaced by the first real words, not saved as invented model output in the conversation.
 */
export function firstReply(turn: Pick<WorkbotTurn, "text" | "status" | "greeting" | "context">): string | null {
  if (turn.greeting || turn.context || (turn.status !== "working" && turn.status !== "queued")) return null;
  const request = turn.text.trim();
  if (!request) return null;
  // Be conservative: an acceptance line must never turn “don't use the browser” or a teaching note into a promise
  // to operate it. The model handles nuanced requests; this deterministic fallback handles explicit work only.
  if (/\b(don['’‘ʼ]?t|do not|not|never|without|stop|cancel|abort|avoid|wait|unless)\b/i.test(request)) return null;
  if (!/^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:use|open|browse|find|search|check|research|investigate|build|create|make|run|take|look|work|start)\b/i.test(request)) return null;
  if (turn.status === "queued") return "I've got your request. I'll pick it up next and reply here.";
  if (/\b(browser|browse|youtube|website)\b/i.test(request)) return "On it — I'll take a look in my browser and tell you what I find.";
  if (/\b(computer|desktop|screen)\b/i.test(request)) return "On it — I'll take a look on my computer and reply here with what I find.";
  if (/\b(build|create|make|research|investigate|background|task|job)\b/i.test(request)) return "On it — I'll work through that and reply here with the result.";
  return null;
}
