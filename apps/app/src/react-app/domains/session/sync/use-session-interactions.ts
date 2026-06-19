// Pending permissions, questions, and todos for the selected session:
// query-cache subscriptions, snapshot seeding, and reply handlers.
// Extracted verbatim from session-route.tsx (cluster had no readers of its
// internals besides the JSX).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { unwrap } from "@/app/lib/opencode";
import type { Client, PendingPermission, PendingQuestion, TodoItem } from "@/app/types";
import { t } from "@/i18n";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { useQueryCacheState } from "@/react-app/infra/query-cache-state";
import { describeRouteError } from "@/react-app/shell/route-workspaces";
import {
  permissionKey,
  questionKey,
  seedPermissionState,
  seedQuestionState,
  todoKey,
} from "./session-sync";

const emptyPendingPermissions: PendingPermission[] = [];
const emptyPendingQuestions: PendingQuestion[] = [];
const emptyTodos: TodoItem[] = [];

export type UseSessionInteractionsInput = {
  client: Client | null;
  workspaceId: string;
  sessionId: string | null;
  workspaceRoot: string;
};

export function useSessionInteractions(input: UseSessionInteractionsInput) {
  const { client, workspaceId, sessionId, workspaceRoot } = input;

  const [permissionReplyBusy, setPermissionReplyBusy] = useState(false);
  const permissionReplyBusyRef = useRef(false);
  const [questionReplyBusy, setQuestionReplyBusy] = useState(false);
  const questionReplyBusyRef = useRef(false);

  const permissionQueryKey = useMemo(
    () => (workspaceId && sessionId ? permissionKey(workspaceId, sessionId) : null),
    [sessionId, workspaceId],
  );
  const pendingPermissions = useQueryCacheState<PendingPermission[]>(
    permissionQueryKey,
    emptyPendingPermissions,
  );
  const questionQueryKey = useMemo(
    () => (workspaceId && sessionId ? questionKey(workspaceId, sessionId) : null),
    [sessionId, workspaceId],
  );
  const pendingQuestions = useQueryCacheState<PendingQuestion[]>(
    questionQueryKey,
    emptyPendingQuestions,
  );
  const todoQueryKey = useMemo(
    () => (workspaceId && sessionId ? todoKey(workspaceId, sessionId) : null),
    [sessionId, workspaceId],
  );
  const todos = useQueryCacheState<TodoItem[]>(todoQueryKey, emptyTodos);

  useEffect(() => {
    if (!client || !workspaceId || !sessionId) return;
    let cancelled = false;
    const directory = workspaceRoot || undefined;
    void (async () => {
      const snapshotStartedAt = Date.now();
      try {
        const list: Parameters<typeof seedPermissionState>[2] = [];
        let readSucceeded = false;
        try {
          list.push(...unwrap(await client.permission.list({ directory })));
          readSucceeded = true;
        } catch {
          // Older/newer OpenCode permission APIs can fail independently.
        }
        try {
          list.push(...unwrap(await client.v2.session.permission.list({ sessionID: sessionId })).data);
          readSucceeded = true;
        } catch {
          // Keep the legacy snapshot if the v2 endpoint is unavailable.
        }
        if (!readSucceeded) return;
        if (!cancelled) {
          seedPermissionState(workspaceId, sessionId, list, { snapshotStartedAt });
        }
      } catch {
        // Keep event-synced permission state if the snapshot read fails.
        // Hiding a pending approval can block the running task.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, workspaceId, workspaceRoot]);

  useEffect(() => {
    if (!client || !workspaceId || !sessionId) return;
    let cancelled = false;
    const directory = workspaceRoot || undefined;
    void (async () => {
      const snapshotStartedAt = Date.now();
      try {
        const list = unwrap(await client.question.list({ directory }));
        if (!cancelled) {
          seedQuestionState(workspaceId, sessionId, list, { snapshotStartedAt });
        }
      } catch {
        // Keep event-synced question state if the snapshot read fails.
        // Hiding a pending question can block the running task.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, workspaceId, workspaceRoot]);

  const activePermission = pendingPermissions[0] ?? null;
  const respondPermission = useCallback(
    async (requestID: string, reply: "once" | "always" | "reject") => {
      if (!client || !workspaceId || !sessionId) return;
      if (permissionReplyBusyRef.current) return;
      permissionReplyBusyRef.current = true;
      setPermissionReplyBusy(true);
      try {
        const pendingPermission = pendingPermissions.find((permission) => permission.id === requestID);
        if (pendingPermission?.protocol === "v2") {
          const result = await client.v2.session.permission.reply({
            sessionID: pendingPermission.sessionID,
            requestID,
            reply,
          });
          if (result.error !== undefined) unwrap(result);
        } else {
          unwrap(
            await client.permission.reply({
              requestID,
              reply,
              directory: workspaceRoot || undefined,
            }),
          );
        }
        getReactQueryClient().setQueryData<PendingPermission[]>(
          permissionKey(workspaceId, sessionId),
          (current = []) => current.filter((permission) => permission.id !== requestID),
        );
      } catch (error) {
        toast.error(t("app.error_request_failed"), {
          description: describeRouteError(error),
        });
      } finally {
        permissionReplyBusyRef.current = false;
        setPermissionReplyBusy(false);
      }
    },
    [client, pendingPermissions, sessionId, workspaceId, workspaceRoot],
  );

  const activeQuestion = pendingQuestions[0] ?? null;
  const respondQuestion = useCallback(
    async (requestID: string, answers: string[][]) => {
      if (!client || !workspaceId || !sessionId) return;
      if (questionReplyBusyRef.current) return;
      questionReplyBusyRef.current = true;
      setQuestionReplyBusy(true);
      try {
        unwrap(
          await client.question.reply({
            requestID,
            answers,
            directory: workspaceRoot || undefined,
          }),
        );
        getReactQueryClient().setQueryData<PendingQuestion[]>(
          questionKey(workspaceId, sessionId),
          (current = []) => current.filter((question) => question.id !== requestID),
        );
      } catch (error) {
        toast.error(t("app.error_request_failed"), {
          description: describeRouteError(error),
        });
      } finally {
        questionReplyBusyRef.current = false;
        setQuestionReplyBusy(false);
      }
    },
    [client, sessionId, workspaceId, workspaceRoot],
  );

  return {
    activePermission,
    permissionReplyBusy,
    respondPermission,
    activeQuestion,
    questionReplyBusy,
    respondQuestion,
    todos,
  };
}
