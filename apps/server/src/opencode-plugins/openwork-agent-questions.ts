// A question the agent asks without stopping its work, behind the desktop's
// `agentQuestions` feature. The engine's own question tool blocks the turn
// until the person answers; this one returns at once and the answer reaches
// the chat later (see opencode-v2-background-questions.ts).
import { z } from "zod";
import { uiBridgeRequest } from "./openwork-ui-bridge.js";

export const ASK_WITHOUT_WAITING = "ask_without_waiting";

// The same questions the engine's question tool takes, so the agent can use either.
export const askArgs = z.object({
  questions: z.array(z.object({
    header: z.string().min(1).max(60).describe("A very short label, such as \"Save location\"."),
    question: z.string().min(1).max(1000),
    options: z.array(z.object({ label: z.string().min(1).max(120), description: z.string().max(300).optional() }).strict()).max(8).optional()
      .describe("Choices to pick from. The person can always type their own answer."),
    multiple: z.boolean().optional().describe("true lets the person pick more than one option."),
  }).strict()).min(1).max(4),
}).strict();

// All model-facing guidance for asking lives here, offered only with the feature on.
export const askDescription = "Ask the person something without stopping. Takes the same questions as the question tool but returns at once: their answer arrives later as a message in this chat, and starts a new turn if yours has ended. Use it when other parts of the task do not depend on the answer, and keep working on those; use question when nothing useful can continue until they answer. Either way, never end your turn asking the person to reply, approve or tell you when they are done: ask with one of these tools instead. Do not ask again while a question is open.";

/** On only when the desktop says the `agentQuestions` feature is on; any other host keeps it off. */
export async function agentQuestionsOffered(): Promise<boolean> {
  const result = await uiBridgeRequest("/agent-questions/enabled");
  return Boolean(result && typeof result === "object" && "enabled" in result && result.enabled === true);
}
