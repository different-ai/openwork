import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DynamicToolUIPart, UIMessage } from "ai";

import {
  bashExitCode,
  isBashToolPart,
  isTaskToolPart,
  taskChildSessionId,
  toolPartChangedFiles,
  type ToolPartChangedFileKind,
} from "@/lib/build-in-tools";
import { isToolPartInFlight } from "@/lib/tool-activity";

import { transcriptKey } from "../sync/session-sync";

export type ThreadRunStatus = "running" | "completed" | "failed";

export interface ThreadFileChange {
  file: string;
  kind: ToolPartChangedFileKind;
  additions: number;
  deletions: number;
}

export interface ThreadSubagent {
  toolCallId: string;
  title: string;
  agentType: string;
  childSessionId: string | null;
  status: ThreadRunStatus;
}

export interface ThreadCommand {
  toolCallId: string;
  command: string;
  description: string | null;
  status: ThreadRunStatus;
  exitCode: number | null;
}

export interface ThreadActivity {
  changes: {
    files: ThreadFileChange[];
    additions: number;
    deletions: number;
  };
  subagents: ThreadSubagent[];
  commands: ThreadCommand[];
}

export const EMPTY_THREAD_ACTIVITY: ThreadActivity = {
  changes: { files: [], additions: 0, deletions: 0 },
  subagents: [],
  commands: [],
};

function runStatus(part: DynamicToolUIPart): ThreadRunStatus {
  if (part.state === "output-error") return "failed";
  return isToolPartInFlight(part) ? "running" : "completed";
}

/**
 * Aggregate a session transcript into the thread panel's overview: changed
 * files with summed diff stats, sub-agent runs, and terminal commands, each
 * in first-seen transcript order.
 */
export function deriveThreadActivity(messages: UIMessage[]): ThreadActivity {
  const filesByPath = new Map<string, ThreadFileChange>();
  const subagents: ThreadSubagent[] = [];
  const commands: ThreadCommand[] = [];

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;

      for (const change of toolPartChangedFiles(part)) {
        const current = filesByPath.get(change.file);
        if (current) {
          current.kind = change.kind;
          current.additions += change.additions ?? 0;
          current.deletions += change.deletions ?? 0;
          continue;
        }
        filesByPath.set(change.file, {
          file: change.file,
          kind: change.kind,
          additions: change.additions ?? 0,
          deletions: change.deletions ?? 0,
        });
      }

      if (isTaskToolPart(part)) {
        subagents.push({
          toolCallId: part.toolCallId,
          title: part.input?.description?.trim() || "Sub-agent task",
          agentType: part.input?.subagent_type?.trim() || "agent",
          childSessionId: taskChildSessionId(part),
          status: runStatus(part),
        });
        continue;
      }

      if (isBashToolPart(part)) {
        const command = part.input?.command?.trim();
        if (!command) continue;
        commands.push({
          toolCallId: part.toolCallId,
          command,
          description: part.input?.description?.trim() || null,
          status: runStatus(part),
          exitCode: bashExitCode(part),
        });
      }
    }
  }

  const files = Array.from(filesByPath.values());
  return {
    changes: {
      files,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    },
    subagents,
    commands,
  };
}

const EMPTY_TRANSCRIPT: UIMessage[] = [];

/**
 * Live thread activity for a session, derived from the shared transcript
 * cache that session sync keeps updated. The disabled query only subscribes;
 * the session surface owns fetching the snapshot.
 */
export function useThreadActivity(workspaceId: string | null, sessionId: string | null): ThreadActivity {
  const query = useQuery<UIMessage[], Error, UIMessage[], readonly unknown[]>({
    queryKey: transcriptKey(workspaceId ?? "", sessionId ?? ""),
    queryFn: async () => EMPTY_TRANSCRIPT,
    enabled: false,
  });
  const messages = workspaceId && sessionId ? query.data ?? EMPTY_TRANSCRIPT : EMPTY_TRANSCRIPT;
  return useMemo(() => deriveThreadActivity(messages), [messages]);
}
