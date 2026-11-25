import type { Client } from "../types";

export type InspectorSliceGetter = () => unknown;

type InspectorAPI = {
  version: number;
  readonly opencode: Client | null;
  snapshot(): Record<string, unknown>;
  slice(name: string): unknown;
  listSlices(): string[];
  events(limit?: number): Array<{ at: number; name: string; data: unknown }>;
  record(name: string, data?: unknown): void;
  clearEvents(): void;
};

declare global {
  // eslint-disable-next-line no-var
  var __openwork: InspectorAPI | undefined;
}

const INSPECTOR_VERSION = 1;
const EVENT_BUFFER_MAX = 200;

type Registry = {
  slices: Map<string, InspectorSliceGetter>;
  events: Array<{ at: number; name: string; data: unknown }>;
  opencodeClient: Client | null;
  installed: boolean;
};

const registry: Registry = {
  slices: new Map(),
  events: [],
  opencodeClient: null,
  installed: false,
};

function safeCall(getter: InspectorSliceGetter): unknown {
  try {
    return getter();
  } catch (error) {
    return {
      __inspectorError:
        error instanceof Error ? error.message : String(error),
    };
  }
}

function buildSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const [name, getter] of registry.slices) {
    snapshot[name] = safeCall(getter);
  }
  snapshot.__events = registry.events.slice(-20);
  return snapshot;
}

function installIfNeeded() {
  if (registry.installed) return;
  if (typeof window === "undefined") return;

  const api: InspectorAPI = {
    version: INSPECTOR_VERSION,
    get opencode() {
      return registry.opencodeClient;
    },
    snapshot: buildSnapshot,
    slice(name) {
      const getter = registry.slices.get(name);
      return getter ? safeCall(getter) : undefined;
    },
    listSlices() {
      return Array.from(registry.slices.keys()).sort();
    },
    events(limit) {
      const requested = typeof limit === "number" && limit > 0 ? limit : 50;
      return registry.events.slice(-requested);
    },
    record(name, data) {
      registry.events.push({ at: Date.now(), name, data: data ?? null });
      if (registry.events.length > EVENT_BUFFER_MAX) {
        registry.events.splice(0, registry.events.length - EVENT_BUFFER_MAX);
      }
    },
    clearEvents() {
      registry.events = [];
    },
  };

  Object.defineProperty(window, "__openwork", {
    value: api,
    configurable: true,
    writable: false,
  });

  registry.installed = true;
}

export function publishInspectorSlice(
  name: string,
  getter: InspectorSliceGetter,
): () => void {
  installIfNeeded();
  registry.slices.set(name, getter);
  return () => {
    const current = registry.slices.get(name);
    if (current === getter) registry.slices.delete(name);
  };
}

export function publishInspectorOpencodeClient(client: Client): () => void {
  installIfNeeded();
  registry.opencodeClient = client;
  return () => {
    if (registry.opencodeClient === client) registry.opencodeClient = null;
  };
}

export function recordInspectorEvent(name: string, data?: unknown) {
  installIfNeeded();
  window.__openwork?.record(name, data);
}

export function ensureInspectorInstalled() {
  installIfNeeded();
}
