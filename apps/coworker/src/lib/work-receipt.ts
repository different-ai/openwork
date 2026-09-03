/**
 * How a coworker's tool work reads to a person: one step per tool call in
 * everyday words, one line summing the work up, and one phrase for the live
 * progress row. Pure, so the copy for each tool is unit-tested and the
 * transcript only renders what these return. Technical names stay available to
 * the details disclosure, never in the collapsed line.
 */

export type WorkStepInput = {
  tool: string;
  status: string;
  input: Record<string, unknown>;
  error?: string | null;
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

/** One tool call as a step a person can read. */
export function describeWorkStep(call: WorkStepInput): WorkStep {
  const state = workStepState(call.status);
  const tool = call.tool;
  const normalized = tool.toLowerCase();
  const input = call.input ?? {};
  const file = fileFrom(input);

  const step = (label: string, doing: string, service: string): WorkStep => ({ label, doing, service, state, tool });

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

export type ProgressPhase = "sending" | "thinking" | "tool" | "writing" | "retrying" | "finishing";

/**
 * The live progress row's one phrase. It changes only when the phase changes:
 * "Nova is thinking…", "Nova is editing index.md…", "Nova is putting it together…".
 */
export function describeProgress(name: string, phase: ProgressPhase, activeStep?: Pick<WorkStep, "doing"> | null): string {
  switch (phase) {
    case "sending":
      return "Sending…";
    case "tool":
      return `${name} is ${activeStep?.doing ?? "using a tool"}…`;
    case "writing":
      return `${name} is putting it together…`;
    case "retrying":
      return `${name} is trying again…`;
    case "finishing":
      return `${name} is finishing up…`;
    default:
      return `${name} is thinking…`;
  }
}

/** One labelled block inside a step's technical details. */
export type TechnicalSection = { label: "Command" | "Input" | "Result" | "Error"; text: string };

/** Keep a technical block readable: enough to understand, never a wall. */
export const TECHNICAL_TEXT_LIMIT = 1200;

function clipText(text: string, limit = TECHNICAL_TEXT_LIMIT): string {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * The technical view of one tool call, as labelled blocks: a shell command on its own,
 * any other input as tidy JSON, then the result and the error when there is one.
 * Text is clipped so the block keeps a sane height.
 */
export function technicalSections(call: { input: Record<string, unknown>; output?: unknown; error?: string | null }): TechnicalSection[] {
  const sections: TechnicalSection[] = [];
  const input = call.input ?? {};
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (command) sections.push({ label: "Command", text: clipText(command) });
  const rest = Object.fromEntries(Object.entries(input).filter(([key, value]) => !(command && key === "command") && value !== undefined && value !== ""));
  if (Object.keys(rest).length > 0) sections.push({ label: "Input", text: clipText(JSON.stringify(rest, null, 2)) });
  const result = renderValue(call.output).trim();
  if (result) sections.push({ label: "Result", text: clipText(result) });
  if (call.error) sections.push({ label: "Error", text: clipText(call.error) });
  return sections;
}
