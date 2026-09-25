"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  auditCaptureUpdateSchema,
  type AuditCaptureUpdate,
  type AuditUsageResponse,
  auditEventsResponseSchema,
  auditEventTypesResponseSchema,
  auditOperationsResponseSchema,
  auditUsageResponseSchema,
  type AuditOperationSummary,
} from "@openwork/types/den/audit";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { getReauthRequiredError, isReauthRequiredError, requestJson } from "../../_lib/den-flow";
import { getOrgAccessFlags } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export type AuditScope = { orgId: string; memberId: string };
export type AuditFilters = Partial<{
  from: string;
  to: string;
  actorId: string;
  action: string;
  outcome: AuditOperationSummary["outcome"];
  origin: AuditOperationSummary["origin"];
  resourceId: string;
  searchId: string;
}>;

type AuditCursor = { cursor: string | null; snapshot: number | null; cursors: string[]; ids: string[] };
const firstPage: AuditCursor = { cursor: null, snapshot: null, cursors: [], ids: [] };
const defaults = { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false };
export const auditPageSize = 50;

export class AuditReadError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(status === 403 ? "Audit history is unavailable for this account." : "Could not verify audit history. Try again.");
  }
}

export function isAuditAccessError(error: unknown): error is AuditReadError {
  return error instanceof AuditReadError && (error.status === 403 || error.status === 401
    || (error.status === 404 && error.code === "organization_not_found"));
}

export function auditQueryKey(scope: AuditScope) {
  return ["audit", scope.orgId, scope.memberId];
}

async function readAudit<T>(scope: AuditScope, path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const { response, payload } = await requestJson(path, {
    method: "GET", headers: { [ORG_SCOPE_HEADER]: scope.orgId }, cache: "no-store", signal,
  }, 15000);
  if (!response.ok) {
    const code = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : null;
    throw new AuditReadError(response.status, code);
  }
  const result = schema.safeParse(payload);
  if (!result.success) throw new Error("Audit history returned an invalid response. Refresh to verify it.");
  return result.data;
}

export function auditFilterParams(filters: AuditFilters) {
  const params = new URLSearchParams({ limit: String(auditPageSize) });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params;
}

function verifyPage(page: { nextCursor: string | null; snapshotSequence: number }, param: AuditCursor, ids: string[]) {
  if ((param.snapshot !== null && page.snapshotSequence !== param.snapshot)
    || ids.length > auditPageSize || new Set(ids).size !== ids.length || ids.some((id) => param.ids.includes(id))
    || (page.nextCursor !== null && (!page.nextCursor || !ids.length || page.nextCursor === param.cursor || param.cursors.includes(page.nextCursor)))) {
    throw new Error("Audit pagination changed. Refresh from the first page to verify history.");
  }
}

function nextPage(page: { nextCursor: string | null; snapshotSequence: number }, param: AuditCursor, ids: string[]): AuditCursor | undefined {
  if (!page.nextCursor) return undefined;
  return { cursor: page.nextCursor, snapshot: page.snapshotSequence, cursors: [...param.cursors, page.nextCursor], ids: [...param.ids, ...ids] };
}

export async function getAuditOperations(scope: AuditScope, filters: AuditFilters, param: AuditCursor = firstPage, signal?: AbortSignal) {
  const params = auditFilterParams(filters);
  if (param.cursor) params.set("cursor", param.cursor);
  const page = await readAudit(scope, `/v1/audit/operations?${params}`, auditOperationsResponseSchema, signal);
  verifyPage(page, param, page.operations.map((operation) => operation.id));
  return page;
}

export function useAuditOperations(scope: AuditScope, filters: AuditFilters) {
  return useInfiniteQuery({
    ...defaults, queryKey: [...auditQueryKey(scope), "operations", filters], initialPageParam: firstPage,
    queryFn: ({ signal, pageParam }) => getAuditOperations(scope, filters, pageParam, signal),
    getNextPageParam: (page, _pages, param) => nextPage(page, param, page.operations.map((operation) => operation.id)),
  });
}

export async function getAuditEvents(scope: AuditScope, operationId: string, param: AuditCursor = firstPage, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(auditPageSize) });
  if (param.cursor) params.set("cursor", param.cursor);
  const page = await readAudit(scope, `/v1/audit/operations/${encodeURIComponent(operationId)}/events?${params}`, auditEventsResponseSchema, signal);
  if (page.events.some((event) => event.organizationId !== scope.orgId || event.operationId !== operationId)) {
    throw new Error("Audit events did not match this workspace and operation. Refresh to verify history.");
  }
  verifyPage(page, param, page.events.map((event) => event.id));
  return page;
}

export function useAuditEvents(scope: AuditScope, operationId: string) {
  return useInfiniteQuery({
    ...defaults, queryKey: [...auditQueryKey(scope), "events", operationId], initialPageParam: firstPage,
    queryFn: ({ signal, pageParam }) => getAuditEvents(scope, operationId, pageParam, signal),
    getNextPageParam: (page, _pages, param) => nextPage(page, param, page.events.map((event) => event.id)),
  });
}

export async function getAuditEventTypes(scope: AuditScope, signal?: AbortSignal) {
  return readAudit(scope, "/v1/audit/event-types", auditEventTypesResponseSchema, signal);
}

export function useAuditEventTypes(scope: AuditScope) {
  return useQuery({ ...defaults, queryKey: [...auditQueryKey(scope), "event-types"], queryFn: ({ signal }) => getAuditEventTypes(scope, signal) });
}

function verifyAuditUsage(scope: AuditScope, usage: AuditUsageResponse) {
  if (usage.policy && usage.policy.organizationId !== scope.orgId) throw new Error("Audit policy did not match this workspace. Refresh to verify it.");
  return usage;
}

export async function getAuditUsage(scope: AuditScope, signal?: AbortSignal) {
  return verifyAuditUsage(scope, await readAudit(scope, "/v1/audit/usage", auditUsageResponseSchema, signal));
}

export function useAuditUsage(scope: AuditScope) {
  return useQuery({ ...defaults, queryKey: [...auditQueryKey(scope), "usage"], queryFn: ({ signal }) => getAuditUsage(scope, signal) });
}

async function withAuditDeadline<T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 15000);
  try { return await action(controller.signal); }
  finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}

export async function updateAuditCapture(scope: AuditScope, input: AuditCaptureUpdate, signal?: AbortSignal) {
  const body = auditCaptureUpdateSchema.parse(input);
  const { response, payload } = await withAuditDeadline(signal, (requestSignal) => requestJson("/v1/audit/settings", {
    method: "PATCH", headers: { [ORG_SCOPE_HEADER]: scope.orgId }, cache: "no-store",
    body: JSON.stringify(body), signal: requestSignal,
  }, 15000));
  if (!response.ok) {
    const reauth = getReauthRequiredError(payload, response);
    if (reauth) throw reauth;
    const code = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : null;
    throw new AuditReadError(response.status, code);
  }
  const result = auditUsageResponseSchema.safeParse(payload);
  if (!result.success) throw new Error("Capture returned an invalid response. Refresh status to verify it.");
  return verifyAuditUsage(scope, result.data);
}

export function auditCaptureLockReason(usage: AuditUsageResponse): string | null {
  if (!usage.policy) return "Ask an instance admin to configure audit storage.";
  if (!usage.entitlement.enabled) return "Capture requires Enterprise or instance entitlement. Ask an organization owner or instance operator to review availability.";
  if (!usage.captureAvailable) return "Capture is unavailable in this deployment. Ask an instance operator to enable capture rollout.";
  return null;
}

type CaptureFeedback = { message: string; tone: "neutral" | "error" };
type CaptureSession = { active: boolean; busy: boolean; controller: AbortController };

export function useAuditCapture(scope: AuditScope, onAccessError: (error: AuditReadError) => void) {
  const query = useAuditUsage(scope);
  const client = useQueryClient();
  const dashboard = useOrgDashboard();
  const member = dashboard.orgContext?.currentMember;
  const allowed = dashboard.orgId === scope.orgId && dashboard.orgContext?.organization.id === scope.orgId
    && member?.id === scope.memberId && getOrgAccessFlags(member.role, member.isOwner).isAdmin
    && !dashboard.orgBusy && !dashboard.orgError && dashboard.mutationBusy !== "switch-organization";
  const sessionRef = useRef<CaptureSession | null>(null);
  const [feedback, setFeedback] = useState<CaptureFeedback | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useLayoutEffect(() => {
    const session: CaptureSession = { active: allowed, busy: false, controller: new AbortController() };
    sessionRef.current = session;
    return () => { session.active = false; session.controller.abort(); };
  }, [allowed, scope.orgId, scope.memberId, member?.userId, member?.role, member?.isOwner]);

  const isCurrent = (session: CaptureSession) => session.active && sessionRef.current === session;
  async function refreshStatus(session = sessionRef.current, keepFeedback = false) {
    if (!session || !isCurrent(session)) return;
    setRefreshing(true);
    setNeedsRefresh(true);
    const key = [...auditQueryKey(scope), "usage"];
    try {
      await client.cancelQueries({ queryKey: key, exact: true });
      if (!isCurrent(session)) return;
      const usage = await withAuditDeadline(session.controller.signal, (signal) => getAuditUsage(scope, signal));
      if (!isCurrent(session)) return;
      await client.cancelQueries({ queryKey: key, exact: true });
      if (!isCurrent(session)) return;
      client.setQueryData(key, usage);
      setNeedsRefresh(false);
      if (!keepFeedback) setFeedback(null);
    } catch (error) {
      if (!isCurrent(session)) return;
      if (isAuditAccessError(error)) onAccessError(error);
      else setFeedback({ tone: "error", message: "Could not verify capture status. Refresh status before changing capture." });
    } finally {
      if (isCurrent(session)) setRefreshing(false);
    }
  }

  const mutation = useMutation({
    mutationKey: [...auditQueryKey(scope), "capture"], retry: false, networkMode: "always",
    mutationFn: async (captureOn: boolean) => {
      const session = sessionRef.current;
      const usage = query.data;
      if (!session || !isCurrent(session) || session.busy || refreshing || needsRefresh || query.isFetching || query.isError || !usage
        || captureOn === usage.captureOn || (captureOn && auditCaptureLockReason(usage))) return;
      session.busy = true;
      setFeedback(null);
      const pinnedScope = { ...scope };
      const input = { captureOn, expectedRevision: usage.policy?.revision ?? 0 };
      const key = [...auditQueryKey(pinnedScope), "usage"];
      let sent = false;
      let canSend = true;
      const ensureCurrent = () => {
        if (!isCurrent(session)) throw new Error("The workspace or membership changed.");
      };
      try {
        await client.cancelQueries({ queryKey: key, exact: true });
        ensureCurrent();
        await dashboard.runReauthableAction("update-audit-capture", async () => {
          ensureCurrent();
          if (!canSend) throw new Error("Refresh status before changing capture.");
          canSend = false;
          sent = true;
          let result: AuditUsageResponse;
          try {
            result = await updateAuditCapture(pinnedScope, input, session.controller.signal);
          } catch (error) {
            if (isReauthRequiredError(error)) { sent = false; canSend = true; }
            throw error;
          }
          ensureCurrent();
          await client.cancelQueries({ queryKey: key, exact: true });
          ensureCurrent();
          client.setQueryData(key, result);
        });
      } catch (error) {
        if (!isCurrent(session)) return;
        if (isAuditAccessError(error)) { onAccessError(error); return; }
        const changed = error instanceof AuditReadError && (error.status === 402
          || (error.status === 409 && ["audit_policy_changed", "audit_policy_not_configured", "audit_capture_unavailable"].includes(error.code ?? "")));
        if (changed) {
          setFeedback({ tone: "neutral", message: error.code === "audit_policy_changed"
            ? "Capture settings changed. Review the latest status and try again."
            : "Capture availability changed. Review the latest restrictions before trying again." });
          await refreshStatus(session, true);
        } else {
          setNeedsRefresh(sent);
          setFeedback({ tone: "error", message: sent
            ? "The capture change could not be verified. Refresh status before trying again."
            : "Capture change was not sent. Confirm your session and try again." });
        }
      } finally {
        canSend = false;
        if (isCurrent(session)) session.busy = false;
      }
    },
  });
  const busy = mutation.isPending || refreshing || query.isFetching;
  return {
    query, feedback, needsRefresh, busy,
    disabled: !allowed || busy || needsRefresh || query.isError || !query.data
      || (!query.data.captureOn && Boolean(auditCaptureLockReason(query.data))),
    change: (captureOn: boolean) => mutation.mutate(captureOn),
    refresh: () => { if (!mutation.isPending && !refreshing) void refreshStatus(); },
  };
}
