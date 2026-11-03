import { z } from "zod";
import type { askArgs } from "./opencode-plugins/openwork-agent-questions.js";
import { loopbackFetch } from "./server-fetch.js";

type EngineConnection = { url: string; username: string; password: string };
type Question = z.infer<typeof askArgs>["questions"][number];

/** How long an unanswered question can still reach the chat. */
const OPEN_FOR_MS = 24 * 60 * 60_000;
const createdForm = z.object({ data: z.object({ id: z.string() }) });
const settledForm = z.object({
  type: z.enum(["form.replied", "form.cancelled"]),
  data: z.object({ id: z.string(), answer: z.record(z.string(), z.unknown()).optional() }),
});

/** The message the chat receives: each question with the person's answer. */
export function answerText(questions: readonly Question[], answer: Record<string, unknown>): string {
  return questions.map((question, index) => {
    const value = answer[`q${index}`];
    const given = (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string" && item.trim() !== "");
    return `Answer to your question “${question.question}”: ${given.length > 0 ? given.join(", ") : "(no answer)"}`;
  }).join("\n");
}

/**
 * Asks in the chat through a v2 form that no tool call waits on, so the agent
 * keeps working. The form carries the question tool's own `metadata.kind`,
 * so the app shows it like any question, but no tool link: the app settles
 * questions whose tool call has ended. The answer is sent to the chat with
 * `steer` delivery: a running turn reads it at its next step, and an idle chat
 * starts a turn. A dismissed question sends nothing.
 */
export async function askWithoutWaiting(
  engine: EngineConnection,
  input: { directory: string; sessionId: string; questions: readonly Question[] },
  call: AbortSignal,
  lifetime: AbortSignal,
): Promise<{ id: string; settled: Promise<void> }> {
  const location = `location[directory]=${encodeURIComponent(input.directory)}`;
  const authorization = `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`;
  const session = `/api/session/${encodeURIComponent(input.sessionId)}`;
  const watching = new AbortController();
  const open = AbortSignal.any([lifetime, watching.signal, AbortSignal.timeout(OPEN_FOR_MS)]);
  try {
    // Subscribe first so the answer cannot arrive unseen. The stream outlives this call.
    const events = await loopbackFetch(new URL(`/api/event?${location}`, engine.url), { headers: { authorization, accept: "text/event-stream" }, signal: open });
    if (!events.ok || !events.body) throw new Error("OpenWork could not ask the person, so nothing was asked.");
    const response = await loopbackFetch(new URL(`${session}/form?${location}`, engine.url), {
      method: "POST", headers: { authorization, "content-type": "application/json" }, signal: AbortSignal.any([open, call]),
      body: JSON.stringify({
        title: input.questions[0]?.header ?? "Question",
        metadata: { kind: "question", background: true },
        fields: input.questions.map((question, index) => ({
          key: `q${index}`, type: question.multiple ? "multiselect" : "string", title: question.header, description: question.question,
          options: (question.options ?? []).map(option => ({ value: option.label, label: option.label, ...(option.description ? { description: option.description } : {}) })),
          custom: true,
        })),
      }),
    });
    const created = createdForm.safeParse(await response.json().catch(() => null));
    if (!response.ok || !created.success) throw new Error("OpenWork could not ask the person, so nothing was asked.");
    const id = created.data.data.id;
    const reader = events.body.pipeThrough(new TextDecoderStream()).getReader();
    const settled = (async () => {
      let buffered = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        const frames = (buffered + chunk.value).split(/\r?\n\r?\n/);
        buffered = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
          let event: unknown;
          try { event = JSON.parse(data); } catch { continue; }
          const settled = settledForm.safeParse(event);
          if (!settled.success || settled.data.data.id !== id) continue;
          if (settled.data.type === "form.cancelled") return;
          await loopbackFetch(new URL(`${session}/prompt?${location}`, engine.url), {
            method: "POST", headers: { authorization, "content-type": "application/json" }, signal: lifetime,
            body: JSON.stringify({ text: answerText(input.questions, settled.data.data.answer ?? {}), delivery: "steer" }),
          });
          return;
        }
      }
    })().catch(() => {}).finally(() => watching.abort());
    return { id, settled };
  } catch (error) {
    watching.abort();
    throw error;
  }
}
