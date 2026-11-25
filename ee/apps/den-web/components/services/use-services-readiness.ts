"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CHECK_COOLDOWN_MS, finishServicesRun, runServicesReadiness,
  SERVICES_VERIFY_ERROR, waitForServicePoll, type ServicesViewState, type ServicesTransport,
} from "./service-readiness-data";

export function useServicesReadiness(enabled: boolean, transport: ServicesTransport) {
  const [state, setState] = useState<ServicesViewState>({ status: "checking", snapshot: null, pending: false });
  const [cooldown, setCooldown] = useState(false);
  const active = useRef<AbortController | null>(null);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const startCooldown = useCallback((milliseconds: number) => {
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    setCooldown(true);
    cooldownTimer.current = setTimeout(() => { cooldownTimer.current = null; setCooldown(false); }, milliseconds);
  }, []);

  const load = useCallback(async (check: boolean) => {
    if (!enabled || busy.current || (check && cooldownTimer.current)) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    busy.current = true;
    if (check) startCooldown(CHECK_COOLDOWN_MS);
    setState((previous) => ({ ...previous, status: "checking", pending: true, message: undefined }));
    try {
      const result = await runServicesReadiness({
        signal: controller.signal, check,
        getSnapshot: () => transport.getSnapshot(controller.signal),
        startCheck: async () => {
          const result = await transport.startCheck(controller.signal);
          controller.signal.throwIfAborted();
          if (result.access !== "ready" && result.status === 429 && result.retryAfterSeconds) {
            startCooldown(Math.min(3_600, Math.max(1, result.retryAfterSeconds)) * 1_000);
          }
          return result;
        },
        wait: () => waitForServicePoll(controller.signal),
        onSnapshot: (snapshot) => setState({ status: "checking", snapshot, pending: true }),
      });
      if (controller.signal.aborted) return;
      setState((previous) => finishServicesRun(previous.snapshot, result));
    } catch {
      if (!controller.signal.aborted) setState((previous) => ({ ...previous, status: "error", pending: false, message: SERVICES_VERIFY_ERROR }));
    } finally {
      if (active.current === controller) busy.current = false;
    }
  }, [enabled, startCooldown, transport]);

  useEffect(() => {
    setCooldown(false);
    if (enabled) void load(false);
    else setState({ status: "checking", snapshot: null, pending: false });
    return () => {
      active.current?.abort();
      active.current = null;
      busy.current = false;
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
      cooldownTimer.current = null;
    };
  }, [enabled, load]);
  return { state, cooldown, checkNow: () => void load(true), refresh: () => void load(false) };
}
