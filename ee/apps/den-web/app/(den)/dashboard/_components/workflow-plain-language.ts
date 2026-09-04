import type { WorkflowGraph, WorkflowGraphNode } from "@openwork/types/workflows";

const ACTIONS = new Set(["get", "list", "search", "read", "send", "create", "update", "delete"]);
const SERVICE_PREFIXES = [
  ["google", "workspace"],
  ["marketplace"],
  ["openwork"],
  ["codemode"],
  ["calendar"],
  ["gmail"],
  ["drive"],
  ["docs"],
  ["sheets"],
  ["slack"],
  ["den"],
];

function identifierWords(name: string): string[] {
  return name
    .replace(/^\$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.\-/]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function stripServicePrefix(words: string[]): string[] {
  const lower = words.map((word) => word.toLowerCase());
  const prefix = SERVICE_PREFIXES.find((candidate) => candidate.every((word, index) => lower[index] === word));
  return prefix ? words.slice(prefix.length) : words;
}

function displayWord(word: string): string {
  const lower = word.toLowerCase();
  if (lower === "me") return "my";
  if (lower === "org") return "organization";
  if (lower === "orgs") return "organizations";
  if (lower === "gmail") return "Gmail";
  if (lower === "slack") return "Slack";
  if (lower === "google") return "Google";
  if (lower === "openwork") return "OpenWork";
  if (lower === "api") return "API";
  if (lower === "id") return "ID";
  if (lower === "ids") return "IDs";
  if (lower === "iso") return "ISO";
  return lower;
}

function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function lowerFirst(value: string): string {
  return value ? `${value[0].toLowerCase()}${value.slice(1)}` : value;
}

export function humanizeIdentifier(name: string): string {
  let words = identifierWords(name);
  const first = words[0]?.toLowerCase();
  if (first === "post" && words[1]?.toLowerCase() === "capabilities") words = words.slice(2);
  else if (ACTIONS.has(first) && words[1]?.toLowerCase() === "capabilities") words = [words[0], ...words.slice(2)];

  if (ACTIONS.has(words[0]?.toLowerCase())) {
    const action = words[0];
    words = [action, ...stripServicePrefix(words.slice(1))];
  } else {
    const withoutService = stripServicePrefix(words);
    if (withoutService.length < words.length && ACTIONS.has(withoutService[0]?.toLowerCase())) words = withoutService;
  }

  const text = words.map(displayWord).join(" ");
  return capitalize(text || name);
}

export function serviceName(namespace: string): string {
  if (namespace === "google_workspace") return "Google Workspace";
  if (namespace === "slack") return "Slack";
  if (namespace === "den") return "OpenWork";
  if (namespace === "marketplace") return "Marketplace";
  if (namespace === "$codemode") return "Search";
  if (namespace === "gmail") return "Gmail";
  if (namespace === "calendar") return "Google Calendar";
  if (namespace === "drive") return "Google Drive";
  if (namespace === "docs") return "Google Docs";
  if (namespace === "sheets") return "Google Sheets";
  return humanizeIdentifier(namespace);
}

export function serviceTone(namespace: string): string {
  if (namespace === "slack") return "bg-fuchsia-50 text-fuchsia-700";
  if (namespace === "google_workspace") return "bg-amber-50 text-red-700";
  if (namespace === "gmail") return "bg-red-50 text-red-700";
  if (namespace === "calendar") return "bg-blue-50 text-blue-700";
  if (namespace === "drive") return "bg-green-50 text-green-700";
  if (namespace === "docs") return "bg-blue-50 text-blue-700";
  if (namespace === "sheets") return "bg-emerald-50 text-emerald-700";
  if (namespace === "den") return "bg-blue-50 text-blue-700";
  if (namespace === "marketplace") return "bg-violet-50 text-violet-700";
  return "bg-gray-100 text-gray-600";
}

function googleSubService(node: Extract<WorkflowGraphNode, { kind: "tool" }>): string | null {
  const source = `${node.namespace} ${node.tool}`.toLowerCase();
  if (source.includes("gmail")) return "Gmail";
  if (source.includes("calendar")) return "Google Calendar";
  if (source.includes("drive")) return "Google Drive";
  if (source.includes("docs")) return "Google Docs";
  if (source.includes("sheets")) return "Google Sheets";
  return null;
}

export function describeToolStep(node: Extract<WorkflowGraphNode, { kind: "tool" }>): { title: string; service: string } {
  return {
    title: humanizeIdentifier(node.tool),
    service: googleSubService(node) ?? serviceName(node.namespace),
  };
}

function pathText(value: string): string | null {
  const normalized = value.trim().replace(/\?\./g, ".").replace(/^input\./, "");
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(normalized)) return null;
  const length = normalized.endsWith(".length");
  const path = length ? normalized.slice(0, -".length".length) : normalized;
  const words = path.split(".").map((part) => lowerFirst(humanizeIdentifier(part))).join(" ");
  return length ? `the number of ${words}` : words;
}

function operandText(value: string): string | null {
  const trimmed = value.trim();
  if (/^(["']).*\1$/.test(trimmed)) return trimmed;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed) || trimmed === "true" || trimmed === "false") return trimmed;
  return pathText(trimmed);
}

export function describeCondition(label: string): { text: string; technical: boolean } {
  let condition = label.trim();
  condition = condition.replace(/^input\s*&&\s*/, "").replace(/^input\?\./, "");

  const missing = condition.match(/^!\s*([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)$/);
  if (missing) {
    const subject = pathText(missing[1]);
    if (subject) return { text: `${capitalize(subject)} is missing`, technical: false };
  }

  const both = condition.split(/\s*&&\s*/);
  if (both.length === 2) {
    const left = pathText(both[0]);
    const right = pathText(both[1]);
    if (left && right) return { text: `${capitalize(left)} and ${capitalize(right)} are set`, technical: false };
  }

  const comparison = condition.match(/^(.+?)\s*(>=|<=|!==|===|==|>|<)\s*(.+)$/);
  if (comparison) {
    const left = operandText(comparison[1]);
    const right = operandText(comparison[3]);
    const phrases: Record<string, string> = {
      ">": "is more than",
      "<": "is less than",
      ">=": "is at least",
      "<=": "is at most",
      "===": "is",
      "==": "is",
      "!==": "is not",
    };
    if (left && right) return { text: `${capitalize(left)} ${phrases[comparison[2]]} ${capitalize(right)}`, technical: false };
  }

  const subject = pathText(condition);
  if (subject) return { text: `${capitalize(subject)} is set`, technical: false };
  return { text: `Check: ${label}`, technical: true };
}

export function describeReturn(label: string): string {
  const trimmed = label.trim();
  if (trimmed === "value" || trimmed === "undefined" || trimmed.toLowerCase() === "return") return "Finish";
  const object = trimmed.match(/^\{\s*(.*?)\s*\}$/);
  if (!object) return "Finish with the result";
  if (!object[1]) return "Finish";
  const keys = object[1].split(",").map((part) => part.trim().replace(/^\.\.\./, "").split(":")[0].trim());
  if (keys.some((key) => !/^[A-Za-z_$][\w$]*$/.test(key))) return "Finish with the result";
  return `Finish with: ${keys.map(humanizeIdentifier).join(", ")}`;
}

export function describeLoop(label: string): string {
  const subject = pathText(label);
  return subject ? `For each item in ${subject}` : "Repeat";
}

function listSentence(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

export function summarizeGraph(graph: WorkflowGraph): { stepCount: number; services: string[]; sentence: string } {
  const toolSteps = graph.nodes.flatMap((node) => node.kind === "tool" ? [describeToolStep(node)] : []);
  const services = [...new Set(toolSteps.map((step) => step.service))];
  const readsOnly = toolSteps.every((step) => /^(Get|List|Search|Read)\b/.test(step.title));
  const opening = services.length > 0 ? `${readsOnly ? "Reads from" : "Uses"} ${listSentence(services)}` : "Runs its steps";
  const branchCount = graph.nodes.filter((node) => node.kind === "branch").length;
  const decision = branchCount === 0 ? "" : branchCount === 1 ? " with one decision" : ` with ${branchCount} decisions`;
  const parallel = graph.nodes.some((node) => node.kind === "tool" && node.parallelGroup) ? " while some steps run at the same time" : "";
  return {
    stepCount: graph.nodes.length,
    services,
    sentence: `${opening}${decision}${parallel}, then finishes with a summary.`,
  };
}
