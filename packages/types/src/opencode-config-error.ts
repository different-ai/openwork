/**
 * OpenCode answers every request for a folder whose config file it cannot
 * read with `ConfigInvalidError` (a setting has the wrong shape) or
 * `ConfigJsonError` (the file is not valid JSON), naming the file and field.
 */
export type OpencodeConfigProblem = {
  path: string | null;
  problems: string[];
};

const MAX_LISTED_PROBLEMS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issueText(issue: unknown): string | null {
  if (!isRecord(issue) || typeof issue.message !== "string" || !issue.message.trim()) return null;
  const field = Array.isArray(issue.path)
    ? issue.path.filter((part) => typeof part === "string" || typeof part === "number").join(".")
    : "";
  return field ? `${field}: ${issue.message.trim()}` : issue.message.trim();
}

function jsonErrorText(message: string): string {
  // The engine embeds the whole file; keep only its list of parse errors.
  const errors = /--- Errors ---\n([\s\S]*?)(?:\n--- End ---|$)/.exec(message)?.[1];
  const lines = (errors ?? message).split("\n").map((line) => line.trim()).filter(Boolean);
  return [...new Set(lines)].join("; ") || "The file is not valid JSON.";
}

export function readOpencodeConfigProblem(body: unknown): OpencodeConfigProblem | null {
  if (!isRecord(body)) return null;
  const name = typeof body.name === "string" ? body.name : typeof body._tag === "string" ? body._tag : null;
  if (name !== "ConfigInvalidError" && name !== "ConfigJsonError") return null;
  const data = isRecord(body.data) ? body.data : body;
  const path = typeof data.path === "string" && data.path.trim() ? data.path.trim() : null;
  const issues = Array.isArray(data.issues) ? data.issues.flatMap((issue) => issueText(issue) ?? []) : [];
  const message = typeof data.message === "string" && data.message.trim() ? data.message : null;
  const problems = issues.length
    ? issues
    : message
      ? [name === "ConfigJsonError" ? jsonErrorText(message) : message.trim()]
      : [];
  return { path, problems };
}

const CONFIG_PROBLEM_PREFIX = "OpenCode can't use ";

/** True for a sentence written by `describeOpencodeConfigProblem`. */
export function isOpencodeConfigErrorMessage(message: string): boolean {
  return message.startsWith(CONFIG_PROBLEM_PREFIX) && message.includes("config file");
}

export function describeOpencodeConfigProblem(problem: OpencodeConfigProblem): string {
  const file = problem.path ? `${CONFIG_PROBLEM_PREFIX}the config file ${problem.path}` : `${CONFIG_PROBLEM_PREFIX}its config file`;
  const listed = problem.problems.slice(0, MAX_LISTED_PROBLEMS);
  const more = problem.problems.length - listed.length;
  const detail = listed.length ? `: ${listed.join("; ")}${more > 0 ? ` (and ${more} more)` : ""}` : ".";
  return `${file}${detail}${detail.endsWith(".") ? "" : "."} Fix or remove that setting, then try again.`;
}

/** The readable sentence for an engine config error body, or null for any other error. */
export function describeOpencodeConfigError(body: unknown): string | null {
  const problem = readOpencodeConfigProblem(body);
  return problem ? describeOpencodeConfigProblem(problem) : null;
}
