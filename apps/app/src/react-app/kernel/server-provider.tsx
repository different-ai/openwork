/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { desktopFetch } from "../../app/lib/desktop";
import { isWebDeployment } from "../../app/lib/openwork-deployment";
import { isDesktopRuntime } from "../../app/utils";

export function normalizeServerUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function serverDisplayName(url: string): string {
  if (!url) return "";
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

type ServerContextValue = {
  url: string;
  name: string;
  list: string[];
  healthy: boolean | undefined;
  setActive: (url: string) => void;
  add: (url: string) => void;
  remove: (url: string) => void;
};

const ServerContext = createContext<ServerContextValue | undefined>(undefined);

function readStoredList(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("openwork.server.list");
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readStoredActive(): string {
  if (typeof window === "undefined") return "";
  try {
    const stored = window.localStorage.getItem("openwork.server.active");
    return typeof stored === "string" ? stored : "";
  } catch {
    return "";
  }
}

function readOpenworkToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return (window.localStorage.getItem("openwork.server.token") ?? "").trim();
  } catch {
    return "";
  }
}

async function checkHealth(url: string): Promise<boolean> {
  if (!url) return false;
  const token = readOpenworkToken();
  const headers =
    token && url.includes("/opencode") ? { Authorization: `Bearer ${token}` } : undefined;
  const client = createOpencodeClient({
    baseUrl: url,
    headers,
    signal: AbortSignal.timeout(3000),
    fetch: isDesktopRuntime() ? desktopFetch : undefined,
  });
  return client.global
    .health()
    .then((result) => result.data?.healthy === true)
    .catch(() => false);
}

type ServerProviderProps = {
  children: ReactNode;
  defaultUrl: string;
};

export function ServerProvider({ children, defaultUrl }: ServerProviderProps) {
  const [list, setList] = useState<string[]>([]);
  const [active, setActiveRaw] = useState<string>("");
  const [healthy, setHealthy] = useState<boolean | undefined>(undefined);
  const readyRef = useRef(false);

  useEffect(() => {
    if (readyRef.current) return;
    if (typeof window === "undefined") return;

    const fallback = normalizeServerUrl(defaultUrl) ?? "";

    // Hosted web deployments served by OpenWork must reuse the OpenCode proxy
    // rather than any persisted localhost target.
    const forceProxy =
      !isDesktopRuntime() &&
      isWebDeployment() &&
      (import.meta.env.PROD ||
        (typeof import.meta.env?.VITE_OPENWORK_URL === "string" &&
          import.meta.env.VITE_OPENWORK_URL.trim().length > 0));

    if (forceProxy && fallback) {
      setList([fallback]);
      setActiveRaw(fallback);
      readyRef.current = true;
      return;
    }

    const storedList = readStoredList();
    const storedActive = normalizeServerUrl(readStoredActive());

    const initialList = storedList.length ? storedList : fallback ? [fallback] : [];
    const initialActive = storedActive || initialList[0] || fallback || "";

    setList(initialList);
    setActiveRaw(initialActive);
    readyRef.current = true;
  }, [defaultUrl]);

  useEffect(() => {
    if (!readyRef.current) return;
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.server.list", JSON.stringify(list));
      window.localStorage.setItem("openwork.server.active", active);
    } catch {
      // ignore
    }
  }, [active, list]);

  useEffect(() => {
    if (!active) return;
    if (isDesktopRuntime() && !active.includes("/opencode")) {
      // Desktop React routes now talk to OpenWork server workspace-mounted
      // `/opencode` URLs directly. Ignore old persisted raw OpenCode daemon
      // URLs here; their ephemeral ports go stale across restarts and otherwise
      // produce noisy `/global/health` connection-refused polling forever.
      setHealthy(undefined);
      return;
    }
    setHealthy(undefined);

    let cancelled = false;
    let busy = false;

    const run = () => {
      if (busy) return;
      busy = true;
      void checkHealth(active)
        .then((next) => {
          if (cancelled) return;
          setHealthy(next);
        })
        .finally(() => {
          busy = false;
        });
    };

    run();
    const interval = window.setInterval(run, 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [active]);

  const setActive = useCallback((input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;
    setActiveRaw(next);
  }, []);

  const add = useCallback((input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;
    setList((current) => (current.includes(next) ? current : [...current, next]));
    setActiveRaw(next);
  }, []);

  const remove = useCallback((input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;
    setList((current) => current.filter((item) => item !== next));
    setActiveRaw((current) => {
      if (current !== next) return current;
      // Read latest list after the filter above through functional updater.
      const remaining = readStoredList().filter((item) => item !== next);
      return remaining[0] ?? "";
    });
  }, []);

  const value = useMemo<ServerContextValue>(
    () => ({
      url: active,
      name: serverDisplayName(active),
      list,
      healthy,
      setActive,
      add,
      remove,
    }),
    [active, add, healthy, list, remove, setActive],
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer(): ServerContextValue {
  const context = useContext(ServerContext);
  if (!context) {
    throw new Error("Server context is missing");
  }
  return context;
}
