import type {
  DesktopDeepLinkEvent,
  DesktopUpdateStatusEvent,
  ReloadRequiredEvent,
  SandboxCreateProgressEvent,
} from "../../../../app/src/app/lib/openwork-desktop";
import { IPC_EVENT_CHANNELS } from "../ipc/channels";

export type DesktopEventMap = {
  deepLinkOpen: DesktopDeepLinkEvent;
  updateStatus: DesktopUpdateStatusEvent;
  sandboxCreateProgress: SandboxCreateProgressEvent;
  reloadRequired: ReloadRequiredEvent;
};

export type DesktopEventName = keyof DesktopEventMap;

export type DesktopEventEnvelope<T extends DesktopEventName = DesktopEventName> = {
  name: T;
  channel: (typeof IPC_EVENT_CHANNELS)[T];
  payload: DesktopEventMap[T];
};

export type DesktopEventListener<T extends DesktopEventName> = (payload: DesktopEventMap[T]) => void;
export type DesktopEventRendererSink = (event: DesktopEventEnvelope) => void;
export type DesktopEventUnsubscribe = () => void;

type ListenerRegistry = {
  [K in DesktopEventName]: Map<number, DesktopEventListener<K>>;
};

function createListenerRegistry(): ListenerRegistry {
  return {
    deepLinkOpen: new Map(),
    updateStatus: new Map(),
    sandboxCreateProgress: new Map(),
    reloadRequired: new Map(),
  };
}

export function createDesktopEventBus() {
  const listeners = createListenerRegistry();
  const rendererSinks = new Map<number, DesktopEventRendererSink>();
  let nextId = 1;

  const subscribe = <T extends DesktopEventName>(
    name: T,
    listener: DesktopEventListener<T>,
  ): DesktopEventUnsubscribe => {
    const id = nextId++;
    listeners[name].set(id, listener as DesktopEventListener<typeof name>);
    return () => {
      listeners[name].delete(id);
    };
  };

  const registerRendererSink = (sink: DesktopEventRendererSink): DesktopEventUnsubscribe => {
    const id = nextId++;
    rendererSinks.set(id, sink);
    return () => {
      rendererSinks.delete(id);
    };
  };

  const emit = <T extends DesktopEventName>(name: T, payload: DesktopEventMap[T]) => {
    const envelope: DesktopEventEnvelope<T> = {
      name,
      channel: IPC_EVENT_CHANNELS[name],
      payload,
    };

    for (const listener of listeners[name].values()) {
      listener(payload);
    }

    for (const sink of rendererSinks.values()) {
      sink(envelope);
    }

    return envelope;
  };

  const listenerCount = (name?: DesktopEventName) => {
    if (name) {
      return listeners[name].size;
    }

    return Object.values(listeners).reduce((total, entry) => total + entry.size, 0);
  };

  return {
    emit,
    subscribe,
    registerRendererSink,
    listenerCount,
    getChannel<T extends DesktopEventName>(name: T) {
      return IPC_EVENT_CHANNELS[name];
    },
  };
}
