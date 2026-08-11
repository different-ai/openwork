/**
 * Host-side fulfillment of declarative capability file inputs (SEP-2356 shape).
 *
 * Cloud capabilities never accept file bytes. A capability whose schema
 * declares an `x-mcp-file` field (for example gmail-drafts `attachments`)
 * accepts workspace file *paths* from the model and, when they reach the
 * cloud route unfulfilled, answers `file_input_requires_host` with a
 * descriptor naming the local extension action that owns the byte transport.
 *
 * This module is that fulfillment: a `tool.execute.after` hook spots the
 * descriptor on `openwork-cloud_execute_capability` results, re-runs the
 * request through the described local action (the authenticated multipart
 * lane), and rewrites the tool result in place. The model sees one
 * capability and one successful call; bytes never transit model context.
 */

export const OPENWORK_CLOUD_EXECUTE_CAPABILITY_TOOL = "openwork-cloud_execute_capability";

export type FileInputDescriptor = {
  /** Capability body field that carried workspace file paths. */
  field: string;
  /** Local extension that owns the byte transport. */
  extensionId: string;
  /** Extension action to invoke. */
  action: string;
  /** Action argument that receives the workspace file paths. */
  argsField: string;
};

export type FileInputExtensionCall = {
  extensionId: string;
  action: string;
  args: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

function readTextPayload(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result) || !Array.isArray(result.content)) return null;
  for (const item of result.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(item.text);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON — keep scanning.
    }
  }
  return null;
}

export function readFileInputDescriptor(result: unknown): FileInputDescriptor | null {
  const payload = readTextPayload(result);
  if (!payload || payload.error !== "file_input_requires_host") return null;
  const fileInput = payload.fileInput;
  if (!isRecord(fileInput)) return null;
  const descriptor = {
    field: readString(fileInput, "field"),
    extensionId: readString(fileInput, "extensionId"),
    action: readString(fileInput, "action"),
    argsField: readString(fileInput, "argsField"),
  };
  if (!descriptor.field || !descriptor.extensionId || !descriptor.action || !descriptor.argsField) return null;
  return descriptor;
}

export function buildFileInputExtensionCall(args: unknown, descriptor: FileInputDescriptor): FileInputExtensionCall | null {
  if (!isRecord(args) || !isRecord(args.body)) return null;
  const { [descriptor.field]: files, ...rest } = args.body;
  if (!Array.isArray(files) || files.length === 0) return null;
  if (!files.every((item) => typeof item === "string" && item.trim().length > 0)) return null;
  return {
    extensionId: descriptor.extensionId,
    action: descriptor.action,
    args: { ...rest, [descriptor.argsField]: files },
  };
}

function replaceToolResultContent(result: unknown, payload: unknown, isError: boolean): void {
  if (!isRecord(result)) return;
  result.content = [{ type: "text", text: JSON.stringify(payload) }];
  result.isError = isError;
}

/**
 * Rewrites `result` in place when it is a `file_input_requires_host` answer
 * from the cloud execute tool. Returns true when a repair was attempted.
 * Anything unexpected leaves the result untouched so the model still sees
 * the cloud route's own actionable error.
 */
export async function repairFileInputToolResult(input: {
  tool: string;
  args: unknown;
  result: unknown;
  callExtensionAction: (call: FileInputExtensionCall) => Promise<unknown>;
}): Promise<boolean> {
  if (input.tool !== OPENWORK_CLOUD_EXECUTE_CAPABILITY_TOOL) return false;
  const descriptor = readFileInputDescriptor(input.result);
  if (!descriptor) return false;
  const call = buildFileInputExtensionCall(input.args, descriptor);
  if (!call) return false;
  try {
    const payload = await input.callExtensionAction(call);
    replaceToolResultContent(input.result, payload, false);
  } catch (error) {
    replaceToolResultContent(input.result, {
      error: "file_input_upload_failed",
      message: error instanceof Error ? error.message : String(error),
      fileInput: descriptor,
    }, true);
  }
  return true;
}
