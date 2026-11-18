export type ToolResultBlock = {
  kind: "json" | "text";
  text: string;
};

export type ToolResultPresentation = {
  blocks: ToolResultBlock[];
  isError: boolean;
  emptyMessage: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function textBlock(text: string): ToolResultBlock {
  try {
    // Parsing is for display only. The original response stays untouched.
    const parsed: unknown = JSON.parse(text);
    return { kind: "json", text: JSON.stringify(parsed, null, 2) ?? text };
  } catch {
    return { kind: "text", text };
  }
}

/** Select the MCP answer, never server metadata or binary content, for the first viewport. */
export function toolResultPresentation(result: unknown): ToolResultPresentation {
  const isError = isRecord(result) && result.isError === true;
  if (isRecord(result) && hasContent(result.structuredContent)) {
    return {
      blocks: [{ kind: "json", text: JSON.stringify(result.structuredContent, null, 2) ?? "null" }],
      isError,
      emptyMessage: null,
    };
  }

  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const blocks = content.flatMap((item): ToolResultBlock[] => (
    isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text.trim()
      ? [textBlock(item.text)]
      : []
  ));
  if (blocks.length > 0) return { blocks, isError, emptyMessage: null };

  // Locally generated failures have an error message rather than an MCP content array.
  if (isRecord(result) && typeof result.error === "string" && result.error.trim()) {
    return { blocks: [textBlock(result.error)], isError: true, emptyMessage: null };
  }
  if (typeof result === "string" && result.trim()) {
    return { blocks: [textBlock(result)], isError: false, emptyMessage: null };
  }
  return {
    blocks: [],
    isError,
    emptyMessage: content.length > 0
      ? "No readable text was returned. Open Technical details to inspect the full result."
      : "No result content was returned. Open Technical details to inspect the full result.",
  };
}
