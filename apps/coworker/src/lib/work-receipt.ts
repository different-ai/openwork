/**
 * How a coworker's tool work reads to a person: one step per tool call in
 * everyday words, one line summing the work up, and one phrase for the live
 * progress row. Pure, so the copy for each tool is unit-tested and the
 * transcript only renders what these return. Technical names stay available to
 * the details disclosure, never in the collapsed line.
 */
import { coworkerToolName, isAssignmentTool, isTeamTool, type CoworkerToolName } from "./coworker-tools.ts";
import { documentToolName, humanizeDocumentId, structuredContextChanges, structuredDocument } from "./documents.ts";
import { parseLocalSchedule } from "./local-schedule.ts";
import { describeScheduleForPeople, describeScheduleInSentence } from "./responsibility-copy.ts";
import { describeTeamStep } from "./team.ts";
import { describeWorkerToolStep, workerToolName } from "./workers.ts";
import { sinceMoment } from "./live-phase.ts";

export type WorkStepInput = {
  tool: string;
  status: string;
  input: Record<string, unknown>;
  error?: string | null;
  /** The tool's result and kept metadata, when the transcript has them; the coworker's own tools name what they touched through these. */
  output?: unknown;
  metadata?: Record<string, unknown>;
};

export type WorkStepState = "running" | "done" | "failed";

export type WorkStep = {
  /** "Edited index.md", "Searched connected tools", "Read today's calendar". */
  label: string;
  /** What the coworker is doing right now, for the live row: "editing index.md". */
  doing: string;
  /** The service the step belongs to, as a person would name it: "your files", "Calendar". */
  service: string;
  state: WorkStepState;
  /** The exact tool name, for Technical details. */
  tool: string;
};

const DONE = new Set(["completed", "success"]);
const FAILED = new Set(["error", "failed"]);

export function workStepState(status: string): WorkStepState {
  if (DONE.has(status)) return "done";
  if (FAILED.has(status)) return "failed";
  return "running";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baseName(pathLike: string): string {
  const trimmed = pathLike.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

function fileFrom(input: Record<string, unknown>): string {
  const candidate = text(input.filePath) || text(input.path) || text(input.file) || text(input.target);
  return candidate ? baseName(candidate) : "";
}

function titleCase(value: string): string {
  return value.replaceAll(/[_-]+/g, " ").trim().replace(/\b\w/g, (character) => character.toUpperCase());
}

/** "openwork-cloud_search_capabilities" → ["openwork-cloud", "search_capabilities"]; plain tools have no server. */
function splitMcpTool(tool: string): { server: string; name: string } {
  const separator = tool.indexOf("_");
  if (separator <= 0) return { server: "", name: tool };
  return { server: tool.slice(0, separator), name: tool.slice(separator + 1) };
}

function serviceName(server: string): string {
  if (!server) return "OpenWork";
  if (server === "openwork-cloud") return "OpenWork Connect";
  return titleCase(server);
}

function joinTitles(titles: string[]): string {
  if (titles.length <= 2) return titles.join(" and ");
  return `${titles.slice(0, 2).join(", ")} and ${titles.length - 2} more`;
}

/**
 * The coworker's own document tools, in the words the person reads between
 * bubbles: "Wrote a document · Launch plan", "Updated Launch plan · Timeline
 * section", "Put aside · Old vendor notes". The document names itself through
 * the kept result when there is one, else through the call's input.
 */
function describeDocumentStep(name: string, call: WorkStepInput, step: (label: string, doing: string, service: string) => WorkStep): WorkStep {
  const input = call.input ?? {};
  const kept = call.output !== undefined || call.metadata ? structuredDocument({ output: call.output, metadata: call.metadata ?? {} }) : null;
  const id = text(kept?.id) || text(input.id);
  const title = text(kept?.title) || text(input.title) || (id ? humanizeDocumentId(id) : "");
  switch (name) {
    case "documents_list":
      return step("Looked over its documents", "looking over its documents", "documents");
    case "document_create":
      return step(title ? `Wrote a document · ${title}` : "Wrote a document", "writing a document", "documents");
    case "document_update": {
      const patch = typeof input.patch === "object" && input.patch !== null && !Array.isArray(input.patch) ? input.patch : null;
      const section = text(kept?.section) || (patch && "heading" in patch ? text(patch.heading) : "");
      const subject = title || "a document";
      return step(section ? `Updated ${subject} · ${section} section` : `Updated ${subject}`, `updating ${subject}`, "documents");
    }
    case "document_read":
      return step(title ? `Read a document · ${title}` : "Read a document", "reading a document", "documents");
    case "document_archive":
      return step(title ? `Archived · ${title}` : "Archived a document", "archiving a document", "documents");
    default: {
      const changed = call.output !== undefined || call.metadata ? structuredContextChanges({ output: call.output, metadata: call.metadata ?? {} }) : [];
      const asideIds = Array.isArray(input.aside) ? input.aside.map((entry) => text(entry)).filter(Boolean) : [];
      const activeIds = Array.isArray(input.active) ? input.active.map((entry) => text(entry)).filter(Boolean) : [];
      const asideTitles = changed.filter((entry) => entry.status === "aside").map((entry) => entry.title);
      const activeTitles = changed.filter((entry) => entry.status === "active").map((entry) => entry.title);
      if (changed.length > 0) {
        if (asideTitles.length > 0 && activeTitles.length === 0) return step(`Put aside · ${joinTitles(asideTitles)}`, "sorting its documents", "documents");
        if (activeTitles.length > 0 && asideTitles.length === 0) return step(`Brought back · ${joinTitles(activeTitles)}`, "sorting its documents", "documents");
        return step("Sorted its documents", "sorting its documents", "documents");
      }
      if (asideIds.length > 0 && activeIds.length === 0) return step(`Put aside · ${joinTitles(asideIds.map(humanizeDocumentId))}`, "sorting its documents", "documents");
      return step("Sorted its documents", "sorting its documents", "documents");
    }
  }
}

/** The first line of a tool's answer, when it answered with text. */
function firstOutputLine(output: unknown): string {
  if (typeof output === "string") return output.split("\n")[0]?.trim() ?? "";
  if (typeof output === "object" && output !== null && "output" in output && typeof output.output === "string") {
    return output.output.split("\n")[0]?.trim() ?? "";
  }
  return "";
}

/** The name a coworker tool quoted in its answer: `Paused assignment "Move the car"` → Move the car. */
function quotedName(output: unknown): string {
  const match = /"([^"]+)"/.exec(firstOutputLine(output));
  return match?.[1]?.trim() ?? "";
}

const LABEL_TEXT_LIMIT = 80;

function clipLabel(value: string): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > LABEL_TEXT_LIMIT ? `${single.slice(0, LABEL_TEXT_LIMIT - 1)}…` : single;
}

/** The schedule in a tool's input as people read it, or empty when it does not read. */
function scheduleWords(value: unknown, inSentence = false): string {
  try {
    const schedule = parseLocalSchedule(value);
    return inSentence ? describeScheduleInSentence(schedule) : describeScheduleForPeople(schedule);
  } catch {
    return "";
  }
}

/**
 * The coworker's own tools, in the words the person sees between bubbles:
 * "Created assignment · Move the car · Every weekday at 9:00 AM",
 * "Remembered · You work in Product", "Updated how I work · Shorter replies".
 * A step that did not finish never repeats what it was told, so a refused
 * secret is not echoed into the conversation.
 */
function describeCoworkerTool(name: CoworkerToolName, call: WorkStepInput, state: WorkStepState): WorkStep {
  const input = call.input ?? {};
  if (isTeamTool(name)) {
    const described = describeTeamStep(name, { input, output: call.output, metadata: call.metadata ?? {} }, state);
    return { label: described.label, doing: described.doing, service: "your team", state, tool: call.tool };
  }
  const service = isAssignmentTool(name) ? "your assignments" : "your memory";
  const step = (label: string, doing: string): WorkStep => ({ label, doing, service, state, tool: call.tool });
  const failed = state === "failed";
  const running = state === "running";
  const named = quotedName(call.output) || text(input.name);
  const subject = named ? clipLabel(named) : "an assignment";
  switch (name) {
    case "assignments_list":
      return step(failed ? "Couldn't check the assignments" : running ? "Checking the assignments" : "Checked the assignments", "checking the assignments");
    case "assignment_create": {
      const when = scheduleWords(input.schedule);
      if (failed) return step(`Couldn't create assignment · ${subject}`, "setting up an assignment");
      if (running) return step(`Setting up an assignment · ${subject}`, "setting up an assignment");
      return step(`Created assignment · ${subject}${when ? ` · ${when}` : ""}`, "setting up an assignment");
    }
    case "assignment_update": {
      const patch = isRecord(input.patch) ? input.patch : {};
      const current = quotedName(call.output) || "the assignment";
      if (failed) return step(`Couldn't change ${current}`, "changing an assignment");
      if (running) return step(`Changing ${current}`, "changing an assignment");
      const when = scheduleWords(patch.schedule, true);
      if (when) return step(`Changed ${clipLabel(current)} to ${when}`, "changing an assignment");
      if (patch.active === false) return step(`Paused ${clipLabel(current)}`, "pausing an assignment");
      if (patch.active === true) return step(`Resumed ${clipLabel(current)}`, "resuming an assignment");
      if (text(patch.name)) return step(`Renamed ${clipLabel(current)} to ${clipLabel(text(patch.name))}`, "renaming an assignment");
      if (text(patch.instructions)) return step(`Changed what ${clipLabel(current)} does`, "changing an assignment");
      return step(`Changed ${clipLabel(current)}`, "changing an assignment");
    }
    case "assignment_run_now": {
      const current = quotedName(call.output) || "an assignment";
      return step(failed ? `Couldn't start ${current} now` : running ? `Starting ${current} now` : `Started ${clipLabel(current)} now`, "starting an assignment");
    }
    case "assignment_remove": {
      const current = quotedName(call.output) || "an assignment";
      return step(failed ? `Couldn't remove ${current}` : running ? `Removing ${current}` : `Removed ${clipLabel(current)}`, "removing an assignment");
    }
    case "memory_remember": {
      const fact = clipLabel(text(input.text));
      if (failed) return step("Couldn't remember that", "remembering something");
      if (running) return step(fact ? `Remembering · ${fact}` : "Remembering something", "remembering something");
      const moved = /^moved/i.test(firstOutputLine(call.output));
      return step(fact ? `${moved ? "Moved to long-term memory" : "Remembered"} · ${fact}` : "Remembered something", "remembering something");
    }
    case "memory_forget": {
      const target = clipLabel(text(input.target));
      if (failed) return step("Couldn't forget that", "forgetting something");
      if (running) return step(target ? `Forgetting · ${target}` : "Forgetting something", "forgetting something");
      return step(target ? `Forgot · ${target}` : "Forgot something", "forgetting something");
    }
    case "memory_note": {
      const work = clipLabel(text(input.work));
      const note = text(input.text);
      const clearing = !note;
      if (failed) return step(clearing ? "Couldn't clear the note" : "Couldn't note that", "noting where the work stands");
      if (running) return step(work ? `${clearing ? "Clearing the note" : "Noting"} · ${work}` : "Noting where the work stands", "noting where the work stands");
      if (clearing) return step(work ? `Cleared the note · ${work}` : "Cleared a note", "noting where the work stands");
      return step(work ? `Noted · ${work} — ${clipLabel(note)}` : `Noted · ${clipLabel(note)}`, "noting where the work stands");
    }
    case "soul_update": {
      const change = isRecord(input.change) ? input.change : {};
      const summary = clipLabel(text(change.text) || (text(change.target) ? `dropped “${text(change.target)}”` : "") || text(input.section));
      if (failed) return step("Couldn't update how I work", "updating how I work");
      if (running) return step("Updating how I work", "updating how I work");
      return step(summary ? `Updated how I work · ${summary}` : "Updated how I work", "updating how I work");
    }
    case "self_read":
      return step(failed ? "Couldn't check what I remember" : running ? "Checking what I remember" : "Checked what I remember", "checking what I remember");
  }
}

/** One tool call as a step a person can read. */
export function describeWorkStep(call: WorkStepInput): WorkStep {
  const state = workStepState(call.status);
  const tool = call.tool;
  const normalized = tool.toLowerCase();
  const input = call.input ?? {};
  const file = fileFrom(input);

  const step = (label: string, doing: string, service: string): WorkStep => ({ label, doing, service, state, tool });

  const documentTool = documentToolName(tool);
  if (documentTool) return describeDocumentStep(documentTool, call, step);
  const workerTool = workerToolName(tool);
  if (workerTool) {
    const described = describeWorkerToolStep(workerTool, { input, output: call.output, metadata: call.metadata ?? {} });
    return step(described.label, described.doing, "Workers");
  }
  const own = coworkerToolName(tool);
  if (own) return describeCoworkerTool(own, call, state);
  if (normalized.endsWith("search_capabilities")) {
    const query = text(input.query);
    return step(
      query ? `Searched connected tools for “${query}”` : "Searched connected tools",
      "searching connected tools",
      "OpenWork Connect",
    );
  }
  if (normalized.endsWith("execute_capability")) {
    const name = text(input.name);
    return step(name ? `Used ${name}` : "Used a connected tool", name ? `using ${name}` : "using a connected tool", "OpenWork Connect");
  }
  switch (normalized) {
    case "edit":
    case "write":
    case "multiedit":
    case "apply_patch":
      return step(file ? `${normalized === "write" ? "Wrote" : "Edited"} ${file}` : "Edited a file", file ? `${normalized === "write" ? "writing" : "editing"} ${file}` : "editing a file", "your files");
    case "read":
      return step(file ? `Read ${file}` : "Read a file", file ? `reading ${file}` : "reading a file", "your files");
    case "glob":
    case "grep":
    case "list":
    case "ls":
      return step("Looked through your files", "looking through your files", "your files");
    case "bash":
    case "shell": {
      const description = text(input.description);
      return step(description ? `Ran a command: ${description}` : "Ran a command", "running a command", "the terminal");
    }
    case "webfetch":
    case "fetch":
      return step("Read a web page", "reading a web page", "the web");
    case "websearch":
      return step("Searched the web", "searching the web", "the web");
    case "todowrite":
    case "todoread":
      return step("Updated the plan", "updating the plan", "the plan");
    case "task":
      return step("Handed a piece of work to a helper", "working with a helper", "helpers");
    case "question":
      return step("Asked you a question", "asking you a question", "OpenWork");
    default: {
      const { server, name } = splitMcpTool(tool);
      const service = serviceName(server);
      const readable = titleCase(name);
      return server
        ? step(`Used ${readable} in ${service}`, `using ${service}`, service)
        : step(`Used ${readable}`, `using ${readable}`, service);
    }
  }
}

function joinServices(services: string[]): string {
  if (services.length <= 1) return services.join("");
  if (services.length === 2) return `${services[0]} and ${services[1]}`;
  return `${services.slice(0, -1).join(", ")}, and ${services[services.length - 1]}`;
}

/**
 * The collapsed line above a reply: "Edited index.md" for one step, otherwise
 * "Worked with your files and Calendar · 3 steps"; a failure or running step
 * is named so it never disappears into the fold.
 */
export function summarizeWork(steps: ReadonlyArray<WorkStep>): string {
  if (steps.length === 0) return "";
  const failed = steps.filter((step) => step.state === "failed").length;
  const running = steps.filter((step) => step.state === "running").length;
  let line: string;
  const only = steps.length === 1 ? steps[0] : undefined;
  if (only) {
    line = only.label;
  } else {
    const services = [...new Set(steps.map((step) => step.service))];
    const shown = services.slice(0, 2);
    const extra = services.length - shown.length;
    line = `Worked with ${joinServices(shown)}${extra > 0 ? ` and ${extra} more` : ""} · ${steps.length} steps`;
  }
  if (running) line += running === 1 && steps.length === 1 ? "" : ` · still working`;
  if (failed) line += ` · ${failed === 1 ? "1 step didn't finish" : `${failed} steps didn't finish`}`;
  return line;
}

/**
 * The one line the transcript shows for a turn's work. While a step runs it says
 * what is happening now and where it sits in the run ("Running a command · 2 of
 * 3"); once every step has settled it is the summary ("Worked with the terminal
 * · 2 steps"). The steps themselves wait behind the line, never stacked in the chat.
 */
export function describeWorkLine(steps: ReadonlyArray<WorkStep>): string {
  const position = steps.findLastIndex((step) => step.state === "running");
  const running = position >= 0 ? steps[position] : undefined;
  if (!running) return summarizeWork(steps);
  const doing = running.doing.charAt(0).toUpperCase() + running.doing.slice(1);
  return steps.length > 1 ? `${doing} · ${position + 1} of ${steps.length}` : doing;
}

/** The small print beside the steps: "2 of 3 done", "3 steps", "3 steps · 1 didn't finish". */
export function describeWorkProgress(steps: ReadonlyArray<WorkStep>): string {
  const done = steps.filter((step) => step.state === "done").length;
  const failed = steps.filter((step) => step.state === "failed").length;
  if (steps.some((step) => step.state === "running")) return `${done} of ${steps.length} done`;
  const count = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  return failed ? `${count} · ${failed} didn't finish` : count;
}

/** Inspection is an allowlist, not redaction of arbitrary tool payloads. */
export const EXECUTION_KINDS = {
  read: "File reading",
  edit: "File editing",
  search: "File search",
  command: "Command execution",
  web: "Web access",
  connected: "Connected tool",
  document: "Document work",
  memory: "Memory work",
  assignment: "Assignment management",
  team: "Team collaboration",
  worker: "Worker coordination",
  plan: "Plan update",
  question: "Request for your input",
  other: "Tool call",
};
export type ExecutionKind = keyof typeof EXECUTION_KINDS;
export const EXECUTION_STATES = {
  pending: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Status unavailable",
};
export type ExecutionState = keyof typeof EXECUTION_STATES;
export type ExecutionMetadataInput = {
  tool: string;
  status?: string | null;
  /** Engine timestamps only; do not substitute receipt/poll time. */
  startedAt?: number | null;
  completedAt?: number | null;
};
export type ExecutionMetadata = {
  kind: ExecutionKind;
  status: ExecutionState;
  startedAt: number | null;
  completedAt: number | null;
};

export function executionKind(tool: string): ExecutionKind {
  if (tool.length > 128) return "other";
  const name = tool.toLowerCase();
  if (name === "coworker_team_consult") return "team";
  if (documentToolName(name)) return "document";
  if (workerToolName(name)) return "worker";
  const own = coworkerToolName(name);
  if (own) return isTeamTool(own) ? "team" : isAssignmentTool(own) ? "assignment" : "memory";
  switch (name) {
    case "search": return "search";
    case "command": return "command";
    case "web": return "web";
    case "connected": return "connected";
    case "document": return "document";
    case "memory": return "memory";
    case "assignment": return "assignment";
    case "team": return "team";
    case "worker": return "worker";
    case "plan": return "plan";
    case "read": return "read";
    case "edit": case "write": case "multiedit": case "apply_patch": return "edit";
    case "glob": case "grep": case "list": case "ls": return "search";
    case "bash": case "shell": return "command";
    case "webfetch": case "fetch": case "websearch": return "web";
    case "todowrite": case "todoread": return "plan";
    case "task": return "worker";
    case "question": return "question";
    default: return name.startsWith("openwork-cloud_") ? "connected" : "other";
  }
}

export function executionState(status: string | null | undefined): ExecutionState {
  switch (status) {
    case "pending": case "queued": return "pending";
    case "running": return "running";
    case "completed": case "success": case "succeeded": return "completed";
    case "error": case "failed": return "failed";
    case "cancelled": case "canceled": case "stopped": case "aborted": return "cancelled";
    default: return "unknown";
  }
}

export function executionTimestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function executionMetadata(call: ExecutionMetadataInput): ExecutionMetadata {
  return {
    kind: executionKind(call.tool),
    status: executionState(call.status),
    startedAt: executionTimestamp(call.startedAt),
    completedAt: executionTimestamp(call.completedAt),
  };
}

export function executionDuration(metadata: Pick<ExecutionMetadata, "status" | "startedAt" | "completedAt">, now: number): string {
  const start = metadata.startedAt;
  const end = metadata.completedAt ?? (metadata.status === "running" ? now : null);
  if (start === null || end === null || end < start || !Number.isFinite(end)) return "Duration unavailable";
  return `${sinceMoment(start, end)}${metadata.completedAt === null ? " elapsed" : " recorded"}`;
}

/** The collapsed activity receipt is just as private as the open inspection. */
export function summarizeExecution(calls: readonly ExecutionMetadataInput[]): string {
  if (!calls.length) return "";
  const metadata = calls.map(executionMetadata);
  const only = metadata.length === 1 ? metadata[0] : null;
  if (only) return `${EXECUTION_KINDS[only.kind]}: ${EXECUTION_STATES[only.status]}`;
  const counts = new Map<ExecutionState, number>();
  for (const step of metadata) counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
  return `${calls.length} observed steps: ${[...counts].map(([status, count]) => `${count} ${EXECUTION_STATES[status].toLowerCase()}`).join(", ")}`;
}

/** A bounded display name, never an unrestricted tool result or command. */
export function safeWorkLabel(value: string, fallback: string): string {
  const label = value.trim().replace(/[\r\n\t]+/g, " ");
  if (!label || label.length > 180 || /https?:\/\/|bearer\s|\bsk-[\w-]{12,}|(?:token|password|api[_ -]?key)\s*[:=]/i.test(label)) return fallback;
  return label;
}

/** Worker management is app-owned structured data; retain its named receipt. */
export function summarizeWorkerReceipt(calls: readonly WorkStepInput[]): string {
  const generic = summarizeExecution(calls);
  if (!calls.length || !calls.every((call) => workerToolName(call.tool))) return generic;
  return safeWorkLabel(describeWorkLine(calls.map(describeWorkStep)), generic);
}
