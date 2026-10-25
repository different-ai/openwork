import type { Part } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";

/** Native snapshot change evidence belongs to this assistant message, not the
 * prose/tool text that happened to arrive beside it. Preserve it on both live
 * events and history reads; it is not a user-visible activity/result row. */
export function fileChangeUIPart(part: Extract<Part, { type: "patch" }>): UIMessage["parts"][number] {
  return { type: "data-openwork-file-change", id: part.id, data: { files: part.files, hash: part.hash } };
}
