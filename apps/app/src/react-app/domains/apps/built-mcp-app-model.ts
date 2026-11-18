import type { DynamicToolUIPart, UIMessage } from "ai";
import {
  mcpAppSummarySchema,
  parseMcpAppResourceUri,
} from "@openwork/types/mcp-app";
import {
  builtMcpAppId,
  hasPreservedMcpAppResult,
} from "@/components/chat/mcp-app-frame";

export function isAppBuilderPart(part: DynamicToolUIPart): boolean {
  return /(?:^|_)(?:create_app|update_app)$/.test(part.toolName);
}

export function appBuilderResultFailed(part: DynamicToolUIPart): boolean {
  if (part.state === "output-error" || part.state === "output-denied")
    return true;
  const metadata = part.callProviderMetadata?.openwork;
  const result =
    metadata && typeof metadata === "object"
      ? Reflect.get(metadata, "mcpResult")
      : null;
  return Boolean(
    result &&
      typeof result === "object" &&
      Reflect.get(result, "isError") === true,
  );
}

/** Only the real builder result with a matching launch may open a preview. */
export function builtAppSummary(part: DynamicToolUIPart) {
  if (
    !isAppBuilderPart(part) ||
    part.state !== "output-available" ||
    !hasPreservedMcpAppResult(part)
  )
    return null;
  const metadata = part.callProviderMetadata?.openwork;
  if (!metadata || typeof metadata !== "object") return null;
  const result = Reflect.get(metadata, "mcpResult");
  if (
    !result ||
    typeof result !== "object" ||
    Reflect.get(result, "isError") === true
  )
    return null;
  const content = Reflect.get(result, "structuredContent");
  if (!content || typeof content !== "object") return null;
  const parsed = mcpAppSummarySchema.safeParse(Reflect.get(content, "app"));
  return parsed.success &&
    builtMcpAppId(part) === parsed.data.appId &&
    parseMcpAppResourceUri(parsed.data.resourceUri)?.revisionId ===
      parsed.data.revisionId
    ? parsed.data
    : null;
}

export function latestBuiltAppParts(messages: UIMessage[]) {
  const apps = new Map<string, DynamicToolUIPart>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      const app = builtAppSummary(part);
      if (app) apps.set(app.appId, part);
    }
  }
  return [...apps.values()];
}
