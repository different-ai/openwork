// Pending permissions, questions, and todos for the selected session:
// query-cache subscriptions, snapshot seeding, and reply handlers.
// Extracted verbatim from session-route.tsx (cluster had no readers of its
// internals besides the JSX).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { unwrap } from "@/app/lib/opencode";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { Client, PendingPermission, PendingQuestion, PermissionReply, TodoItem } from "@/app/types";
import { t } from "@/i18n";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { useQueryCacheArrayState, useQueryCacheState } from "@/react-app/infra/query-cache-state";
import { describeRouteError } from "@/react-app/shell/route-workspaces";
import { useSessionActivityStore } from "../status/session-activity-store";
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
  permissionSessionIds?: string[];
  workspaceRoot: string;
  /** OpenWork server for this workspace; needed to persist an approval into the workspace's opencode.json. */
  openworkServer?: { client: OpenworkServerClient; workspaceId: string } | null;
};

/** The patterns the engine itself proposed for an "always" reply (v1 `always`, v2 `save`). */
function suggestedPatterns(permission: PendingPermission): string[] {
  const raw = permission.protocol === "v2" ? permission.v2?.save : permission.always;
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function permissionName(permission: PendingPermission): string {
  return permission.protocol === "v2" ? permission.v2?.action ?? permission.permission : permission.permission;
}

export function useSessionInteractions(input: UseSessionInteractionsInput) {
  const { client, workspaceId, sessionId, workspaceRoot, openworkServer = null } = input;

  const [permissionReplyBusy, setPermissionReplyBusy] = useState(false);
  const permissionReplyBusyRef = useRef(false);
  const [questionReplyBusy, setQuestionReplyBusy] = useState(false);
  const questionReplyBusyRef = useRef(false);

  const requestedPermissionSessionIdsKey = (input.permissionSessionIds ?? []).join("\u0000");
  const permissionSessionIds = useMemo(() => {
    if (!sessionId) return [];
    const requested = requestedPermissionSessionIdsKey ? requestedPermissionSessionIdsKey.split("\u0000") : [];
    return Array.from(new Set([sessionId, ...requested].map((id) => id.trim()).filter(Boolean)));
  }, [requestedPermissionSessionIdsKey, sessionId]);
  const permissionQueryKeys = useMemo(
    () => workspaceId ? permissionSessionIds.map((id) => permissionKey(workspaceId, id)) : [],
    [permissionSessionIds, workspaceId],
  );
  const cachedPermissions = useQueryCacheArrayState<PendingPermission>(
    permissionQueryKeys,
    emptyPendingPermissions,
  );
  const pendingPermissions = useMemo(
    () => [...cachedPermissions].sort((left, right) => left.receivedAt - right.receivedAt || left.id.localeCompare(right.id)),
    [cachedPermissions],
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
    if (!client || !workspaceId || permissionSessionIds.length === 0) return;
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

        const v2Reads = await Promise.all(permissionSessionIds.map(async (permissionSessionId) => {
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
  }, [client, permissionSessionIds, workspaceId, workspaceRoot]);

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
    async (requestID: string, requested: PermissionReply) => {
      if (!client || !workspaceId || !sessionId) return;
      if (permissionReplyBusyRef.current) return;
      permissionReplyBusyRef.current = true;
      setPermissionReplyBusy(true);
      // "Always allow in this workspace" is the engine's own "always" reply
      // plus the same patterns written into the workspace's opencode.json.
      const reply = requested === "always-workspace" ? "always" : requested;
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
        for (const permissionSessionId of permissionSessionIds) {
          getReactQueryClient().setQueryData<PendingPermission[]>(
            permissionKey(workspaceId, permissionSessionId),
            (current = []) => current.filter((permission) => permission.id !== requestID),
          );
        }
        if (pendingPermission) {
          useSessionActivityStore.getState().setWaitingRequest(
            workspaceId,
            pendingPermission.sessionID,
            "permission",
            requestID,
            false,
          );
        }
        if (requested === "always-workspace" && pendingPermission) {
          if (!openworkServer) throw new Error(t("session.allow_in_workspace_unavailable"));
          const patterns = suggestedPatterns(pendingPermission);
          if (patterns.length === 0) throw new Error(t("session.allow_in_workspace_no_pattern"));
          for (const pattern of patterns) {
            await openworkServer.client.addWorkspacePermissionRule(openworkServer.workspaceId, {
              permission: permissionName(pendingPermission),
              pattern,
              action: "allow",
            });
          }
          toast.success(t("session.allow_in_workspace_saved"), { description: patterns.join(", ") });
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
    [client, openworkServer, pendingPermissions, permissionSessionIds, sessionId, workspaceId, workspaceRoot],
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
