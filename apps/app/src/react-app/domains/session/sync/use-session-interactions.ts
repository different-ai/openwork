// Pending interactions for a conversation and its descendants. Requests stay
// owned by the session that asked; only their presentation bubbles to the parent.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QueryObserver } from "@tanstack/react-query";
import { toast } from "sonner";

import { unwrap } from "@/app/lib/opencode";
import { isOpencodeV2Client } from "@/app/lib/opencode-v2-adapter";
import type { Client, PendingPermission, PendingQuestion, TodoItem } from "@/app/types";
import { t } from "@/i18n";
import { useQueryCacheArrayState, useQueryCacheState } from "@/react-app/infra/query-cache-state";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { describeRouteError } from "@/react-app/shell/route-workspaces";
import {
  permissionKey,
  questionKey,
  seedPermissionState,
  seedQuestionState,
  seedSessionStatus,
  seedSessionTodos,
  settleQuestionState,
  settlePermissionState,
  statusKey,
  todoKey,
} from "./session-sync";

const emptyPendingPermissions: PendingPermission[] = [];
const emptyPendingQuestions: PendingQuestion[] = [];
const emptyTodos: TodoItem[] = [];
const hydrationRetryDelaysMs = [100, 250, 500];
const hydrationClients = new WeakMap<Client, number>();
let nextHydrationClient = 0;

function observeActivityRead(
  client: Client,
  key: readonly unknown[],
  directory: string,
  read: (signal: AbortSignal, startedAt: number) => Promise<void>,
  recoverOnly = false,
) {
  let owner = hydrationClients.get(client);
  if (owner === undefined) {
    owner = ++nextHydrationClient;
    hydrationClients.set(client, owner);
  }
  const observer = new QueryObserver(getReactQueryClient(), {
    queryKey: [...key, "hydration", owner, directory],
    queryFn: async ({ signal }) => {
      for (let attempt = 0; ; attempt += 1) {
        signal.throwIfAborted();
        try {
          await read(signal, Date.now());
          return null;
        } catch (error) {
          signal.throwIfAborted();
          const delay = hydrationRetryDelaysMs[attempt];
          if (delay === undefined) throw error;
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, delay);
            signal.addEventListener("abort", abort, { once: true });
          });
        }
      }
    },
    retry: false,
    gcTime: 0,
    networkMode: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  const refresh = () => {
    const result = observer.getCurrentResult();
    if (result.isFetching || (recoverOnly && !result.isError)) return;
    void observer.refetch({ cancelRefetch: false });
  };
  const onVisibilityChange = () => { if (document.visibilityState === "visible") refresh(); };
  window.addEventListener("online", refresh);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    unsubscribe();
    window.removeEventListener("online", refresh);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

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
    if (!client || !workspaceId || !sessionId) return;
    return observeActivityRead(client, statusKey(workspaceId, sessionId), workspaceRoot, async (signal, snapshotStartedAt) => {
      const statuses = unwrap(await client.session.status({ directory: workspaceRoot || undefined }, { signal }));
      signal.throwIfAborted();
      seedSessionStatus(workspaceId, sessionId, statuses[sessionId] ?? { type: "idle" }, { snapshotStartedAt });
    }, true);
  }, [client, workspaceId, sessionId, workspaceRoot]);

  useEffect(() => {
    if (!client || !workspaceId || !sessionId) return;
    return observeActivityRead(client, todoKey(workspaceId, sessionId), workspaceRoot, async (signal, snapshotStartedAt) => {
      const todos = unwrap(await client.session.todo({ sessionID: sessionId, directory: workspaceRoot || undefined }, { signal }));
      signal.throwIfAborted();
      seedSessionTodos(workspaceId, sessionId, todos, { snapshotStartedAt });
    });
  }, [client, workspaceId, sessionId, workspaceRoot]);

  useEffect(() => {
    if (!client || !workspaceId || interactionSessionIds.length === 0) return;
    const controller = new AbortController();
    const directory = workspaceRoot || undefined;
    void (async () => {
      const snapshotStartedAt = Date.now();
      try {
        let legacyPermissions: Parameters<typeof seedPermissionState>[2] = [];
        let legacyReadSucceeded = false;
        // The v2 compatibility list sweeps every session; the scoped reads below
        // already return its native requests. V1 still needs both protocols.
        if (!isOpencodeV2Client(client)) {
          try {
            legacyPermissions = unwrap(await client.permission.list({ directory }, { signal: controller.signal }));
            legacyReadSucceeded = true;
          } catch {
            // Older/newer OpenCode permission APIs can fail independently.
          }
        }
        if (controller.signal.aborted) return;

        const v2Reads = await Promise.all(interactionSessionIds.map(async (permissionSessionId) => {
          try {
            const permissions = unwrap(
              await client.v2.session.permission.list({ sessionID: permissionSessionId }, { signal: controller.signal }),
            ).data;
            return { permissionSessionId, permissions, succeeded: true };
          } catch {
            return { permissionSessionId, permissions: [], succeeded: false };
          }
        }));

        if (controller.signal.aborted) return;
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
      controller.abort();
    };
  }, [client, interactionSessionIds, workspaceId, workspaceRoot]);

  useEffect(() => {
    if (!client || !workspaceId || interactionSessionIds.length === 0) return;
    const controller = new AbortController();
    const directory = workspaceRoot || undefined;
    void (async () => {
      const snapshotStartedAt = Date.now();
      try {
        const list = unwrap(await client.question.list({ directory }, { signal: controller.signal }));
        if (controller.signal.aborted) return;
        for (const questionSessionId of interactionSessionIds) {
          seedQuestionState(workspaceId, questionSessionId, list, { snapshotStartedAt });
        }
      } catch {
        // Keep event-synced question state if the snapshot read fails.
        // Hiding a pending question can block the running task.
      }
    })();
    return () => {
      controller.abort();
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
