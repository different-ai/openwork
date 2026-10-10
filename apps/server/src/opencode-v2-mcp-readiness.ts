export const MCP_READINESS_RPC_ID = "openwork.mcp-readiness";
export type McpPublishedTool = { readonly id: string; readonly options?: { readonly namespace?: string } };
type Registration = { dispose(): Promise<void> };
export type McpReadinessRegistry = {
  list(): Promise<readonly McpPublishedTool[]>;
  transform(observe: () => void): Promise<Registration>;
};

export const mcpNamespace = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, "_");
export const mcpToolId = (server: string, name: string) => `${mcpNamespace(server)}_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

export function mcpBindingsReady(current: readonly McpPublishedTool[], server: string, desired: readonly string[], previous: readonly string[]): boolean {
  const published = new Set(current.filter(tool => tool.options?.namespace === mcpNamespace(server)).map(tool => tool.id));
  const wanted = new Set(desired);
  return desired.every(id => published.has(id)) && previous.every(id => wanted.has(id) || !published.has(id));
}

/** SDK-independent observation; the native adapter supplies its owned registry. */
export async function waitForMcpBindings(
  registry: McpReadinessRegistry, server: string, desired: readonly string[], previous: readonly string[], signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const current = await registry.list();
  signal.throwIfAborted();
  if (mcpBindingsReady(current, server, desired, previous)) return;
  let closed = false;
  let queued = false;
  let registration: Registration | undefined;
  let resolve = () => {};
  let reject: (error: unknown) => void = () => {};
  const ready = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  void ready.catch(() => {});
  const fail = (error: unknown) => {
    if (closed) return;
    closed = true;
    reject(error);
  };
  const abort = () => fail(signal.reason ?? new Error("MCP readiness canceled"));
  const observe = () => {
    if (closed || queued) return;
    queued = true;
    // Read after the complete synchronous replay, never recursively inside it.
    queueMicrotask(() => {
      queued = false;
      if (closed) return;
      void registry.list().then(current => {
        if (closed || !mcpBindingsReady(current, server, desired, previous)) return;
        closed = true;
        resolve();
      }, fail);
    });
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    registration = await registry.transform(observe);
    await ready;
  } finally {
    closed = true;
    signal.removeEventListener("abort", abort);
    await registration?.dispose();
  }
}
