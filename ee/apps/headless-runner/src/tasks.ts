import type { Turn } from "./store.js"
import type { ToolSpec } from "./types.js"

/**
 * Background tasks: the conversation hands longer work to a task and stays free, so the person can keep talking
 * while it runs. A task is one turn in its own lane: it sees the session's instructions and memory but not the
 * conversation, and when it ends the runner queues a report turn back in the conversation, which tells the person.
 * Offered only to sessions created with `tasks: true`.
 */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(["start_task", "stop_task"])

/** Tasks a conversation may have unfinished at once, and how many of them run at the same time. */
export const MAX_OPEN_TASKS = 5
export const MAX_RUNNING_TASKS = 3

export const TASK_TOOLS: ToolSpec[] = [
  {
    name: "start_task",
    description:
      "Hand work that takes more than a quick look (research across apps, a document or deck, work on your computer) to a background task, so the person can keep talking to you while it runs. The task has your instructions, memory and tools but not this conversation, so the brief must stand on its own. When it finishes, its report arrives here as a message and you tell them the result. Answer quick questions yourself.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A few words the person will recognize, e.g. Q3 board deck." },
        brief: { type: "string", description: "Everything the task needs: what to do, for whom, what to hand back." },
      },
      required: ["title", "brief"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_task",
    description: "Stop a background task that hasn't finished, when the person no longer wants it.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "The task's id, from Background tasks." } },
      required: ["task"],
      additionalProperties: false,
    },
  },
]

/** A task's id: its starting turn's id and a number, so a caller recognizes it as part of that turn. */
export function taskMessageId(parentMessageId: string, number: number) {
  return `${parentMessageId}.t${number}`
}

/** The report turn for a task: one per task, so a retried ending never reports twice. */
export function reportMessageId(taskMessageId: string) {
  return `${taskMessageId}.r`
}

/** Added to a task's system prompt. */
export function taskInstructions(title: string) {
  return `# Your task: ${title}
You are doing this in the background. The person isn't watching and can't answer now, so don't ask; do the whole task with your tools. Finish with a short report: what you did, what you found, the files you saved, and anything you still need from them. Your report goes back to the conversation, not straight to them.`
}

const REASONS: Record<string, string> = {
  max_steps_exceeded: "it needed more steps than it can take at once",
  stuck_repeating: "it kept getting the same result",
  turn_timeout: "it took too long",
  mcp_unavailable: "their connected apps couldn't be reached",
}

/** The message a task's report turn starts from. */
export function reportPrompt(task: Turn, report: string) {
  const reason = task.error ? (REASONS[task.error] ?? (task.error.startsWith("model_") ? "the AI model couldn't be reached" : "something went wrong")) : null
  const head =
    task.status === "completed"
      ? `[Background task "${task.title}" finished. Its report is below; the person hasn't seen it yet.]`
      : `[Background task "${task.title}" stopped before finishing: ${reason}. What it reported is below; the person hasn't seen it yet.]`
  return `${head}\n\n${report.trim() || "(It wrote no report.)"}`
}

function ago(at: number, now: number) {
  const minutes = Math.round((now - at) / 60_000)
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}

/** What the conversation knows about its tasks, so it can answer "how's the deck going?" and stop one by id. */
export function tasksSection(tasks: Turn[], now: number) {
  if (tasks.length === 0) return ""
  const state = (task: Turn) =>
    task.status === "queued"
      ? "waiting to start"
      : task.status === "running" || task.status === "interrupted"
        ? `working, started ${ago(task.createdAt, now)}`
        : task.status === "completed"
          ? `done ${ago(task.updatedAt, now)}`
          : task.status === "aborted"
            ? `stopped ${ago(task.updatedAt, now)}`
            : `couldn't finish, ${ago(task.updatedAt, now)}`
  return ["# Background tasks", ...tasks.map((task) => `- ${task.messageId} "${task.title}": ${state(task)}`)].join("\n")
}
