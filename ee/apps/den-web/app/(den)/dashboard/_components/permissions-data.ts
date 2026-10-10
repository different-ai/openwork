"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getPermissionDefinition, isPermissionKey } from "@openwork/types/den/permissions";
import { z } from "zod";
import { getErrorMessage, getReauthRequiredError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/**
 * Den API Permissions endpoints (ee/apps/den-api/src/routes/org/permissions.ts).
 * Response shapes mirror that file's zod schemas.
 */

const statusSchema = z.enum(["allow", "deny"]);
const setKindSchema = z.enum(["member_default", "admin_default", "team"]);
const sourceKindSchema = z.enum(["user", "seed", "reconcile", "migration"]);

const teamReferenceSchema = z.object({ id: z.string(), name: z.string().nullable() });
const personSchema = z.object({ memberId: z.string(), name: z.string(), email: z.string() });
const changedBySchema = z.object({ memberId: z.string(), name: z.string().nullable(), email: z.string().nullable() });
const adminTeamSchema = z.object({ id: z.string(), name: z.string(), memberCount: z.number() });

const appliesToSummarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone"), memberCount: z.number() }),
  z.object({ kind: z.literal("admins"), directAdminCount: z.number(), adminTeams: z.array(adminTeamSchema) }),
  z.object({ kind: z.literal("team"), team: teamReferenceSchema.nullable(), memberCount: z.number() }),
]);

const appliesToDetailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone"), memberCount: z.number() }),
  // People's names and emails come only with teams.view; the counts always do.
  z.object({ kind: z.literal("admins"), directAdminCount: z.number(), directAdmins: z.array(personSchema).nullable(), adminTeams: z.array(adminTeamSchema) }),
  z.object({ kind: z.literal("team"), team: teamReferenceSchema.nullable(), memberCount: z.number(), members: z.array(personSchema).nullable() }),
]);

const setSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: setKindSchema,
  team: teamReferenceSchema.nullable(),
  allowedCount: z.number(),
  createdAt: z.string(),
  appliesTo: appliesToSummarySchema,
});

const keyStateSchema = z.object({
  key: z.string(),
  status: statusSchema,
  locked: z.boolean(),
  lastChangedAt: z.string().nullable(),
  lastChangedBy: changedBySchema.nullable(),
  lastChangeSource: sourceKindSchema.nullable(),
});

const setDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: setKindSchema,
  team: teamReferenceSchema.nullable(),
  allowedCount: z.number(),
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
  permissions: z.array(keyStateSchema),
  appliesTo: appliesToDetailSchema,
});

const historyItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string().nullable(),
  status: statusSchema,
  source: sourceKindSchema,
  changedBy: changedBySchema.nullable(),
  createdAt: z.string(),
});

const definitionSchema = z.object({
  key: z.string(),
  area: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  sensitive: z.boolean(),
  lockedOn: z.array(z.string()),
  defaultOn: z.array(z.string()),
});

const keyStatusSchema = z.object({
  permission: definitionSchema,
  sets: z.array(z.object({
    id: z.string(),
    name: z.string(),
    kind: setKindSchema,
    team: teamReferenceSchema.nullable(),
    status: statusSchema,
    locked: z.boolean(),
  })),
});

const sourceSchema = z.object({
  kind: z.string(),
  label: z.string(),
  setId: z.string().optional(),
  teamId: z.string().optional(),
});

const memberPermissionsSchema = z.object({
  memberId: z.string(),
  featureEnabled: z.boolean(),
  isOwner: z.boolean(),
  isAdmin: z.boolean(),
  permissions: z.array(z.object({ key: z.string(), label: z.string(), sources: z.array(sourceSchema) })),
});

const errorBodySchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  keys: z.array(z.string()).optional(),
  permissionSetId: z.string().optional(),
});

export type PermissionStatus = z.infer<typeof statusSchema>;
export type PermissionSetKind = z.infer<typeof setKindSchema>;
export type PermissionChangeSource = z.infer<typeof sourceKindSchema>;
export type PermissionSetSummary = z.infer<typeof setSummarySchema>;
export type PermissionSetDetail = z.infer<typeof setDetailSchema>;
export type PermissionKeyState = z.infer<typeof keyStateSchema>;
export type PermissionHistoryItem = z.infer<typeof historyItemSchema>;
export type PermissionKeyStatus = z.infer<typeof keyStatusSchema>;
export type MemberPermissions = z.infer<typeof memberPermissionsSchema>;
export type PermissionChange = { key: string; status: PermissionStatus };

/** A Permissions request that failed with a code the screens explain. */
export class PermissionsRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly keys: string[];
  readonly permissionSetId: string | null;

  constructor(message: string, status: number, code: string | null, keys: string[], permissionSetId: string | null) {
    super(message);
    this.name = "PermissionsRequestError";
    this.status = status;
    this.code = code;
    this.keys = keys;
    this.permissionSetId = permissionSetId;
  }
}

/** Catalog labels for keys, quoted, for error messages. Unknown keys stay as sent. */
export function permissionLabels(keys: readonly string[]): string {
  return keys.map((key) => `“${isPermissionKey(key) ? getPermissionDefinition(key).label : key}”`).join(", ");
}

function explainedMessage(code: string | null, keys: string[], fallback: string): string {
  switch (code) {
    case "permission_locked":
      return `${permissionLabels(keys)} ${keys.length === 1 ? "is" : "are"} always on for admins, so it can't be turned off here.`;
    case "permission_not_held":
      return `You can only turn on permissions you have yourself. You don't have ${permissionLabels(keys)}.`;
    case "admin_permissions_require_admin":
      return "Only the owner and admins can change Admin permissions.";
    case "permission_set_archived":
      return "These team permissions were removed, so they can't be changed.";
    case "team_permission_set_exists":
      return "This team already has permissions. Edit them instead.";
    case "feature_disabled":
      return "Permissions is turned off for this organization.";
    case "permission_set_not_found":
      return "These permissions don't exist anymore.";
    default:
      return fallback;
  }
}

async function permissionsRequest<T>(input: {
  orgId: string;
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  schema: z.ZodType<T> | null;
  fallback: string;
  signal?: AbortSignal;
}): Promise<T | null> {
  const { response, payload } = await requestJson(
    input.path,
    {
      method: input.method ?? "GET",
      headers: { [ORG_SCOPE_HEADER]: input.orgId },
      cache: "no-store",
      signal: input.signal,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    },
    15000,
  );
  if (!response.ok) {
    const reauth = getReauthRequiredError(payload, response);
    if (reauth) throw reauth;
    const parsed = errorBodySchema.safeParse(payload);
    const code = parsed.success ? parsed.data.error : null;
    const keys = parsed.success ? parsed.data.keys ?? [] : [];
    const fallback = getErrorMessage(payload, `${input.fallback} (${response.status}).`);
    throw new PermissionsRequestError(
      explainedMessage(code, keys, fallback),
      response.status,
      code,
      keys,
      parsed.success ? parsed.data.permissionSetId ?? null : null,
    );
  }
  if (!input.schema) return null;
  const parsed = input.schema.safeParse(payload);
  if (!parsed.success) throw new Error(`${input.fallback}: unexpected response.`);
  return parsed.data;
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Permissions returned an empty response.");
  return value;
}

export const permissionsQueryKeys = {
  all: (orgId: string) => ["permissions", orgId],
  sets: (orgId: string) => ["permissions", orgId, "sets"],
  set: (orgId: string, setId: string) => ["permissions", orgId, "set", setId],
  history: (orgId: string, setId: string) => ["permissions", orgId, "history", setId],
  key: (orgId: string, key: string) => ["permissions", orgId, "key", key],
  member: (orgId: string, memberId: string) => ["permissions", orgId, "member", memberId],
};

export function usePermissionSets(orgId: string | null, enabled = true) {
  return useQuery({
    queryKey: permissionsQueryKeys.sets(orgId ?? ""),
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: async ({ signal }) => required(await permissionsRequest({
      orgId: orgId ?? "",
      path: "/v1/permissions/sets",
      schema: z.object({ sets: z.array(setSummarySchema) }),
      fallback: "Couldn't load permissions",
      signal,
    })).sets,
  });
}

export function usePermissionSet(orgId: string | null, setId: string) {
  return useQuery({
    queryKey: permissionsQueryKeys.set(orgId ?? "", setId),
    enabled: Boolean(orgId),
    retry: false,
    queryFn: async ({ signal }) => required(await permissionsRequest({
      orgId: orgId ?? "",
      path: `/v1/permissions/sets/${encodeURIComponent(setId)}`,
      schema: z.object({ set: setDetailSchema }),
      fallback: "Couldn't load these permissions",
      signal,
    })).set,
  });
}

const HISTORY_PAGE_SIZE = 50;
const FIRST_HISTORY_PAGE: string | null = null;

export function usePermissionSetHistory(orgId: string | null, setId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: permissionsQueryKeys.history(orgId ?? "", setId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    initialPageParam: FIRST_HISTORY_PAGE,
    getNextPageParam: (page: { nextCursor: string | null }) => page.nextCursor,
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
      if (pageParam) query.set("cursor", pageParam);
      return required(await permissionsRequest({
        orgId: orgId ?? "",
        path: `/v1/permissions/sets/${encodeURIComponent(setId)}/history?${query.toString()}`,
        schema: z.object({ items: z.array(historyItemSchema), nextCursor: z.string().nullable() }),
        fallback: "Couldn't load history",
        signal,
      }));
    },
  });
}

export function usePermissionKeyStatus(orgId: string | null, key: string) {
  return useQuery({
    queryKey: permissionsQueryKeys.key(orgId ?? "", key),
    enabled: Boolean(orgId),
    retry: false,
    queryFn: async ({ signal }) => required(await permissionsRequest({
      orgId: orgId ?? "",
      path: `/v1/permissions/keys/${encodeURIComponent(key)}`,
      schema: keyStatusSchema,
      fallback: "Couldn't load this permission",
      signal,
    })),
  });
}

export function useMemberPermissions(orgId: string | null, memberId: string, enabled: boolean) {
  return useQuery({
    queryKey: permissionsQueryKeys.member(orgId ?? "", memberId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: async ({ signal }) => required(await permissionsRequest({
      orgId: orgId ?? "",
      path: `/v1/members/${encodeURIComponent(memberId)}/permissions`,
      schema: memberPermissionsSchema,
      fallback: "Couldn't load effective permissions",
      signal,
    })),
  });
}

/**
 * Writes run through runReauthableAction: permissions.manage needs a recent
 * sign-in, and the dashboard's reauth dialog retries the write after it.
 */
function useReauthableWrite() {
  const { runReauthableAction } = useOrgDashboard();
  return async <T>(label: string, write: () => Promise<T>): Promise<T> => {
    const box: { value: T | undefined; done: boolean } = { value: undefined, done: false };
    await runReauthableAction(label, async () => {
      box.value = await write();
      box.done = true;
    });
    if (!box.done || box.value === undefined) throw new Error("The change didn't finish. Try again.");
    return box.value;
  };
}

export function useUpdatePermissionSet(orgId: string, setId: string) {
  const queryClient = useQueryClient();
  const write = useReauthableWrite();
  return useMutation({
    mutationKey: [...permissionsQueryKeys.set(orgId, setId), "update"],
    retry: false,
    mutationFn: (changes: PermissionChange[]) => write("update-permission-set", async () => required(await permissionsRequest({
      orgId,
      path: `/v1/permissions/sets/${encodeURIComponent(setId)}/permissions`,
      method: "PUT",
      body: { changes },
      schema: z.object({ set: setDetailSchema }),
      fallback: "Couldn't save permissions",
    })).set),
    onSuccess: (set) => {
      queryClient.setQueryData(permissionsQueryKeys.set(orgId, setId), set);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: permissionsQueryKeys.all(orgId) }),
  });
}

export function useCreateTeamPermissions(orgId: string) {
  const queryClient = useQueryClient();
  const write = useReauthableWrite();
  return useMutation({
    mutationKey: [...permissionsQueryKeys.sets(orgId), "create"],
    retry: false,
    mutationFn: (input: { teamId: string; permissions: PermissionChange[] }) => write("create-team-permissions", async () => required(await permissionsRequest({
      orgId,
      path: "/v1/permissions/sets",
      method: "POST",
      body: input,
      schema: z.object({ set: setDetailSchema }),
      fallback: "Couldn't create team permissions",
    })).set),
    onSuccess: (set) => {
      queryClient.setQueryData(permissionsQueryKeys.set(orgId, set.id), set);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: permissionsQueryKeys.all(orgId) }),
  });
}

export function useRemoveTeamPermissions(orgId: string, setId: string) {
  const queryClient = useQueryClient();
  const write = useReauthableWrite();
  return useMutation({
    mutationKey: [...permissionsQueryKeys.set(orgId, setId), "remove"],
    retry: false,
    mutationFn: () => write("remove-team-permissions", async () => {
      await permissionsRequest({
        orgId,
        path: `/v1/permissions/sets/${encodeURIComponent(setId)}`,
        method: "DELETE",
        schema: null,
        fallback: "Couldn't remove team permissions",
      });
      return setId;
    }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: permissionsQueryKeys.all(orgId) }),
  });
}
