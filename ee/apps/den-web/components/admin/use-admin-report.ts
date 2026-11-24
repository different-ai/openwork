"use client";

import { useEffect, useRef, useState } from "react";
import { requestAdmin, withStoredBearer, type AdminResult } from "./admin-request";
import { useAdminSessionCookie } from "./admin-shell";

export type AdminLoadState<T> =
  | { status: "loading"; data: T | null }
  | { status: "ready"; data: T }
  | { status: Exclude<AdminResult<unknown>["access"], "ready">; message: string; data: T | null };

export function useAdminReport<T>(path: string, parse: (payload: unknown) => T | null, nonce: number) {
  const hasSessionCookie = useAdminSessionCookie();
  const [state, setState] = useState<AdminLoadState<T>>(() => hasSessionCookie ? { status: "loading", data: null }
    : { status: "signed-out", message: "", data: null });
  const last = useRef<T | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (nonce === 0 && !hasSessionCookie && !withStoredBearer({}).Authorization) {
      last.current = null;
      setState({ status: "signed-out", message: "", data: null });
      return () => controller.abort();
    }
    setState({ status: "loading", data: last.current });
    requestAdmin(path, parse, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.access === "ready") { last.current = result.data; setState({ status: "ready", data: result.data }); }
        else {
          if (result.access !== "error") last.current = null;
          setState({ status: result.access, message: result.message, data: last.current });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: error instanceof Error ? error.message : "The request failed.", data: last.current });
      });
    return () => controller.abort();
  }, [path, parse, hasSessionCookie, nonce]);
  return state;
}
