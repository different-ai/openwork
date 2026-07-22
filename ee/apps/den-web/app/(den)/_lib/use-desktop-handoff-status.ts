"use client";

import { useEffect, useState } from "react";
import { requestJson } from "./den-flow";

type DesktopHandoffStatus = "pending" | "consumed" | "unknown";

export type DesktopHandoffPollStatus = DesktopHandoffStatus | "idle";

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_POLL_INTERVAL_MS = 5000;
const HANDOFF_TIMEOUT_MS = 90 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStatus(payload: unknown): DesktopHandoffStatus | null {
  if (!isRecord(payload)) {
    return null;
  }

  const status = payload.status;
  return status === "pending" || status === "consumed" || status === "unknown" ? status : null;
}

export function useDesktopHandoffStatus(grant: string | null) {
  const normalizedGrant = grant?.trim() ?? "";
  const [status, setStatus] = useState<DesktopHandoffPollStatus>(normalizedGrant ? "pending" : "idle");
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!normalizedGrant) {
      setStatus("idle");
      setTimedOut(false);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    const startedAt = Date.now();

    setStatus("pending");
    setTimedOut(false);

    async function poll() {
      let shouldContinue = true;

      try {
        const { response, payload } = await requestJson(
          "/v1/auth/desktop-handoff/status",
          { method: "POST", body: JSON.stringify({ grant: normalizedGrant }) },
          12000,
        );

        if (!cancelled && response.ok) {
          const nextStatus = readStatus(payload);
          if (nextStatus === "consumed") {
            setStatus("consumed");
            shouldContinue = false;
          } else if (nextStatus === "unknown") {
            setStatus("unknown");
            shouldContinue = false;
          } else {
            setStatus("pending");
          }
        }
      } catch {
        if (!cancelled) {
          setStatus("pending");
        }
      }

      if (cancelled || !shouldContinue) {
        return;
      }

      const reachedTimeout = Date.now() - startedAt >= HANDOFF_TIMEOUT_MS;
      if (reachedTimeout) {
        setTimedOut(true);
      }

      timer = window.setTimeout(() => {
        void poll();
      }, reachedTimeout ? TIMEOUT_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
    }

    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [normalizedGrant]);

  return { status, timedOut };
}
