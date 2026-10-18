"use client";

import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { getPermissionDefinition, isPermissionKey } from "@openwork/types/den/permissions";
import { z } from "zod";
import { getErrorMessage, getReauthRequiredError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { getOrgAccessFlags, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { clearDeniedRoleReads, permissionsQueryKeys, PERMISSION_READ_STALE_TIME } from "./permissions-query-keys";

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
  z.object({ kind: z.literal("team"), team: teamReferenceSchema.nullable(), teams: z.array(teamReferenceSchema).default([]), memberCount: z.number() }),
]);

const appliesToDetailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone"), memberCount: z.number() }),
  // People's names and emails come only with teams.view; the counts always do.
  z.object({ kind: z.literal("admins"), directAdminCount: z.number(), directAdmins: z.array(personSchema).nullable(), adminTeams: z.array(adminTeamSchema) }),
  z.object({ kind: z.literal("team"), team: teamReferenceSchema.nullable(), teams: z.array(teamReferenceSchema).default([]), memberCount: z.number(), members: z.array(personSchema).nullable() }),
]);

const setSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: setKindSchema,
  team: teamReferenceSchema.nullable(),
  /** Every team the set applies to (several only with sharedRoles). */
  teams: z.array(teamReferenceSchema).default([]),
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
  teams: z.array(teamReferenceSchema).default([]),
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
    teams: z.array(teamReferenceSchema).default([]),
    status: statusSchema,
    locked: z.boolean(),
  })),
});

const sourceSchema = z.object({
  kind: z.string(),
  label: z.string(),
  setId: z.string().optional(),
  teamId: z.string().optional(),
  // Read so teamRoles can name the source as a role ("Admin via Sales").
  via: z.string().optional(),
  teamName: z.string().optional(),
  setName: z.string().optional(),
  set: z.string().optional(),
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
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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

export { permissionsQueryKeys } from "./permissions-query-keys";

function usePermissionReadViewer(orgId: string | null) {
  const { orgContext } = useOrgDashboard();
  return orgContext?.organization.id === orgId ? orgContext.currentMember.id : "";
}

function deniedRoleRead(cause: unknown): boolean {
  return cause instanceof PermissionsRequestError && [401, 403, 404].includes(cause.status);
}

// Re-enabled reads must fetch even when the denial marker was just cached;
// the dashboard's ordinary freshness window must never strand that barrier.
export function usePermissionSets(orgId: string | null, enabled = true) {
  const viewerId = usePermissionReadViewer(orgId);
  const client = useQueryClient();
  const query = useQuery<PermissionSetSummary[] | null>({
    queryKey: permissionsQueryKeys.sets(orgId ?? "", viewerId),
    enabled: enabled && Boolean(orgId) && Boolean(viewerId),
    retry: false,
    staleTime: PERMISSION_READ_STALE_TIME,
    refetchOnMount: "always",
    queryFn: async ({ signal }) => {
      try {
        return required(await permissionsRequest({ orgId: orgId ?? "", path: "/v1/permissions/sets", schema: z.object({ sets: z.array(setSummarySchema) }), fallback: "Couldn't load permissions", signal })).sets;
      } catch (cause) {
        if (deniedRoleRead(cause)) await clearDeniedRoleReads(client, orgId ?? "", viewerId);
        throw cause;
      }
    },
  });
  const blocked = query.data === null || deniedRoleRead(query.error);
  return { ...query, data: blocked ? undefined : query.data ?? undefined, isSuccess: query.isSuccess && !blocked, isError: query.isError || blocked, error: blocked ? new Error("Couldn't verify access to roles. Try again.") : query.error };
}

/**
 * Teams that carry a custom role (their own permission set), keyed by team.
 * Empty until loaded, or when the viewer can't read permission sets.
 */
export function useCustomRoleTeams(orgId: string | null, enabled: boolean) {
  const query = usePermissionSets(orgId, enabled);
  const setByTeam = new Map<string, PermissionSetSummary>();
  for (const set of enabled ? query.data ?? [] : []) {
    if (set.kind !== "team") continue;
    // A shared role (sharedRoles) applies to every team in `teams`.
    const teams = set.teams.length > 0 ? set.teams : set.team ? [set.team] : [];
    for (const team of teams) setByTeam.set(team.id, set);
  }
  const nameByTeam = new Map([...setByTeam].map(([teamId, set]) => [teamId, set.name]));
  return { setByTeam, nameByTeam, teamIds: new Set(setByTeam.keys()), loading: enabled && query.isPending, verified: enabled && query.isSuccess };
}

export function usePermissionSet(orgId: string | null, setId: string, enabled = true) {
  const viewerId = usePermissionReadViewer(orgId);
  const client = useQueryClient();
  const query = useQuery<PermissionSetDetail | null>({
    queryKey: permissionsQueryKeys.set(orgId ?? "", setId, viewerId),
    enabled: enabled && Boolean(orgId) && Boolean(setId) && Boolean(viewerId),
    retry: false,
    staleTime: PERMISSION_READ_STALE_TIME,
    refetchOnMount: "always",
    queryFn: async ({ signal }) => {
      try {
        return required(await permissionsRequest({ orgId: orgId ?? "", path: `/v1/permissions/sets/${encodeURIComponent(setId)}`, schema: z.object({ set: setDetailSchema }), fallback: "Couldn't load these permissions", signal })).set;
      } catch (cause) {
        if (deniedRoleRead(cause)) await clearDeniedRoleReads(client, orgId ?? "", viewerId);
        throw cause;
      }
    },
  });
  const blocked = query.data === null || deniedRoleRead(query.error);
  return { ...query, data: blocked ? undefined : query.data ?? undefined, isSuccess: query.isSuccess && !blocked, isError: query.isError || blocked, error: blocked ? new Error("Couldn't verify access to these permissions. Try again.") : query.error };
}

export function useRoleGrantLocks(orgId: string | null, sets: readonly PermissionSetSummary[], permissions: readonly string[], isOwner: boolean) {
  const viewerId = usePermissionReadViewer(orgId);
  const client = useQueryClient();
  const details = useQueries({ queries: sets.map((set) => ({
    queryKey: permissionsQueryKeys.set(orgId ?? "", set.id, viewerId),
    enabled: Boolean(orgId) && Boolean(viewerId) && !isOwner,
    retry: false,
    staleTime: PERMISSION_READ_STALE_TIME,
    refetchOnMount: (): "always" => "always",
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<PermissionSetDetail | null> => {
      try {
        return required(await permissionsRequest({ orgId: orgId ?? "", path: `/v1/permissions/sets/${encodeURIComponent(set.id)}`, schema: z.object({ set: setDetailSchema }), fallback: "Couldn't verify this role", signal })).set;
      } catch (cause) {
        if (deniedRoleRead(cause)) await clearDeniedRoleReads(client, orgId ?? "", viewerId);
        throw cause;
      }
    },
  })) });
  return new Map(sets.map((set, index) => {
    const detail = details[index];
    const missing = detail?.data?.permissions.find((entry) => entry.status === "allow" && !permissions.includes(entry.key));
    const reason = isOwner ? null : !detail?.isSuccess || detail.data?.id !== set.id ? "Couldn't verify this role's permissions yet." : missing ? "This role grants permissions you don’t have. Ask the organization owner." : null;
    return [set.id, reason];
  }));
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
  const { orgContext } = useOrgDashboard();
  const canRead = orgContext?.organization.id === orgId && orgFeatureEnabled(orgContext, "permissions") && (orgContext.currentMember.id === memberId || getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canViewPermissions);
  return useQuery({
    queryKey: permissionsQueryKeys.member(orgId ?? "", memberId),
    enabled: enabled && Boolean(orgId) && canRead,
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
  const viewerId = usePermissionReadViewer(orgId);
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
      const key = permissionsQueryKeys.set(orgId, setId, viewerId);
      // A pre-denial write response cannot clear the read-authorization barrier.
      if (queryClient.getQueryData(key) !== null && queryClient.getQueryData(permissionsQueryKeys.sets(orgId, viewerId)) !== null) queryClient.setQueryData(key, set);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: permissionsQueryKeys.all(orgId) }),
  });
}

export function useCreateTeamPermissions(orgId: string) {
  const viewerId = usePermissionReadViewer(orgId);
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
      const key = permissionsQueryKeys.set(orgId, set.id, viewerId);
      if (queryClient.getQueryData(key) !== null && queryClient.getQueryData(permissionsQueryKeys.sets(orgId, viewerId)) !== null) queryClient.setQueryData(key, set);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: permissionsQueryKeys.all(orgId) }),
  });
}

/** A new role was half made: its team exists, its permissions don't. */
export class RolePermissionsNotSavedError extends Error {
  readonly teamId: string;

  constructor(message: string, teamId: string) {
    super(message);
    this.name = "RolePermissionsNotSavedError";
    this.teamId = teamId;
  }
}

/**
 * Creates a role: a team with its people (POST /v1/teams), then that team's
 * permission set (POST /v1/permissions/sets). Both are the existing calls the
 * Teams and Permissions screens make; nothing new is stored.
 */
export function useCreateRole(orgId: string) {
  const queryClient = useQueryClient();
  const write = useReauthableWrite();
  const { refreshOrgData } = useOrgDashboard();
  return useMutation({
    mutationKey: [...permissionsQueryKeys.sets(orgId), "create-role"],
    retry: false,
    mutationFn: async (input: { name: string; memberIds: string[]; permissions: PermissionChange[] }) => {
      const teamId = await write("create-role-team", async () => {
        const { response, payload } = await requestJson(
          "/v1/teams",
          {
            method: "POST",
            headers: { [ORG_SCOPE_HEADER]: orgId },
            body: JSON.stringify({ name: input.name, memberIds: input.memberIds }),
          },
          15000,
        );
        if (!response.ok) {
          const reauth = getReauthRequiredError(payload, response);
          if (reauth) throw reauth;
          throw new Error(getErrorMessage(payload, `Couldn't create the role (${response.status}).`));
        }
        const parsed = z.object({ team: z.object({ id: z.string() }) }).safeParse(payload);
        if (!parsed.success) throw new Error("Couldn't create the role: unexpected response.");
        return parsed.data.team.id;
      });
      try {
        const set = await write("create-role-permissions", async () => required(await permissionsRequest({
          orgId,
          path: "/v1/permissions/sets",
          method: "POST",
          body: { teamId, permissions: input.permissions },
          schema: z.object({ set: setDetailSchema }),
          fallback: "Couldn't save the role's permissions",
        })).set);
        return { teamId, set };
      } catch (cause) {
        throw new RolePermissionsNotSavedError(cause instanceof Error ? cause.message : "Couldn't save the role's permissions.", teamId);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: permissionsQueryKeys.all(orgId) });
      await refreshOrgData();
    },
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

/**
 * sharedRoles: gives a team one custom role, replacing its current one, or
 * none (PUT /v1/teams/:teamId/permission-set). The team's Admin designation is
 * a separate call (PATCH /v1/teams/:id).
 */
export function useSetTeamRole(orgId: string) {
  const queryClient = useQueryClient();
  const write = useReauthableWrite();
  const { refreshOrgData } = useOrgDashboard();
  return useMutation({
    mutationKey: [...permissionsQueryKeys.sets(orgId), "set-team-role"],
    retry: false,
    mutationFn: (input: { teamId: string; permissionSetId: string | null }) => write("set-team-role", async () => {
      await permissionsRequest({
        orgId,
        path: `/v1/teams/${encodeURIComponent(input.teamId)}/permission-set`,
        method: "PUT",
        body: { permissionSetId: input.permissionSetId },
        schema: null,
        fallback: "Couldn't change the team's role",
      });
      return input.teamId;
    }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: permissionsQueryKeys.all(orgId) });
      await refreshOrgData();
    },
  });
}

/** sharedRoles: creates a named role, given to the teams now (each team's custom role is replaced). */
export function useCreateSharedRole(orgId: string) {
  const viewerId = usePermissionReadViewer(orgId);
  const queryClient = useQueryClient();
  const write = useReauthableWrite();
  return useMutation({
    mutationKey: [...permissionsQueryKeys.sets(orgId), "create-shared-role"],
    retry: false,
    mutationFn: (input: { name: string; teamIds: string[]; permissions: PermissionChange[] }) => write("create-shared-role", async () => required(await permissionsRequest({
      orgId,
      path: "/v1/permissions/sets",
      method: "POST",
      body: input,
      schema: z.object({ set: setDetailSchema }),
      fallback: "Couldn't create the role",
    })).set),
    onSuccess: (set) => {
      const key = permissionsQueryKeys.set(orgId, set.id, viewerId);
      if (queryClient.getQueryData(key) !== null && queryClient.getQueryData(permissionsQueryKeys.sets(orgId, viewerId)) !== null) queryClient.setQueryData(key, set);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: permissionsQueryKeys.all(orgId) }),
  });
}

/** sharedRoles: renames a custom role. */
export function useRenameRole(orgId: string, setId: string) {
  const viewerId = usePermissionReadViewer(orgId);
  const queryClient = useQueryClient();
  const write = useReauthableWrite();
  return useMutation({
    mutationKey: [...permissionsQueryKeys.set(orgId, setId), "rename"],
    retry: false,
    mutationFn: (name: string) => write("rename-role", async () => required(await permissionsRequest({
      orgId,
      path: `/v1/permissions/sets/${encodeURIComponent(setId)}`,
      method: "PATCH",
      body: { name },
      schema: z.object({ set: setDetailSchema }),
      fallback: "Couldn't rename the role",
    })).set),
    onSuccess: (set) => {
      const key = permissionsQueryKeys.set(orgId, setId, viewerId);
      // A pre-denial write response cannot clear the read-authorization barrier.
      if (queryClient.getQueryData(key) !== null && queryClient.getQueryData(permissionsQueryKeys.sets(orgId, viewerId)) !== null) queryClient.setQueryData(key, set);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: permissionsQueryKeys.all(orgId) }),
  });
}

/** sharedRoles is on, with the Team roles and Permissions it builds on. */
export function useSharedRolesOn(): boolean {
  const { orgContext } = useOrgDashboard();
  if (!orgContext) return false;
  return orgFeatureEnabled(orgContext, "sharedRoles") && orgFeatureEnabled(orgContext, "teamRoles") && orgFeatureEnabled(orgContext, "permissions");
}
