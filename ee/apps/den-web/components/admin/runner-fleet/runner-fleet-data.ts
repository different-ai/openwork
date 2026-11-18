"use client";

import {
  adminRunnerFleetHistorySchema,
  adminRunnerFleetSchema,
  type AdminRunnerFleet,
  type AdminRunnerFleetHistory,
  type RunnerFleetHistoryRange,
} from "@openwork/types/den/admin-runner-fleet";
import { useCallback, useEffect, useRef, useState } from "react";
import { denApiCredentials, denBrowserEndpoint } from "../../../app/(den)/_lib/den-api-origin";
import { requestAdmin, withStoredBearer, type AdminResult } from "../admin-request";
import { useAdminSessionCookie } from "../admin-shell";
import { createEventStreamParser } from "./runner-fleet-model";

export const RUNNER_FLEET_PATH = "/v1/admin/runner-fleet";
const HISTORY_REFRESH_MS = 60_000;
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000] as const;

/** Asked fresh each time: the tab can be hidden or shown while a request is in flight. */
const tabHidden = () => document.visibilityState === "hidden";

export const parseRunnerFleet = (payload: unknown): AdminRunnerFleet | null => adminRunnerFleetSchema.safeParse(payload).data ?? null;
const parseHistory = (payload: unknown): AdminRunnerFleetHistory | null => adminRunnerFleetHistorySchema.safeParse(payload).data ?? null;

type Access = Exclude<AdminResult<unknown>["access"], "ready">;
/** `live`: readings arrive on their own. `reconnecting`: the stream dropped and is being reopened. `paused`: the tab is hidden. */
export type FleetConnection = "connecting" | "live" | "reconnecting" | "paused";
export type FleetState =
  | { status: "loading"; fleet: null; message: "" }
  | { status: "ready"; fleet: AdminRunnerFleet; message: "" }
  | { status: Access; fleet: AdminRunnerFleet | null; message: string };

/**
 * The fleet, live. One request settles access and shows the first reading; then the event stream replaces it every
 * few seconds. A dropped stream is reopened with a growing wait, with a plain read first so a signed-out or removed
 * admin sees that instead of a stale fleet. Nothing is requested while the tab is hidden.
 */
export function useRunnerFleet() {
  const hasSessionCookie = useAdminSessionCookie();
  const [state, setState] = useState<FleetState>(() => hasSessionCookie ? { status: "loading", fleet: null, message: "" } : { status: "signed-out", fleet: null, message: "" });
  const [connection, setConnection] = useState<FleetConnection>("connecting");
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const last = useRef<AdminRunnerFleet | null>(null);

  useEffect(() => {
    if (attempt === 0 && !hasSessionCookie && !withStoredBearer({}).Authorization) {
      setState({ status: "signed-out", fleet: null, message: "" });
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stream: AbortController | undefined;
    let failures = 0;

    const accept = (fleet: AdminRunnerFleet) => {
      last.current = fleet;
      setState({ status: "ready", fleet, message: "" });
      setReceivedAt(Date.now());
    };
    const wait = (ms: number) => new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });

    /** One plain read. False when this admin may not see the page (or anything else stopped it for good). */
    const read = async () => {
      const result = await requestAdmin(RUNNER_FLEET_PATH, parseRunnerFleet, signal);
      if (signal.aborted) return false;
      if (result.access === "ready") { accept(result.data); return true; }
      if (result.access !== "error") last.current = null;
      setState({ status: result.access, fleet: last.current, message: result.message });
      return result.access === "error";
    };

    /** Reads the stream until it ends. True when it delivered at least one reading. */
    const watch = async (streamSignal: AbortSignal) => {
      const endpoint = denBrowserEndpoint(`${RUNNER_FLEET_PATH}/events`);
      const response = await fetch(endpoint, { cache: "no-store", credentials: denApiCredentials(endpoint), signal: streamSignal, headers: withStoredBearer({ Accept: "text/event-stream" }) });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel().catch(() => undefined);
        return false;
      }
      let delivered = false;
      let ended = false;
      const push = createEventStreamParser(({ event, data }) => {
        if (event === "end") { ended = true; return; }
        if (event !== "fleet") return;
        let payload: unknown = null;
        try { payload = JSON.parse(data); } catch { return; }
        const fleet = parseRunnerFleet(payload);
        if (!fleet) return;
        delivered = true;
        failures = 0;
        accept(fleet);
        setConnection("live");
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (!ended) {
          const part = await reader.read();
          if (part.done) break;
          push(decoder.decode(part.value, { stream: true }));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return delivered;
    };

    const run = async () => {
      while (!signal.aborted) {
        if (tabHidden()) {
          setConnection("paused");
          await new Promise<void>((resolve) => {
            const resume = () => { if (!tabHidden()) { document.removeEventListener("visibilitychange", resume); resolve(); } };
            document.addEventListener("visibilitychange", resume);
            signal.addEventListener("abort", () => { document.removeEventListener("visibilitychange", resume); resolve(); }, { once: true });
          });
          continue;
        }
        // The stream has its own switch, so hiding the tab closes it without ending the page's session.
        stream = new AbortController();
        const closeStream = () => stream?.abort();
        signal.addEventListener("abort", closeStream, { once: true });
        try {
          if (!await read()) return;
          const delivered = await watch(stream.signal);
          if (signal.aborted) return;
          failures = delivered ? 0 : failures + 1;
        } catch {
          if (signal.aborted) return;
          // A stream closed because the tab was hidden did not fail.
          if (!tabHidden()) failures += 1;
        } finally {
          signal.removeEventListener("abort", closeStream);
        }
        // A stream that ended on its own (its time was up) is reopened at once.
        if (failures > 0 && !tabHidden()) {
          setConnection("reconnecting");
          await wait(RECONNECT_MS[Math.min(failures, RECONNECT_MS.length) - 1] ?? 10_000);
        }
      }
    };
    setConnection("connecting");
    const hide = () => { if (tabHidden()) stream?.abort(); };
    document.addEventListener("visibilitychange", hide);
    void run();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [hasSessionCookie, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, connection, receivedAt, retry };
}

export type HistoryState = { status: "loading" | "ready" | "error"; history: AdminRunnerFleetHistory | null; message: string };

/** The recorded history for a range, read again each minute while the page is open. */
export function useRunnerFleetHistory(range: RunnerFleetHistoryRange, enabled: boolean) {
  const [state, setState] = useState<HistoryState>({ status: "loading", history: null, message: "" });
  const last = useRef<{ range: RunnerFleetHistoryRange; history: AdminRunnerFleetHistory } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const load = () => {
      if (tabHidden()) return;
      requestAdmin(`${RUNNER_FLEET_PATH}/history?range=${range}`, parseHistory, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        if (result.access === "ready") {
          last.current = { range, history: result.data };
          setState({ status: "ready", history: result.data, message: "" });
        } else {
          setState({ status: "error", history: last.current?.range === range ? last.current.history : null, message: result.message });
        }
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", history: last.current?.range === range ? last.current.history : null, message: error instanceof Error ? error.message : "The request failed." });
      });
    };
    setState({ status: "loading", history: last.current?.range === range ? last.current.history : null, message: "" });
    load();
    const timer = setInterval(load, HISTORY_REFRESH_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [range, enabled]);
  return state;
}
