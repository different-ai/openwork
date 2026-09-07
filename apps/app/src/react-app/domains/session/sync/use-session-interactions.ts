// Pending interactions for a conversation and its descendants. Requests stay
// owned by the session that asked; only their presentation bubbles to the parent.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { unwrap } from "@/app/lib/opencode";
import type { Client, PendingPermission, PendingQuestion, TodoItem } from "@/app/types";
import { t } from "@/i18n";
import { useQueryCacheArrayState, useQueryCacheState } from "@/react-app/infra/query-cache-state";
import { describeRouteError } from "@/react-app/shell/route-workspaces";
import {
  permissionKey,
  questionKey,
  seedPermissionState,
  seedQuestionState,
  settleQuestionState,
  settlePermissionState,
  todoKey,
} from "./session-sync";

const emptyPendingPermissions: PendingPermission[] = [];
const emptyPendingQuestions: PendingQuestion[] = [];
const emptyTodos: TodoItem[] = [];

export type UseSessionInteractionsInput = {
  client: Client | null;
  workspaceId: string;
  sessionId: string | null;
  interactionSessionIds?: string[];
  workspaceRoot: string;
};

export function useSessionInteractions(input: UseSessionInteractionsInput) {
  const { client, workspaceId, sessionId, workspaceRoot } = input;

  const [permissionReplyBusy, setPermissionReplyBusy] = useState(false);
  const permissionReplyBusyRef = useRef(false);
  const [questionReplyBusy, setQuestionReplyBusy] = useState(false);
  const questionReplyBusyRef = useRef(false);

  const requestedSessionIdsKey = (input.interactionSessionIds ?? []).join("\u0000");
  const interactionSessionIds = useMemo(() => {
    if (!sessionId) return [];
    const requested = requestedSessionIdsKey ? requestedSessionIdsKey.split("\u0000") : [];
    return Array.from(new Set([sessionId, ...requested].map((id) => id.trim()).filter(Boolean)));
  }, [requestedSessionIdsKey, sessionId]);
  const permissionQueryKeys = useMemo(
    () => workspaceId ? interactionSessionIds.map((id) => permissionKey(workspaceId, id)) : [],
    [interactionSessionIds, workspaceId],
  );
  const cachedPermissions = useQueryCacheArrayState<PendingPermission>(
    permissionQueryKeys,
    emptyPendingPermissions,
  );
  const pendingPermissions = useMemo(
    () => [...cachedPermissions].sort((left, right) => left.receivedAt - right.receivedAt || left.id.localeCompare(right.id)),
    [cachedPermissions],
  );
  const questionQueryKeys = useMemo(
    () => workspaceId ? interactionSessionIds.map((id) => questionKey(workspaceId, id)) : [],
    [interactionSessionIds, workspaceId],
  );
  const cachedQuestions = useQueryCacheArrayState<PendingQuestion>(
    questionQueryKeys,
    emptyPendingQuestions,
  );
  const pendingQuestions = useMemo(
    () => [...cachedQuestions].sort((left, right) => left.receivedAt - right.receivedAt || left.id.localeCompare(right.id)),
    [cachedQuestions],
  );
  const todoQueryKey = useMemo(
    () => (workspaceId && sessionId ? todoKey(workspaceId, sessionId) : null),
    [sessionId, workspaceId],
  );
  const todos = useQueryCacheState<TodoItem[]>(todoQueryKey, emptyTodos);

  useEffect(() => {
    if (!client || !workspaceId || interactionSessionIds.length === 0) return;
    let cancelled = false;
    const directory = workspaceRoot || undefined;
    void (async () => {
      const snapshotStartedAt = Date.now();
      try {
        let legacyPermissions: Parameters<typeof seedPermissionState>[2] = [];
        let legacyReadSucceeded = false;
        try {
          legacyPermissions = unwrap(await client.permission.list({ directory }));
          legacyReadSucceeded = true;
        } catch {
          // Older/newer OpenCode permission APIs can fail independently.
        }

        const v2Reads = await Promise.all(interactionSessionIds.map(async (permissionSessionId) => {
          try {
            const permissions = unwrap(
              await client.v2.session.permission.list({ sessionID: permissionSessionId }),
            ).data;
            return { permissionSessionId, permissions, succeeded: true };
          } catch {
            return { permissionSessionId, permissions: [], succeeded: false };
          }
        }));

        if (cancelled) return;
        for (const read of v2Reads) {
          if (!legacyReadSucceeded && !read.succeeded) continue;
          seedPermissionState(
            workspaceId,
            read.permissionSessionId,
            [...legacyPermissions, ...read.permissions],
            { snapshotStartedAt },
          );
        }
      } catch {
        // Keep event-synced permission state if the snapshot read fails.
        // Hiding a pending approval can block the running task.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, interactionSessionIds, workspaceId, workspaceRoot]);

  useEffect(() => {
    if (!client || !workspaceId || interactionSessionIds.length === 0) return;
    let cancelled = false;
    const directory = workspaceRoot || undefined;
    void (async () => {
      const snapshotStartedAt = Date.now();
      try {
        const list = unwrap(await client.question.list({ directory }));
        if (cancelled) return;
        for (const questionSessionId of interactionSessionIds) {
          seedQuestionState(workspaceId, questionSessionId, list, { snapshotStartedAt });
        }
      } catch {
        // Keep event-synced question state if the snapshot read fails.
        // Hiding a pending question can block the running task.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, interactionSessionIds, workspaceId, workspaceRoot]);

  const activePermission = pendingPermissions[0] ?? null;
  const respondPermission = useCallback(
    async (requestID: string, reply: "once" | "always" | "reject") => {
      if (!client || !workspaceId || !sessionId) return;
      if (permissionReplyBusyRef.current) return;
      permissionReplyBusyRef.current = true;
      setPermissionReplyBusy(true);
      try {
        const pendingPermission = pendingPermissions.find((permission) => permission.id === requestID);
        if (pendingPermission?.evaluation) {
          // A development-only proof request has no engine-side request to answer.
        } else if (pendingPermission?.protocol === "v2") {
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
        if (pendingPermission) {
          settlePermissionState(workspaceId, pendingPermission.sessionID, requestID);
        }
      } catch (error) {
        toast.error(t("app.error_request_failed"), {
          description: describeRouteError(error),
        });
      } finally {
        permissionReplyBusyRef.current = false;
        setPermissionReplyBusy(false);
      }
    },
    [client, pendingPermissions, interactionSessionIds, sessionId, workspaceId, workspaceRoot],
  );

  const activeQuestion = pendingQuestions[0] ?? null;
  const respondQuestion = useCallback(
    async (requestID: string, answers: string[][]) => {
      if (!client || !workspaceId || !sessionId) return;
      if (questionReplyBusyRef.current) return;
      questionReplyBusyRef.current = true;
      setQuestionReplyBusy(true);
      try {
        const pendingQuestion = pendingQuestions.find((question) => question.id === requestID);
        unwrap(
          await client.question.reply({
            requestID,
            answers,
            directory: workspaceRoot || undefined,
          }),
        );
        if (pendingQuestion) {
          settleQuestionState(workspaceId, pendingQuestion.sessionID, requestID);
        }
      } catch (error) {
        toast.error(t("app.error_request_failed"), {
          description: describeRouteError(error),
        });
      } finally {
        questionReplyBusyRef.current = false;
        setQuestionReplyBusy(false);
      }
    },
    [client, pendingQuestions, sessionId, workspaceId, workspaceRoot],
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
