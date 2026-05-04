/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createOpencodeClient,
  type Event,
} from "@opencode-ai/sdk/v2/client";

import { usePlatform } from "./platform";
import { useServer } from "./server-provider";

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

type Listener = (payload: Event) => void;

export type GlobalEventEmitter = {
  on: (channel: string, listener: Listener) => () => void;
  off: (channel: string, listener: Listener) => void;
  emit: (channel: string, payload: Event) => void;
};

function createEmitter(): GlobalEventEmitter {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on(channel, listener) {
      let bucket = listeners.get(channel);
      if (!bucket) {
        bucket = new Set();
        listeners.set(channel, bucket);
      }
      bucket.add(listener);
      return () => this.off(channel, listener);
    },
    off(channel, listener) {
      const bucket = listeners.get(channel);
      if (!bucket) return;
      bucket.delete(listener);
      if (bucket.size === 0) listeners.delete(channel);
    },
    emit(channel, payload) {
      const bucket = listeners.get(channel);
      if (!bucket) return;
      for (const listener of bucket) listener(payload);
    },
  };
}

type GlobalSDKContextValue = {
  url: string;
  client: OpencodeClient;
  event: GlobalEventEmitter;
};

const GlobalSDKContext = createContext<GlobalSDKContextValue | undefined>(
  undefined,
);

function readOpenworkToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return (window.localStorage.getItem("openwork.server.token") ?? "").trim();
  } catch {
    return "";
  }
}

type GlobalSDKProviderProps = {
  children: ReactNode;
};

export function GlobalSDKProvider({ children }: GlobalSDKProviderProps) {
  const server = useServer();
  const platform = usePlatform();
  const emitterRef = useRef<GlobalEventEmitter | null>(null);
  if (!emitterRef.current) {
    emitterRef.current = createEmitter();
  }
  const emitter = emitterRef.current;

  const token = readOpenworkToken();
  const headers =
    token && server.url.includes("/opencode")
      ? { Authorization: `Bearer ${token}` }
      : undefined;

  const [client, setClient] = useState<OpencodeClient>(() =>
    createOpencodeClient({
      baseUrl: server.url,
      headers,
      fetch: platform.fetch,
      throwOnError: true,
    }),
  );

  useEffect(() => {
    setClient(
      createOpencodeClient({
        baseUrl: server.url,
        headers,
        fetch: platform.fetch,
        throwOnError: true,
      }),
    );
  }, [platform.fetch, server.url]);

  useEffect(() => {
    const baseUrl = server.url;
    const isHealthy = server.healthy === true;
    if (!baseUrl || !isHealthy) return;

    const abort = new AbortController();
    const eventClient = createOpencodeClient({
      baseUrl,
      headers,
      signal: abort.signal,
      fetch: platform.fetch,
    });

    type Queued = { directory: string; payload: Event };
    let queue: Array<Queued | undefined> = [];
    const coalesced = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;

    const keyForEvent = (directory: string, payload: Event): string | undefined => {
      if (payload.type === "session.status")
        return `session.status:${directory}:${payload.properties.sessionID}`;
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`;
      if (payload.type === "todo.updated")
        return `todo.updated:${directory}:${payload.properties.sessionID}`;
      if (payload.type === "mcp.tools.changed")
        return `mcp.tools.changed:${directory}:${payload.properties.server}`;
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part;
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`;
      }
      return undefined;
    };

    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const events = queue;
      queue = [];
      coalesced.clear();
      if (!events.length) return;
      last = Date.now();
      for (const entry of events) {
        if (!entry) continue;
        emitter.emit(entry.directory, entry.payload);
      }
    };

    const schedule = () => {
      if (timer) return;
      const elapsed = Date.now() - last;
      timer = setTimeout(flush, Math.max(0, 16 - elapsed));
    };

    void (async () => {
      const subscription = await eventClient.event.subscribe(undefined, {
        signal: abort.signal,
      });
      let yielded = Date.now();

      for await (const event of subscription.stream as AsyncIterable<unknown>) {
        const record = event as Event & { directory?: string; payload?: Event };
        const payload = record.payload ?? record;
        if (!payload?.type) continue;
        const directory =
          typeof record.directory === "string" ? record.directory : "global";
        const key = keyForEvent(directory, payload);
        if (key) {
          const index = coalesced.get(key);
          if (index !== undefined) queue[index] = undefined;
          coalesced.set(key, queue.length);
        }
        queue.push({ directory, payload });
        schedule();

        if (Date.now() - yielded < 8) continue;
        yielded = Date.now();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    })()
      .finally(flush)
      .catch(() => undefined);

    return () => {
      abort.abort();
      flush();
    };
    // headers is re-derived from local storage; rerun only when server URL or health flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emitter, platform.fetch, server.healthy, server.url]);

  const value = useMemo<GlobalSDKContextValue>(
    () => ({
      url: server.url,
      client,
      event: emitter,
    }),
    [client, emitter, server.url],
  );

  return (
    <GlobalSDKContext.Provider value={value}>{children}</GlobalSDKContext.Provider>
  );
}

export function useGlobalSDK(): GlobalSDKContextValue {
  const context = useContext(GlobalSDKContext);
  if (!context) {
    throw new Error("Global SDK context is missing");
  }
  return context;
}
