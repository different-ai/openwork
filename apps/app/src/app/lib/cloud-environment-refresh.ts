/**
 * Asks the desktop to fetch organization environment variables again, e.g.
 * right after the person saved their own value from a chat prompt. The
 * provider auth store, which holds the server client, listens and runs the
 * server's sync; the server starts an engine with the new value.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function requestCloudEnvironmentRefresh(): void {
  for (const listener of listeners) listener();
}

export function onCloudEnvironmentRefreshRequested(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
