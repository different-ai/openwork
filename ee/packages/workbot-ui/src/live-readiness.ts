/** A brief best-effort wait for the page's existing stream, never a dependency of sending a message. */
export function createLiveReadiness() {
  const ready = new Map<string | null, Set<symbol>>();
  const waiting = new Map<string | null, Set<() => void>>();
  return {
    subscribe(chat: string | null) {
      const token = Symbol();
      const disconnect = () => {
        const streams = ready.get(chat);
        streams?.delete(token);
        if (!streams?.size) ready.delete(chat);
      };
      return {
        ready() {
          const streams = ready.get(chat) ?? new Set<symbol>();
          streams.add(token);
          ready.set(chat, streams);
          for (const resolve of [...waiting.get(chat) ?? []]) resolve();
        },
        disconnect,
      };
    },
    wait(chat: string | null, maxWaitMs = 200): Promise<void> {
      if (ready.get(chat)?.size) return Promise.resolve();
      return new Promise(resolve => {
        const listeners = waiting.get(chat) ?? new Set<() => void>();
        const finish = () => {
          clearTimeout(timer);
          listeners.delete(finish);
          if (!listeners.size) waiting.delete(chat);
          resolve();
        };
        const timer = setTimeout(finish, maxWaitMs);
        listeners.add(finish);
        waiting.set(chat, listeners);
      });
    },
  };
}

export const workbotLiveReadiness = createLiveReadiness();
