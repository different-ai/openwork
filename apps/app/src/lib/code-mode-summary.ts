import type { DynamicToolUIPart } from "ai";
import { getCapabilityCallSentence, type CapabilityCallSentence } from "./capability-call";

/** A summary of the work, not a mirror of whichever child happened to run last. */
export function codeModeSummary(
  calls: DynamicToolUIPart[],
  options: {
    running: boolean;
    failed: boolean;
    serviceName: (call: DynamicToolUIPart) => string | null;
    /** A sentence the caller knows better (OpenWork's own tools, skills); null falls back. */
    sentence?: (call: DynamicToolUIPart) => CapabilityCallSentence | null;
    /** A call the organization's policy refused: neutral, never a failure (C5). */
    isBlocked?: (call: DynamicToolUIPart) => boolean;
  },
): string {
  const sentenceOf = (call: DynamicToolUIPart, includeQuery = false) =>
    options.sentence?.(call) ?? getCapabilityCallSentence(call, { connectionName: options.serviceName(call), includeQuery });
  const blocked = calls.filter((call) => call.state === "output-error" && options.isBlocked?.(call) === true);
  if (blocked.length > 0 && blocked.length === calls.filter((call) => call.state === "output-error").length) {
    return blocked.length === 1 ? "Sharing is blocked by your organization" : `${blocked.length} actions are blocked by your organization`;
  }
  const failedCalls = calls.filter((call) => call.state === "output-error");
  // A finished script whose every call failed did not "look up" anything,
  // even when the engine reports the script itself as completed.
  const allFailed = !options.running && calls.length > 0 && failedCalls.length === calls.length;
  if (options.failed || allFailed) {
    // Name what failed when one call did ("Script on OpenWork Cloud failed").
    const only = failedCalls.length === 1 ? failedCalls[0] : undefined;
    const failure = only ? sentenceOf(only).failure : undefined;
    return failure ?? "Script failed";
  }
  if (calls.length === 0) return options.running ? "Running a script" : "Ran a script";

  const changes = calls.filter((call) => {
    const name = call.toolName.endsWith("_execute_capability") && typeof call.input === "object" && call.input !== null && "name" in call.input
      ? call.input.name : call.toolName;
    if (typeof name !== "string") return false;
    const action = name.split(/[.:/]/).at(-1) ?? "";
    return /(?:^|_)(create|save|add|send|post|update|edit|write|delete|remove|publish|move|rename)(?:_|[A-Z]|$)/i.test(action);
  });
  if (changes.length === 1) {
    const call = changes[0]!;
    const sentence = sentenceOf(call);
    const label = options.running && (call.state === "input-available" || call.state === "input-streaming") ? sentence.present : sentence.past;
    // A successful write is more informative than a later read. Don't report
    // success for a write the engine says failed.
    if (call.state !== "output-error") {
      const service = options.serviceName(call);
      const input = typeof call.input === "object" && call.input !== null ? call.input : null;
      const raw = input && "name" in input && typeof input.name === "string" ? input.name : call.toolName;
      const action = raw.split(/[.:/]/).at(-1) ?? "";
      const creating = options.running && (call.state === "input-available" || call.state === "input-streaming");
      const args = input && "arguments" in input && typeof input.arguments === "object" && input.arguments !== null ? input.arguments : null;
      const nested = args && "body" in args && typeof args.body === "object" && args.body !== null ? args.body : null;
      const body = nested ?? args ?? (input && "body" in input && typeof input.body === "object" && input.body !== null ? input.body : null);
      if (/(?:^|_)save_issue$/.test(action)) {
        const updating = body && "id" in body && typeof body.id === "string" && body.id.length > 0;
        const verb = updating ? (creating ? "Updating" : "Updated") : (creating ? "Creating" : "Created");
        return `${verb} an issue${service ? ` in ${service}` : ""}`;
      }
      if (/(?:^|_)create_(issue|note|task|document)$/.test(action)) {
        const subject = action.split("_").at(-1);
        const article = subject === "issue" ? "an" : "a";
        return `${creating ? "Creating" : "Created"} ${article} ${subject}${service ? ` in ${service}` : ""}`;
      }
      return service && !label.includes(service) ? `${label} in ${service}` : label;
    }
  }

  const services = [...new Set(calls.map(options.serviceName).filter((name): name is string => Boolean(name)))];
  const names = services.length > 2 ? `${services.slice(0, 2).join(", ")} and others`
    : services.join(" and ");
  if (changes.length > 0) {
    const verb = options.running ? "Changing" : changes.every(call => call.state === "output-error") ? "Tried to change" : "Changed";
    return `${verb} ${names || "connected services"}`;
  }
  // A group of searches says so ("Searched Exa"), not a vague "Looked up".
  const allSearches = calls.length > 0 && calls.every((call) =>
    getCapabilityCallSentence(call, { includeQuery: false }).past.startsWith("Searched "));
  if (allSearches && names) return `${options.running ? "Searching" : "Searched"} ${names}`;
  return `${options.running ? "Looking up" : "Looked up"} ${names || "information"}`;
}
