import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type ParentProps } from "solid-js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function serverDisplayName(url: string) {
  if (!url) return "";
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

type ServerContextValue = {
  url: string;
  name: string;
  list: string[];
  healthy: () => boolean | undefined;
  version: () => string | null;
  setActive: (url: string) => void;
  add: (url: string) => void;
  remove: (url: string) => void;
};

const ServerContext = createContext<ServerContextValue | undefined>(undefined);

export function ServerProvider(props: ParentProps & { defaultUrl: string }) {
  const [list, setList] = createSignal<string[]>([]);
  const [active, setActiveRaw] = createSignal("");
  const [healthy, setHealthy] = createSignal<boolean | undefined>(undefined);
  const [version, setVersion] = createSignal<string | null>(null);
  const [ready, setReady] = createSignal(false);

  const readStoredList = () => {
    try {
      const raw = window.localStorage.getItem("openwork.server.list");
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  };

  const readStoredActive = () => {
    try {
      const stored = window.localStorage.getItem("openwork.server.active");
      return typeof stored === "string" ? stored : "";
    } catch {
      return "";
    }
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (ready()) return;

    const storedList = readStoredList();
    const fallback = normalizeServerUrl(props.defaultUrl) ?? "";
    const storedActive = normalizeServerUrl(readStoredActive());

    const initialList = storedList.length ? storedList : fallback ? [fallback] : [];
    const initialActive = storedActive || initialList[0] || fallback || "";

    setList(initialList);
    setActiveRaw(initialActive);
    setReady(true);
  });

  createEffect(() => {
    if (!ready()) return;
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem("openwork.server.list", JSON.stringify(list()));
      window.localStorage.setItem("openwork.server.active", active());
    } catch {
      // ignore
    }
  });

  const activeUrl = createMemo(() => active());

  const checkHealth = async (url: string) => {
    if (!url) return false;
    const client = createOpencodeClient({
      baseUrl: url,
      signal: AbortSignal.timeout(3000),
    });
    return client.global
      .health()
      .then((result) => result.data ?? null)
      .catch(() => null);
  };

  createEffect(() => {
    const url = activeUrl();
    if (!url) return;

    setHealthy(undefined);
    setVersion(null);

    let activeRun = true;
    let busy = false;

    const run = () => {
      if (busy) return;
      busy = true;
      void checkHealth(url)
        .then((next) => {
          if (!activeRun) return;
          if (!next) {
            setHealthy(false);
            setVersion(null);
            return;
          }
          setHealthy(next.healthy === true);
          setVersion(typeof next.version === "string" ? next.version : null);
        })
        .finally(() => {
          busy = false;
        });
    };

    run();
    const interval = window.setInterval(run, 10_000);

    onCleanup(() => {
      activeRun = false;
      window.clearInterval(interval);
    });
  });

  const setActive = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;
    setActiveRaw(next);
  };

  const add = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;

    setList((current) => {
      if (current.includes(next)) return current;
      return [...current, next];
    });
    setActiveRaw(next);
  };

  const remove = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;

    setList((current) => current.filter((item) => item !== next));
    setActiveRaw((current) => {
      if (current !== next) return current;
      const remaining = list().filter((item) => item !== next);
      return remaining[0] ?? "";
    });
  };

  const value: ServerContextValue = {
    get url() {
      return activeUrl();
    },
    get name() {
      return serverDisplayName(activeUrl());
    },
    get list() {
      return list();
    },
    healthy,
    version,
    setActive,
    add,
    remove,
  };

  return <ServerContext.Provider value={value}>{props.children}</ServerContext.Provider>;
}

export function useServer() {
  const context = useContext(ServerContext);
  if (!context) {
    throw new Error("Server context is missing");
  }
  return context;
}
