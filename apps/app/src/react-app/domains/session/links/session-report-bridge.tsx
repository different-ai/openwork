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

/**
 * Reports finished sessions the agent started to the session that started
 * them, for the workspace this window follows live. Renders nothing.
 */
export function SessionReportBridge({ sessions, statuses, engine }: {
  sessions: readonly SessionListItem[];
  /** Each session's own live status, not the sidebar's roll-up of the sessions under it. */
  statuses: Readonly<Record<string, string>> | undefined;
  /** The workspace's v2 engine; null while chats there run on an engine that keeps no links. */
  engine: { baseUrl: string; directory: string | undefined; token: string | undefined } | null;
}) {
  const client = useMemo(
    () => engine ? reportClient(createClientV2(engine.baseUrl, engine.directory, { token: engine.token })) : null,
    [engine?.baseUrl, engine?.directory, engine?.token],
  );
  const memory = useRef({
    /** Candidate keys already looked at. */
    seen: new Set<string>(),
    /** The run end reported for each session. */
    handled: new Map<string, number>(),
    /** Sessions this window saw running since their last report. */
    sawRunning: new Set<string>(),
    /** When reports started each parent's turn. */
    wakes: new Map<string, number[]>(),
  });

  useEffect(() => {
    if (!client) return;
    const state = memory.current;
    const now = Date.now();
    const { settled, running } = sessionReportCandidates({ sessions, statuses, now });
    for (const entry of running) state.sawRunning.add(entry.childId);
    // Forgetting what was looked at only costs one repeated read per session.
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
        // The engine was unreachable: look again at this session's next change.
        state.seen.delete(candidate.key);
      });
    }
  }, [client, sessions, statuses]);

  return null;
}
