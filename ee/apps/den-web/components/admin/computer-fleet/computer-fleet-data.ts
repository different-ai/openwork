"use client";

import {
  adminComputerDetailSchema,
  adminComputerFleetHistorySchema,
  adminComputerFleetSchema,
  type AdminComputerDetail,
  type AdminComputerFleet,
  type AdminComputerFleetHistory,
  type ComputerFleetHistoryRange,
  type ComputerFleetSourceKind,
} from "@openwork/types/den/admin-computer-fleet";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestAdmin, withStoredBearer, type AdminResult } from "../admin-request";
import { useAdminSessionCookie } from "../admin-shell";

export const COMPUTER_FLEET_PATH = "/v1/admin/computer-fleet";
/** Den shares one read of the providers for 15 seconds, so asking more often shows nothing new. */
const FLEET_REFRESH_MS = 15_000;
const HISTORY_REFRESH_MS = 60_000;

/** Asked fresh each time: the tab can be hidden or shown while a request is in flight. */
const tabHidden = () => document.visibilityState === "hidden";

const parseFleet = (payload: unknown): AdminComputerFleet | null => adminComputerFleetSchema.safeParse(payload).data ?? null;
const parseHistory = (payload: unknown): AdminComputerFleetHistory | null => adminComputerFleetHistorySchema.safeParse(payload).data ?? null;
const parseComputer = (payload: unknown): AdminComputerDetail | null => adminComputerDetailSchema.safeParse(payload).data ?? null;

type Access = Exclude<AdminResult<unknown>["access"], "ready">;
export type FleetState =
  | { status: "loading"; fleet: null; message: "" }
  | { status: "ready"; fleet: AdminComputerFleet; message: "" }
  | { status: Access; fleet: AdminComputerFleet | null; message: string };

/**
 * The fleet, read again every 15 seconds while the page is open and showing. A reading that fails keeps the last
 * one on the page and says so; a signed-out or removed admin sees that instead of a stale fleet. `organization`
 * (an id, or `unknown`) lists only that organization's computers; the totals stay the whole fleet's.
 */
export function useComputerFleet(organization = "") {
  const hasSessionCookie = useAdminSessionCookie();
  const [state, setState] = useState<FleetState>(() => hasSessionCookie ? { status: "loading", fleet: null, message: "" } : { status: "signed-out", fleet: null, message: "" });
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const last = useRef<AdminComputerFleet | null>(null);

  useEffect(() => {
    if (attempt === 0 && !hasSessionCookie && !withStoredBearer({}).Authorization) {
      setState({ status: "signed-out", fleet: null, message: "" });
      return;
    }
    const controller = new AbortController();
    let busy = false;
    const load = () => {
      if (busy || tabHidden()) return;
      busy = true;
      requestAdmin(organization ? `${COMPUTER_FLEET_PATH}?organization=${encodeURIComponent(organization)}` : COMPUTER_FLEET_PATH, parseFleet, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        if (result.access === "ready") {
          last.current = result.data;
          setReceivedAt(Date.now());
          setState({ status: "ready", fleet: result.data, message: "" });
        } else {
          // Signed out or not an admin: the last fleet is not theirs to keep looking at.
          const keep = result.access === "error" ? last.current : null;
          setState({ status: result.access, fleet: keep, message: result.message });
        }
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", fleet: last.current, message: error instanceof Error ? error.message : "The request failed." });
      }).finally(() => { busy = false; });
    };
    load();
    const timer = setInterval(load, FLEET_REFRESH_MS);
    // Coming back to the tab reads at once instead of waiting out the interval.
    const shown = () => { if (!tabHidden()) load(); };
    document.addEventListener("visibilitychange", shown);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", shown); };
  }, [attempt, hasSessionCookie, organization]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, receivedAt, retry };
}

export type ComputerState =
  | { status: "loading"; computer: null; message: ""; code?: undefined }
  | { status: "ready"; computer: AdminComputerDetail; message: ""; code?: undefined }
  /** `missing`: the provider has no such computer, or it is not one of this deployment's. */
  | { status: "missing"; computer: null; message: string; code?: undefined }
  | { status: Access; computer: AdminComputerDetail | null; message: string; code?: string };

/** One computer, read again every 15 seconds while its page is open and showing. */
export function useComputer(source: ComputerFleetSourceKind, id: string) {
  const hasSessionCookie = useAdminSessionCookie();
  const [state, setState] = useState<ComputerState>(() => hasSessionCookie ? { status: "loading", computer: null, message: "" } : { status: "signed-out", computer: null, message: "" });
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const last = useRef<AdminComputerDetail | null>(null);

  useEffect(() => {
    if (attempt === 0 && !hasSessionCookie && !withStoredBearer({}).Authorization) {
      setState({ status: "signed-out", computer: null, message: "" });
      return;
    }
    const controller = new AbortController();
    let busy = false;
    let gone = false;
    const load = () => {
      if (busy || gone || tabHidden()) return;
      busy = true;
      requestAdmin(`${COMPUTER_FLEET_PATH}/computers/${source}/${encodeURIComponent(id)}`, parseComputer, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        if (result.access === "ready") {
          last.current = result.data;
          setReceivedAt(Date.now());
          setState({ status: "ready", computer: result.data, message: "" });
        } else if (result.access === "error" && (result.status === 404 || result.status === 400)) {
          // Deleted, or never this deployment's: asking again would only say so again.
          gone = true;
          setState({ status: "missing", computer: null, message: result.message });
        } else {
          const keep = result.access === "error" ? last.current : null;
          setState({ status: result.access, computer: keep, message: result.message, code: result.access === "error" ? result.code : undefined });
        }
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", computer: last.current, message: error instanceof Error ? error.message : "The request failed." });
      }).finally(() => { busy = false; });
    };
    load();
    const timer = setInterval(load, FLEET_REFRESH_MS);
    const shown = () => { if (!tabHidden()) load(); };
    document.addEventListener("visibilitychange", shown);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", shown); };
  }, [attempt, hasSessionCookie, source, id]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, receivedAt, retry };
}

export type HistoryState = { status: "loading" | "ready" | "error"; history: AdminComputerFleetHistory | null; message: string };

/** The recorded history for a range, read again each minute while the page is open. */
export function useComputerFleetHistory(range: ComputerFleetHistoryRange, enabled: boolean) {
  const [state, setState] = useState<HistoryState>({ status: "loading", history: null, message: "" });
  const last = useRef<{ range: ComputerFleetHistoryRange; history: AdminComputerFleetHistory } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const load = () => {
      if (tabHidden()) return;
      requestAdmin(`${COMPUTER_FLEET_PATH}/history?range=${range}`, parseHistory, controller.signal).then((result) => {
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
    // A page opened in a background tab reads its history when it is first shown, not a minute later.
    const shown = () => { if (!tabHidden()) load(); };
    document.addEventListener("visibilitychange", shown);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", shown); };
  }, [range, enabled]);
  return state;
}
