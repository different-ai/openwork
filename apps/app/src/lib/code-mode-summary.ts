import type { DynamicToolUIPart } from "ai";
import { getCapabilityCallSentence } from "./capability-call";

/** A summary of the work, not a mirror of whichever child happened to run last. */
export function codeModeSummary(
  calls: DynamicToolUIPart[],
  options: {
    running: boolean;
    failed: boolean;
    serviceName: (call: DynamicToolUIPart) => string | null;
  },
): string {
  if (options.failed) return "Couldn't finish this step";
  if (calls.length === 0) return options.running ? "Working on this step" : "Worked on this step";

  const changes = calls.filter((call) => {
    const name = call.toolName.endsWith("_execute_capability") && typeof call.input === "object" && call.input !== null && "name" in call.input
      ? call.input.name : call.toolName;
    if (typeof name !== "string") return false;
    const action = name.split(/[.:/]/).at(-1) ?? "";
    return /(?:^|_)(create|save|add|send|post|update|edit|write|delete|remove|publish|move|rename)(?:_|[A-Z]|$)/i.test(action);
  });
  if (changes.length === 1) {
    const call = changes[0]!;
    const sentence = getCapabilityCallSentence(call, { connectionName: options.serviceName(call), includeQuery: false });
    const label = options.running && (call.state === "input-available" || call.state === "input-streaming") ? sentence.present : sentence.past;
    // A successful write is more informative than a later read. Don't report
    // success for a write the engine says failed.
    if (call.state !== "output-error") {
      const service = options.serviceName(call);
      const input = typeof call.input === "object" && call.input !== null ? call.input : null;
      const raw = input && "name" in input && typeof input.name === "string" ? input.name : call.toolName;
      const action = raw.split(/[.:/]/).at(-1) ?? "";
      const creating = options.running && (call.state === "input-available" || call.state === "input-streaming");
      const body = input && "body" in input && typeof input.body === "object" && input.body !== null ? input.body : null;
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
  return `${options.running ? "Looking up" : "Looked up"} ${names || "information"}`;
}
