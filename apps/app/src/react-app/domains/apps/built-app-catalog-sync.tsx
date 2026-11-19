import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { useAppsClient } from "./use-apps";
import { builtAppSummary, latestBuiltAppParts } from "./built-mcp-app-model";

/** Builder results already belong to the member catalog; refresh it, never pin them. */
export function BuiltAppCatalogSync({ messages }: { messages: UIMessage[] }) {
  const context = useAppsClient();
  const queryClient = useQueryClient();
  const scopeKey = JSON.stringify(context.scope);
  const seen = useRef({ scopeKey, revisions: new Set<string>() });
  useEffect(() => {
    if (!context.identityVerified) return;
    if (seen.current.scopeKey !== scopeKey) {
      seen.current = { scopeKey, revisions: new Set() };
    }
    let changed = false;
    for (const part of latestBuiltAppParts(messages)) {
      const app = builtAppSummary(part);
      if (!app) continue;
      const revision = `${part.toolCallId}:${app.appId}:${app.revisionId}`;
      if (seen.current.revisions.has(revision)) continue;
      seen.current.revisions.add(revision);
      changed = true;
    }
    if (changed) {
      void queryClient.invalidateQueries({ queryKey: ["built-dashboard-apps", ...context.scope], exact: true });
    }
  }, [messages, scopeKey, context.identityVerified, context.scope, queryClient]);
  return null;
}
