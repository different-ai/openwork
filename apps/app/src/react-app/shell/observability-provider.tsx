/** @jsxImportSource react */
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_OBSERVABILITY_CONFIG,
  formatObservabilityEvent,
  MAX_OBSERVABILITY_JOURNAL_BYTES,
  normalizeObservabilityConfig,
  type ObservabilityConfig,
  type ObservabilityEvent,
  type ObservabilityEventInput,
} from "@openwork/observability";

import { getDeveloperMode, useDeveloperMode } from "./developer-mode";
import {
  configureRendererObservationBridge,
  resetRendererObservationBridgeDroppedCount,
} from "./observability-bridge";
import { resolveOpenworkConnection } from "./openwork-connection";
import { setDeveloperObservabilityConfig } from "../../app/lib/desktop";
import { isElectronRuntime } from "../../app/utils";

export const OBSERVABILITY_PREFERENCES_STORAGE_KEY = "openwork.observability.config";

type ObservabilityPreferences = Omit<ObservabilityConfig, "enabled">;
type ObservabilityStatus = "disabled" | "connecting" | "connected" | "error";

type ObservabilityContextValue = {
  config: ObservabilityConfig;
  events: ObservabilityEvent[];
  droppedCount: number;
  status: ObservabilityStatus;
  statusMessage: string | null;
  updateConfig: (patch: Partial<ObservabilityPreferences>) => void;
  clear: () => Promise<void>;
};

type StorageAdapter = Pick<Storage, "getItem" | "setItem">;

type RetainedObservabilityEvents = {
  events: ObservabilityEvent[];
  evictedCount: number;
};

type RetainedObservabilityEventsAction =
  | { type: "reset" }
  | {
      type: "constrain";
      content: ObservabilityConfig["content"];
      maxEvents: number;
    }
  | {
      type: "append";
      events: ObservabilityEvent[];
      maxEvents: number;
    };

const ObservabilityContext = createContext<ObservabilityContextValue | undefined>(undefined);

function estimatedObservabilityEventBytes(event: ObservabilityEvent): number {
  try {
    // Match the server journal's conservative UTF-16 retained-memory estimate.
    return (JSON.stringify(event)?.length ?? 0) * 2;
  } catch {
    return MAX_OBSERVABILITY_JOURNAL_BYTES;
  }
}

export function retainNewestObservabilityEvents(
  events: readonly ObservabilityEvent[],
  options: { maxEvents: number; maxBytes?: number },
): { events: ObservabilityEvent[]; evictedCount: number; retainedBytes: number } {
  const maxEvents = Number.isFinite(options.maxEvents)
    ? Math.max(0, Math.trunc(options.maxEvents))
    : 0;
  const maxBytes = options.maxBytes === undefined
    ? MAX_OBSERVABILITY_JOURNAL_BYTES
    : Number.isFinite(options.maxBytes)
      ? Math.max(0, Math.trunc(options.maxBytes))
      : 0;
  const eventBytes = events.map(estimatedObservabilityEventBytes);
  let retainedBytes = eventBytes.reduce((total, size) => total + size, 0);
  let firstRetainedIndex = 0;

  while (
    firstRetainedIndex < events.length
    && (
      events.length - firstRetainedIndex > maxEvents
      || retainedBytes > maxBytes
    )
  ) {
    retainedBytes -= eventBytes[firstRetainedIndex] ?? 0;
    firstRetainedIndex += 1;
  }

  return {
    events: events.slice(firstRetainedIndex),
    evictedCount: firstRetainedIndex,
    retainedBytes,
  };
}

function retainedObservabilityEventsReducer(
  state: RetainedObservabilityEvents,
  action: RetainedObservabilityEventsAction,
): RetainedObservabilityEvents {
  if (action.type === "reset") return { events: [], evictedCount: 0 };

  const candidates = action.type === "constrain"
    ? state.events.map((event) => applyDefensiveContentPolicy(event, action.content))
    : (() => {
        const byId = new Map(state.events.map((event) => [event.id, event]));
        for (const event of action.events) byId.set(event.id, event);
        return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
      })();
  const retained = retainNewestObservabilityEvents(candidates, {
    maxEvents: action.maxEvents,
  });
  return {
    events: retained.events,
    evictedCount: state.evictedCount + retained.evictedCount,
  };
}

function storageAdapter(): StorageAdapter | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function withoutEnabled(config: ObservabilityConfig): ObservabilityPreferences {
  return {
    level: config.level,
    scopes: [...config.scopes],
    console: config.console,
    content: config.content,
    maxEvents: config.maxEvents,
  };
}

const APP_DEFAULT_OBSERVABILITY_CONFIG = normalizeObservabilityConfig({
  ...DEFAULT_OBSERVABILITY_CONFIG,
  // Developer Mode promises an end-to-end trace. Raw events are metadata-only
  // by default and bounded, so event/renderer scopes should be visible without
  // requiring a second, easy-to-miss opt-in.
  scopes: [...DEFAULT_OBSERVABILITY_CONFIG.scopes, "event", "renderer"],
});

export function readObservabilityPreferences(storage: StorageAdapter | null): ObservabilityPreferences {
  if (!storage) return withoutEnabled(APP_DEFAULT_OBSERVABILITY_CONFIG);
  try {
    const raw = storage.getItem(OBSERVABILITY_PREFERENCES_STORAGE_KEY);
    if (!raw) return withoutEnabled(APP_DEFAULT_OBSERVABILITY_CONFIG);
    return withoutEnabled(normalizeObservabilityConfig(
      { ...JSON.parse(raw), enabled: false },
      APP_DEFAULT_OBSERVABILITY_CONFIG,
    ));
  } catch {
    return withoutEnabled(APP_DEFAULT_OBSERVABILITY_CONFIG);
  }
}

export function persistObservabilityPreferences(
  storage: StorageAdapter | null,
  config: ObservabilityConfig | ObservabilityPreferences,
) {
  if (!storage) return;
  const normalized = normalizeObservabilityConfig({ ...config, enabled: false });
  try {
    storage.setItem(
      OBSERVABILITY_PREFERENCES_STORAGE_KEY,
      JSON.stringify(withoutEnabled(normalized)),
    );
  } catch {
    // Preferences are best effort in privacy-restricted webviews.
  }
}

export function readStartupObservabilityConfig(): ObservabilityConfig {
  return normalizeObservabilityConfig({
    ...readObservabilityPreferences(storageAdapter()),
    enabled: getDeveloperMode(),
  });
}

function isObservabilityEvent(input: unknown): input is ObservabilityEvent {
  if (!input || typeof input !== "object") return false;
  const event = input as Partial<ObservabilityEvent>;
  return typeof event.id === "string"
    && typeof event.sequence === "number"
    && typeof event.timestamp === "string"
    && typeof event.action === "string"
    && typeof event.scope === "string"
    && typeof event.level === "string"
    && Boolean(event.source && typeof event.source.component === "string");
}

export function applyDefensiveContentPolicy(
  event: ObservabilityEvent,
  mode: ObservabilityConfig["content"],
): ObservabilityEvent {
  if (!event.content) return event;
  const content: NonNullable<ObservabilityEvent["content"]> = {};
  if (typeof event.content.kind === "string") content.kind = event.content.kind;
  if (typeof event.content.length === "number") content.length = event.content.length;
  if (typeof event.content.complete === "boolean") content.complete = event.content.complete;
  if (typeof event.content.truncated === "boolean") content.truncated = event.content.truncated;
  if (typeof event.content.redactionCount === "number") {
    content.redactionCount = event.content.redactionCount;
  }
  if (mode !== "metadata") {
    if (typeof event.content.hash === "string") content.hash = event.content.hash;
    if (typeof event.content.rawHash === "string") content.rawHash = event.content.rawHash;
    if (typeof event.content.capturedHash === "string") {
      content.capturedHash = event.content.capturedHash;
    }
  }
  if (mode === "full") content.value = event.content.value;
  return { ...event, content };
}

function consoleEvent(event: ObservabilityEvent) {
  const line = `[openwork:${event.scope}] ${formatObservabilityEvent(event)}`;
  if (event.level === "error") console.error(line);
  else if (event.level === "warn") console.warn(line);
  else if (event.level === "debug") console.debug(line);
  else console.info(line);
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

class ObservabilityRequestError extends Error {
  constructor(readonly status: number) {
    super(`Observability request failed (${status})`);
    this.name = "ObservabilityRequestError";
  }
}

type ObservabilityControlSnapshot = {
  collectionEpoch: number;
  configRevision: number;
};

export function parseObservabilityControlSnapshot(
  input: Record<string, unknown>,
): ObservabilityControlSnapshot | null {
  const collectionEpoch = input.collectionEpoch;
  const configRevision = input.configRevision;
  if (
    typeof collectionEpoch !== "number"
    || !Number.isSafeInteger(collectionEpoch)
    || collectionEpoch < 0
    || typeof configRevision !== "number"
    || !Number.isSafeInteger(configRevision)
    || configRevision < 0
  ) return null;
  return { collectionEpoch, configRevision };
}

export function ObservabilityProvider({ children }: { children: ReactNode }) {
  const developerMode = useDeveloperMode();
  const [preferences, setPreferences] = useState<ObservabilityPreferences>(() =>
    readObservabilityPreferences(storageAdapter()),
  );
  const config = useMemo<ObservabilityConfig>(() =>
    normalizeObservabilityConfig({ ...preferences, enabled: developerMode }),
  [developerMode, preferences]);
  const configRef = useRef(config);
  configRef.current = config;
  const [retainedEvents, dispatchRetainedEvents] = useReducer(
    retainedObservabilityEventsReducer,
    { events: [], evictedCount: 0 },
  );
  const events = retainedEvents.events;
  const [serverDroppedCount, setServerDroppedCount] = useState(0);
  const [rendererDroppedCount, setRendererDroppedCount] = useState(0);
  const [status, setStatus] = useState<ObservabilityStatus>(
    developerMode ? "connecting" : "disabled",
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const afterSequenceRef = useRef(0);
  const connectionRef = useRef<{ baseUrl: string; token: string } | null>(null);
  const effectGenerationRef = useRef(0);
  const journalFenceRef = useRef(0);
  const [activationVersion, restartObservationEffect] = useReducer(
    (value: number) => value + 1,
    0,
  );

  useEffect(() => {
    if (!config.enabled) {
      dispatchRetainedEvents({ type: "reset" });
      setServerDroppedCount(0);
      setRendererDroppedCount(0);
      resetRendererObservationBridgeDroppedCount();
      afterSequenceRef.current = 0;
      return;
    }
    dispatchRetainedEvents({
      type: "constrain",
      content: config.content,
      maxEvents: config.maxEvents,
    });
  }, [config.content, config.enabled, config.maxEvents]);
  const lastConnectionRef = useRef<{ baseUrl: string; token: string } | null>(null);

  const updateConfig = useCallback((patch: Partial<ObservabilityPreferences>) => {
    setPreferences((current) => {
      const normalized = normalizeObservabilityConfig({ ...current, ...patch, enabled: false });
      const next = withoutEnabled(normalized);
      persistObservabilityPreferences(storageAdapter(), next);
      return next;
    });
  }, []);

  const request = useCallback(async (
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ) => {
    let connection = connectionRef.current;
    if (!connection) {
      const resolved = await resolveOpenworkConnection();
      signal?.throwIfAborted();
      if (!resolved.normalizedBaseUrl || !resolved.resolvedToken) {
        throw new Error("OpenWork server connection is unavailable");
      }
      connection = {
        baseUrl: resolved.normalizedBaseUrl.replace(/\/+$/, ""),
        token: resolved.resolvedToken,
      };
      const previous = lastConnectionRef.current;
      if (previous && (previous.baseUrl !== connection.baseUrl || previous.token !== connection.token)) {
        afterSequenceRef.current = 0;
        dispatchRetainedEvents({ type: "reset" });
      }
      lastConnectionRef.current = connection;
      connectionRef.current = connection;
    }
    signal?.throwIfAborted();
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
    if (!response.ok) throw new ObservabilityRequestError(response.status);
    return response;
  }, []);

  const clear = useCallback(async () => {
    dispatchRetainedEvents({ type: "reset" });
    setServerDroppedCount(0);
    setRendererDroppedCount(0);
    resetRendererObservationBridgeDroppedCount();
    if (!configRef.current.enabled) return;
    // Invalidate reads and producer batches before awaiting the server. A late
    // response from the prior generation must not refill the local journal.
    journalFenceRef.current += 1;
    effectGenerationRef.current += 1;
    configureRendererObservationBridge({ enabled: false });
    setStatusMessage(null);
    try {
      const response = await request("/observability/events", { method: "DELETE" });
      const body = await parseJson(response);
      if (!parseObservabilityControlSnapshot(body)) {
        throw new Error("Observability clear response is invalid");
      }
      restartObservationEffect();
    } catch (error) {
      // Stay fenced on failure. A new Clear attempt can retry, but collection
      // must not silently resume while the server may still retain old data.
      setStatus("error");
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, [request]);

  useEffect(() => {
    const effectGeneration = effectGenerationRef.current + 1;
    effectGenerationRef.current = effectGeneration;
    let active = true;
    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let disableRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let activeCollectionEpoch: number | null = null;
    connectionRef.current = null;
    configureRendererObservationBridge({ enabled: false });

    const isCurrent = () => active
      && !controller.signal.aborted
      && effectGenerationRef.current === effectGeneration
      && configRef.current === config;

    const readControlSnapshot = async (): Promise<ObservabilityControlSnapshot> => {
      const response = await request("/observability/config", {}, controller.signal);
      const body = await parseJson(response);
      const snapshot = parseObservabilityControlSnapshot(body);
      if (!snapshot) throw new Error("Observability control response is invalid");
      return snapshot;
    };

    const writeConfig = async (
      expectedRevision: number,
      nextConfig: Partial<ObservabilityConfig>,
    ): Promise<ObservabilityControlSnapshot> => {
      const response = await request("/observability/config", {
        method: "PUT",
        body: JSON.stringify({ expectedRevision, config: nextConfig }),
      }, controller.signal);
      const body = await parseJson(response);
      const snapshot = parseObservabilityControlSnapshot(body);
      if (!snapshot) throw new Error("Observability config response is invalid");
      return snapshot;
    };

    const pushDisabled = async () => {
      if (!isCurrent()) return;
      let retry = true;
      try {
        if (isElectronRuntime()) {
          await setDeveloperObservabilityConfig({ ...config, enabled: false });
          if (!isCurrent()) return;
        }
        const snapshot = await readControlSnapshot();
        if (!isCurrent()) return;
        await writeConfig(snapshot.configRevision, { enabled: false });
      } catch (error) {
        if (
          error instanceof ObservabilityRequestError
          && (error.status === 401 || error.status === 403)
        ) {
          retry = false;
        }
        // Disabling is a privacy boundary, not a one-shot hint. Keep retrying
        // while this provider remains off so a transient restart or network
        // failure cannot leave the server collecting behind an "off" UI.
        if (retry && isCurrent()) {
          disableRetryTimer = setTimeout(() => void pushDisabled(), 1_000);
        }
      }
    };

    if (!config.enabled) {
      setStatus("disabled");
      setStatusMessage(null);
      void pushDisabled();
      return () => {
        active = false;
        if (effectGenerationRef.current === effectGeneration) {
          effectGenerationRef.current += 1;
        }
        controller.abort();
        if (disableRetryTimer) clearTimeout(disableRetryTimer);
      };
    }

    setStatus("connecting");
    setStatusMessage(null);

    const postRendererEvents = async (batch: ObservabilityEventInput[]) => {
      if (!isCurrent() || activeCollectionEpoch === null) {
        throw new Error("Observability collection generation changed");
      }
      const activeConfig = configRef.current;
      const levelPriority = { debug: 10, info: 20, warn: 30, error: 40 } as const;
      const filtered = batch
        .filter((event) => activeConfig.scopes.includes(event.scope))
        .filter((event) => levelPriority[event.level] >= levelPriority[activeConfig.level])
        .map((event) => {
          if (!event.content || activeConfig.content === "full") return event;
          const content = { ...event.content };
          delete content.value;
          if (activeConfig.content === "metadata") delete content.hash;
          return { ...event, content };
        });
      if (filtered.length === 0) return;
      const response = await request("/observability/events", {
        method: "POST",
        body: JSON.stringify({
          collectionEpoch: activeCollectionEpoch,
          events: filtered,
        }),
      }, controller.signal);
      const body = await parseJson(response);
      if (body.accepted !== filtered.length) {
        throw new Error("Observability renderer batch crossed a collection boundary");
      }
    };

    const appendEvents = (incoming: unknown[]) => {
      if (!isCurrent()) return;
      const nextEvents = incoming
        .filter(isObservabilityEvent)
        .map((event) => applyDefensiveContentPolicy(event, config.content));
      if (nextEvents.length === 0) return;
      const fresh = nextEvents.filter((event) => event.sequence > afterSequenceRef.current);
      if (fresh.length === 0) return;
      afterSequenceRef.current = Math.max(
        afterSequenceRef.current,
        ...fresh.map((event) => event.sequence),
      );
      if (config.console) {
        for (const event of fresh) consoleEvent(event);
      }
      dispatchRetainedEvents({
        type: "append",
        events: fresh,
        maxEvents: config.maxEvents,
      });
    };

    const schedule = (task: () => Promise<void>) => {
      if (isCurrent()) pollTimer = setTimeout(() => void task(), 750);
    };

    async function poll() {
      if (!isCurrent()) return;
      const journalFence = journalFenceRef.current;
      try {
        const response = await request(
          `/observability/events?after=${afterSequenceRef.current}&limit=250`,
          {},
          controller.signal,
        );
        const body = await parseJson(response);
        if (!isCurrent()) return;
        if (journalFence !== journalFenceRef.current) {
          schedule(poll);
          return;
        }
        const control = parseObservabilityControlSnapshot(body);
        if (!control) throw new Error("Observability events response is invalid");
        if (
          activeCollectionEpoch !== null
          && control.collectionEpoch !== activeCollectionEpoch
        ) {
          // Another owner cleared the shared journal. Fence this producer and
          // restart against the new epoch instead of dropping every future
          // renderer batch under the old one.
          journalFenceRef.current += 1;
          effectGenerationRef.current += 1;
          configureRendererObservationBridge({ enabled: false });
          dispatchRetainedEvents({ type: "reset" });
          setServerDroppedCount(0);
          setRendererDroppedCount(0);
          resetRendererObservationBridgeDroppedCount();
          restartObservationEffect();
          return;
        }
        if (
          body.config
          && typeof body.config === "object"
          && (body.config as { enabled?: unknown }).enabled === false
        ) {
          schedule(activate);
          return;
        }
        if (
          typeof body.lastSequence === "number"
          && body.lastSequence < afterSequenceRef.current
        ) {
          afterSequenceRef.current = 0;
          dispatchRetainedEvents({ type: "reset" });
          schedule(poll);
          return;
        }
        appendEvents(Array.isArray(body.events) ? body.events : []);
        if (!isCurrent()) return;
        if (typeof body.droppedCount === "number") setServerDroppedCount(body.droppedCount);
        setStatus("connected");
        setStatusMessage(null);
        schedule(poll);
      } catch (error) {
        if (isCurrent()) {
          connectionRef.current = null;
          setStatus("error");
          setStatusMessage(error instanceof Error ? error.message : String(error));
          schedule(activate);
        }
      }
    }

    async function activate() {
      if (!isCurrent()) return;
      try {
        if (isElectronRuntime()) {
          await setDeveloperObservabilityConfig(config);
          if (!isCurrent()) return;
        }
        const current = await readControlSnapshot();
        if (!isCurrent()) return;
        const activated = await writeConfig(current.configRevision, config);
        if (!isCurrent()) return;
        activeCollectionEpoch = activated.collectionEpoch;
        configureRendererObservationBridge({
          enabled: true,
          transport: postRendererEvents,
          onDropped: setRendererDroppedCount,
          content: config.content,
          level: config.level,
          scopes: config.scopes,
        });
        void poll();
      } catch (error) {
        if (isCurrent()) {
          connectionRef.current = null;
          setStatus("error");
          setStatusMessage(error instanceof Error ? error.message : String(error));
          schedule(activate);
        }
      }
    }

    void activate();

    return () => {
      active = false;
      if (effectGenerationRef.current === effectGeneration) {
        effectGenerationRef.current += 1;
      }
      controller.abort();
      if (pollTimer) clearTimeout(pollTimer);
      if (disableRetryTimer) clearTimeout(disableRetryTimer);
      configureRendererObservationBridge({ enabled: false });
    };
  }, [activationVersion, config, request]);

  const value = useMemo<ObservabilityContextValue>(() => ({
    config,
    events,
    // The app mirrors the server journal's limits, so these eviction counts
    // describe the same lost retained events. Use the larger observed count
    // instead of double-counting them; bridge transport drops are independent.
    droppedCount:
      Math.max(serverDroppedCount, retainedEvents.evictedCount)
      + rendererDroppedCount,
    status,
    statusMessage,
    updateConfig,
    clear,
  }), [
    clear,
    config,
    events,
    retainedEvents.evictedCount,
    rendererDroppedCount,
    serverDroppedCount,
    status,
    statusMessage,
    updateConfig,
  ]);

  return <ObservabilityContext value={value}>{children}</ObservabilityContext>;
}

export function useObservability() {
  const value = use(ObservabilityContext);
  if (!value) throw new Error("useObservability must be used inside ObservabilityProvider");
  return value;
}
