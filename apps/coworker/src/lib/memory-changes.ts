/**
 * How a recorded change to memory or soul reads in the Memory view's Recent
 * changes list: the same words as the action line in the conversation when the
 * coworker made it, "You edited…" when the person did, "Undid · …" for an undo.
 */
import type { MemoryChange } from "./bridge.ts";
import { coworkerToolName } from "./coworker-tools.ts";
import { describeWorkStep } from "./work-receipt.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** "the soul", "working memory", "the memory index", "the memory cleaning-day". */
export function describeMemoryFile(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "soul.md") return "the soul";
  if (normalized === "memory/working.md") return "working memory";
  if (normalized === "memory/index.md") return "the memory index";
  const file = normalized.split("/").pop() ?? normalized;
  return `the memory ${file.replace(/\.md$/, "")}`;
}

function describeFiles(files: MemoryChange["files"]): string {
  const names = [...new Set(files.map((file) => describeMemoryFile(file.path)))];
  if (names.length === 0) return "memory";
  if (names.length === 1) return names[0] ?? "memory";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * One change as action words. `all` lets an undo name what it undid; a change
 * that has since been undone still reads as what it did.
 */
export function describeMemoryChange(change: MemoryChange, all: readonly MemoryChange[] = []): string {
  if (change.actor === "undo") {
    const undone = change.undoes ? all.find((candidate) => candidate.id === change.undoes) : undefined;
    return undone ? `Undid · ${describeMemoryChange(undone, all)}` : "Undid an earlier change";
  }
  if (change.actor === "person") {
    switch (change.tool) {
      case "memory_create":
        return `You created a memory${text(change.input.title) ? ` · ${text(change.input.title)}` : ""}`;
      case "memory_delete":
        return `You deleted a memory${text(change.input.file) ? ` · ${text(change.input.file).replace(/\.md$/, "")}` : ""}`;
      case "memory_index":
        return "You listed a memory in the index";
      case "soul_update":
        return describeWorkStep({ tool: "coworker_soul_update", status: "completed", input: change.input, output: change.output }).label.replace(/^Updated how I work/, "You updated how I work");
      default:
        return `You edited ${describeFiles(change.files)}`;
    }
  }
  const tool = coworkerToolName(change.tool);
  if (tool) return describeWorkStep({ tool: `coworker_${tool}`, status: "completed", input: change.input, output: change.output }).label;
  return `Changed ${describeFiles(change.files)}`;
}
