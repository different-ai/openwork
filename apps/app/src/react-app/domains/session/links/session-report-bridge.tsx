/** @jsxImportSource react */
import { useEffect, useMemo, useRef } from "react";

import { markFeatureUsed } from "@/app/lib/den";
import { unwrap } from "@/app/lib/opencode";
import { createClientV2 } from "@/app/lib/opencode-v2-adapter";
import type { SessionListItem } from "../sidebar/utils";
import {
  deliverSessionReport,
  reportWakesParent,
  sessionReportCandidates,
  type SessionReportClient,
} from "./session-report";

type V2Client = ReturnType<typeof createClientV2>;

function reportClient(client: V2Client): SessionReportClient {
  return {
    runEnd: async (sessionID) => unwrap(await client.sessionRunEnd({ sessionID })),
    lastTurn: async (sessionID) => unwrap(await client.sessionLastTurn({ sessionID })),
    addNote: async (note) => unwrap(await client.addSessionNote(note)),
  };
}

export function SessionReportBridge({ sessions, statuses, engine }: {
  sessions: readonly SessionListItem[];
  statuses: Readonly<Record<string, string>> | undefined;
  engine: { baseUrl: string; directory: string | undefined; token: string | undefined } | null;
}) {
  const client = useMemo(
    () => engine ? reportClient(createClientV2(engine.baseUrl, engine.directory, { token: engine.token })) : null,
    [engine?.baseUrl, engine?.directory, engine?.token],
  );
  const memory = useRef({
    seen: new Set<string>(),
    handled: new Map<string, number>(),
    sawRunning: new Set<string>(),
    wakes: new Map<string, number[]>(),
  });

  useEffect(() => {
    if (!client) return;
    const state = memory.current;
    const now = Date.now();
    const { settled, running } = sessionReportCandidates({ sessions, statuses, now });
    for (const entry of running) state.sawRunning.add(entry.childId);
    if (state.seen.size > 2_000) state.seen.clear();
    for (const candidate of settled) {
      if (state.seen.has(candidate.key)) continue;
      state.seen.add(candidate.key);
      void deliverSessionReport(client, {
        candidate,
        handledIdleAt: state.handled.get(candidate.childId),
        wakes: ({ sentBy }) => reportWakesParent({
          sawRunning: state.sawRunning.has(candidate.childId),
          sentBy,
          parentId: candidate.parentId,
          siblingsRunning: running.some((entry) => entry.parentId === candidate.parentId),
          recentWakes: state.wakes.get(candidate.parentId) ?? [],
          now,
        }),
      }).then((result) => {
        if (!result) return;
        state.handled.set(candidate.childId, result.idleAt);
        state.sawRunning.delete(candidate.childId);
        if (result.woke) state.wakes.set(candidate.parentId, [...(state.wakes.get(candidate.parentId) ?? []).filter((at) => now - at < 60 * 60 * 1000), now]);
        if (result.added) markFeatureUsed("sessionTree");
      }).catch(() => {
        state.seen.delete(candidate.key);
      });
    }
  }, [client, sessions, statuses]);

  return null;
}
