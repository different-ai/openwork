import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client";
import { createGlobalEmitter } from "@solid-primitives/event-bus";
import {
  batch,
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js";

import { usePlatform } from "./platform";
import { useServer } from "./server";

type GlobalSDKContextValue = {
  url: () => string;
  client: () => ReturnType<typeof createOpencodeClient>;
  event: ReturnType<typeof createGlobalEmitter<{ [key: string]: Event }>>;
};

const GlobalSDKContext = createContext<GlobalSDKContextValue | undefined>(undefined);

export function GlobalSDKProvider(props: ParentProps) {
  const server = useServer();
  const platform = usePlatform();
  const emitter = createGlobalEmitter<{ [key: string]: Event }>();
  const [client, setClient] = createSignal(
    createOpencodeClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    }),
  );
  const [url, setUrl] = createSignal(server.url);

  createEffect(() => {
    const baseUrl = server.url;
    setUrl(baseUrl);

    const abort = new AbortController();
    const eventClient = createOpencodeClient({
      baseUrl,
      signal: abort.signal,
      fetch: platform.fetch,
    });

    setClient(
      createOpencodeClient({
        baseUrl,
        fetch: platform.fetch,
        throwOnError: true,
      }),
    );

    type Queued = { directory: string; payload: Event };

    let queue: Array<Queued | undefined> = [];
    const coalesced = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;

    const keyForEvent = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`;
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`;
      if (payload.type === "todo.updated") return `todo.updated:${directory}:${payload.properties.sessionID}`;
      if (payload.type === "mcp.tools.changed") return `mcp.tools.changed:${directory}:${payload.properties.server}`;
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part;
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`;
      }
    };

    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;

      const events = queue;
      queue = [];
      coalesced.clear();
      if (events.length === 0) return;

      last = Date.now();
      batch(() => {
        for (const entry of events) {
          if (!entry) continue;
          emitter.emit(entry.directory, entry.payload);
        }
      });
    };

    const schedule = () => {
      if (timer) return;
      const elapsed = Date.now() - last;
      timer = setTimeout(flush, Math.max(0, 16 - elapsed));
    };

    const stop = () => {
      flush();
    };

    void (async () => {
      const subscription = await eventClient.event.subscribe(undefined, { signal: abort.signal });
      let yielded = Date.now();

      for await (const event of subscription.stream as AsyncIterable<unknown>) {
        const record = event as Event & { directory?: string; payload?: Event };
        const payload = record.payload ?? record;
        if (!payload?.type) continue;

        const directory = typeof record.directory === "string" ? record.directory : "global";
        const key = keyForEvent(directory, payload);
        if (key) {
          const index = coalesced.get(key);
          if (index !== undefined) {
            queue[index] = undefined;
          }
          coalesced.set(key, queue.length);
        }

        queue.push({ directory, payload });
        schedule();

        if (Date.now() - yielded < 8) continue;
        yielded = Date.now();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    })()
      .finally(stop)
      .catch(() => undefined);

    onCleanup(() => {
      abort.abort();
      stop();
    });
  });

  const value: GlobalSDKContextValue = {
    url,
    client,
    event: emitter,
  };

  return <GlobalSDKContext.Provider value={value}>{props.children}</GlobalSDKContext.Provider>;
}

export function useGlobalSDK() {
  const context = useContext(GlobalSDKContext);
  if (!context) {
    throw new Error("Global SDK context is missing");
  }
  return context;
}
