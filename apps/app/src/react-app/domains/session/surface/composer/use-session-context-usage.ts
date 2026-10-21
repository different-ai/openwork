import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { Client, ModelRef } from "@/app/types";
import { useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { measuredUsageKey, useMeasuredUsageStore } from "../../sync/measured-usage-store";
import {
  buildContextUsage,
  contextLimitFor,
  latestMeasuredUsage,
  pickMeasuredUsage,
  readCompactionSettings,
  type ContextUsage,
} from "./context-usage";

const COMPACTION_SETTINGS_STALE_MS = 60_000;

type MessageWithUsage = Parameters<typeof latestMeasuredUsage>[0][number];

/**
 * How full the context of a session is, from numbers the app already holds: the
 * usage the provider reported for the latest reply (live, or from history), the
 * selected model's window from the provider catalog the picker keeps, and the
 * engine's compaction settings. Nothing here asks a model anything.
 */
export function useSessionContextUsage(input: {
  enabled: boolean;
  workspaceId: string;
  sessionId: string;
  opencodeBaseUrl: string;
  workspaceRoot: string;
  opencodeClient: Client | null;
  serverClient: OpenworkServerClient;
  selectedModel: ModelRef;
  /** Messages of the history read, oldest first. */
  messages: readonly MessageWithUsage[] | undefined;
}): ContextUsage | null {
  const { enabled, workspaceId, sessionId, opencodeBaseUrl, workspaceRoot, opencodeClient, serverClient, selectedModel, messages } = input;
  const engine = isOpencodeV2BaseUrl(opencodeBaseUrl) ? "v2" : "v1";

  const providers = useProviderListQuery({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    directory: workspaceRoot || undefined,
    enabled,
  }).data;

  const settings = useQuery({
    queryKey: ["session-context-compaction-settings", workspaceId],
    queryFn: async () => readCompactionSettings((await serverClient.getConfig(workspaceId)).opencode?.compaction),
    enabled,
    staleTime: COMPACTION_SETTINGS_STALE_MS,
    retry: false,
  }).data;

  const live = useMeasuredUsageStore((state) => state.bySession[measuredUsageKey(workspaceId, sessionId)]);
  const history = useMemo(() => (messages ? latestMeasuredUsage(messages, engine) : null), [messages, engine]);
  const measured = useMemo(
    () => pickMeasuredUsage(live, history, messages?.map((message) => message.info.id) ?? []),
    [live, history, messages],
  );
  const limit = useMemo(() => contextLimitFor(providers, selectedModel), [providers, selectedModel]);

  return useMemo(
    () => (enabled ? buildContextUsage({ measured, engine, limit, settings }) : null),
    [enabled, measured, engine, limit, settings],
  );
}
