import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { cloudCodingPushApprovalListSchema, cloudCodingPushApprovalSchema, type CloudCodingPushApproval, type CloudCodingPushDecisionInput } from "@openwork/types/den/cloud-coding";
import type { WorkbotHost } from "./host";

const path = "/v1/workbot/cloud-coding/approvals";
const failure = "Couldn’t check push approvals. Try again.";
type Decision = CloudCodingPushDecisionInput["decision"];
type Retry = Decision | "read";
export type PushApprovalEntry = { approval: CloudCodingPushApproval; elsewhere?: boolean; busy?: boolean; error?: string; retry?: Retry };

export function createCloudCodingApprovals(request: WorkbotHost["requestJson"]) {
  const listeners = new Set<() => void>();
  const entries = new Map<string, PushApprovalEntry>();
  let snapshot = { entries: Array.from(entries.values()), disabled: false, error: "" };
  const publish = (changes: Partial<typeof snapshot> = {}) => {
    snapshot = { ...snapshot, ...changes, entries: Array.from(entries.values()) };
    for (const listener of listeners) listener();
  };
  const update = (entry: PushApprovalEntry) => {
    if (snapshot.disabled) return;
    entries.set(entry.approval.id, entry);
    publish();
  };
  const detailPath = (id: string) => `${path}/${encodeURIComponent(id)}`;
  const isFeatureOff = (status: number, payload: unknown) => status === 404 && typeof payload === "object" && payload !== null && "error" in payload && payload.error === "feature_disabled";
  const read = async (entry: PushApprovalEntry, elsewhere = entry.elsewhere) => {
    update({ ...entry, busy: true, error: undefined, retry: "read", elsewhere });
    try {
      const { response, payload } = await request(detailPath(entry.approval.id));
      if (!response.ok) throw new Error(failure);
      update({ approval: cloudCodingPushApprovalSchema.parse(payload), elsewhere });
    } catch {
      update({ ...entry, busy: false, error: failure, retry: "read", elsewhere });
    }
  };
  const decide = async (id: string, decision: Decision) => {
    const entry = entries.get(id);
    if (snapshot.disabled || !entry || entry.busy || entry.retry === "read" || entry.approval.status !== "pending") return;
    update({ ...entry, busy: true, error: undefined, retry: undefined });
    try {
      const { response, payload } = await request(`${detailPath(id)}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
      });
      if (response.status === 409) return await read(entry, true);
      if (!response.ok) throw new Error(failure);
      update({ approval: cloudCodingPushApprovalSchema.parse(payload) });
    } catch {
      update({ ...entry, busy: false, error: "Couldn’t save your decision. Try again.", retry: decision });
    }
  };
  let refreshing: Promise<void> | undefined;
  const refresh = () => {
    if (snapshot.disabled) return Promise.resolve();
    refreshing ??= (async () => {
      let pending: CloudCodingPushApproval[];
      try {
        const { response, payload } = await request(path);
        if (isFeatureOff(response.status, payload)) { entries.clear(); publish({ disabled: true, error: "" }); return; }
        if (!response.ok) throw new Error(failure);
        pending = cloudCodingPushApprovalListSchema.parse(payload).approvals;
      } catch {
        publish({ error: failure });
        return;
      }
      const ids = new Set(pending.map(({ id }) => id));
      for (const approval of pending) if (!entries.has(approval.id)) entries.set(approval.id, { approval });
      publish({ error: "" });
      await Promise.all([...entries.values()].map(entry => {
        const { approval } = entry;
        if (entry.busy || entry.retry === "read" || approval.pullRequest) return;
        if (approval.status === "pending" && !ids.has(approval.id)) return read(entry, true);
        if (approval.status === "approved" || approval.status === "pushed") return read(entry);
      }));
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => snapshot,
    refresh, decide,
    retry(id: string) {
      const entry = entries.get(id);
      if (!entry || entry.busy || snapshot.disabled) return;
      return entry.retry === "read" ? read(entry) : entry.retry ? decide(id, entry.retry) : undefined;
    },
    dismiss(id: string) { entries.delete(id); publish(); },
  };
}

export function useCloudCodingApprovals(store: ReturnType<typeof createCloudCodingApprovals>, input: { open: boolean; busy: boolean; principalId?: string; organizationId?: string }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const query = useQuery({
    queryKey: ["workbot-cloud-coding-approvals", input.organizationId, input.principalId],
    queryFn: async () => { if (document.visibilityState === "visible") await store.refresh(); return true; },
    enabled: input.open && !snapshot.disabled,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !input.busy && input.open && !snapshot.disabled && document.visibilityState === "visible") void query.refetch();
    wasBusy.current = input.busy;
  }, [input.busy, input.open, snapshot.disabled, query.refetch]);
  return snapshot;
}
