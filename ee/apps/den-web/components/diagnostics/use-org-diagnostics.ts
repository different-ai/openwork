"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { OrgDiagnostics } from "@openwork/types/den/diagnostics";
import { DIAGNOSTICS_POLL_LIMIT_MS, DIAGNOSTICS_POLL_MS, isChecking, shouldPollDiagnostics } from "./diagnostics-data";
import { readOrgDiagnostics, startOrgDiagnosticsCheck, type DiagnosticsFailure } from "./diagnostics-transport";

/** Used when a 429 arrives without a usable Retry-After. */
const DEFAULT_COOLDOWN_SECONDS = 30;

export class DiagnosticsRequestError extends Error {
  constructor(readonly failure: DiagnosticsFailure, readonly status: number) {
    super(`Diagnostics request failed (${status}).`);
    this.name = "DiagnosticsRequestError";
  }
}

export function orgDiagnosticsQueryKey(orgId: string) {
  return ["org-diagnostics", orgId] as const;
}

function failureOf(error: unknown): DiagnosticsFailure | null {
  if (!error) return null;
  return error instanceof DiagnosticsRequestError ? error.failure : "error";
}

/**
 * Settings › Diagnostics data: one cached report per organization, Check now,
 * then a GET every 2 s while checks run (at most 30 s), and the server's
 * Retry-After as a cooldown.
 */
export function useOrgDiagnostics(orgId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const queryKey = orgDiagnosticsQueryKey(orgId);
  // When polling stops even if the server still reports checking.
  const [pollUntil, setPollUntil] = useState<number | null>(null);
  const [cooldown, setCooldown] = useState<{ until: number; seconds: number } | null>(null);

  const query = useQuery({
    queryKey,
    enabled: enabled && orgId.length > 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }): Promise<OrgDiagnostics> => {
      const result = await readOrgDiagnostics(orgId, signal);
      if (!result.ok) throw new DiagnosticsRequestError(result.failure, result.status);
      // A check someone else started also gets a bounded polling window.
      const checking = isChecking(result.data);
      setPollUntil((current) => (checking ? current ?? Date.now() + DIAGNOSTICS_POLL_LIMIT_MS : null));
      return result.data;
    },
    refetchInterval: (current) => (shouldPollDiagnostics(current.state.data, pollUntil, Date.now()) ? DIAGNOSTICS_POLL_MS : false),
  });

  const check = useMutation({
    mutationKey: [...queryKey, "check"],
    retry: false,
    mutationFn: async () => {
      const result = await startOrgDiagnosticsCheck(orgId);
      if (!result.ok) throw new DiagnosticsRequestError(result.failure, result.status);
      return result;
    },
    onSuccess: (result) => {
      if (result.rateLimited) {
        const seconds = result.retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS;
        setCooldown({ until: Date.now() + seconds * 1_000, seconds });
      }
      if (result.data) {
        // The check answers with the current report; polling picks up from there.
        queryClient.setQueryData(queryKey, result.data);
        if (isChecking(result.data)) setPollUntil(Date.now() + DIAGNOSTICS_POLL_LIMIT_MS);
        return;
      }
      if (!result.rateLimited) setPollUntil(Date.now() + DIAGNOSTICS_POLL_LIMIT_MS);
      void queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });

  useEffect(() => {
    if (pollUntil === null) return;
    const timer = setTimeout(() => setPollUntil(null), Math.max(0, pollUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [pollUntil]);

  useEffect(() => {
    if (cooldown === null) return;
    const timer = setTimeout(() => setCooldown(null), Math.max(0, cooldown.until - Date.now()));
    return () => clearTimeout(timer);
  }, [cooldown]);

  const report = query.data ?? null;
  const polling = report !== null && pollUntil !== null && isChecking(report);
  return {
    report,
    loading: query.isPending && query.fetchStatus !== "idle",
    loadFailure: failureOf(query.error),
    dataUpdatedAt: query.dataUpdatedAt,
    checking: check.isPending || polling,
    checkFailed: check.isError,
    cooldownSeconds: cooldown?.seconds ?? null,
    checkNow: () => { if (!check.isPending && cooldown === null) check.mutate(); },
    refresh: () => { void query.refetch(); },
  };
}
