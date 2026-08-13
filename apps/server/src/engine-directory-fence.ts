import type { ServerConfig, WorkspaceInfo } from "./types.js";

type Queue = Map<string, Promise<void>>;

const queuesByConfig = new WeakMap<ServerConfig, Queue>();

function directoryKey(workspace: WorkspaceInfo): string {
  const directory = workspace.directory?.trim() || workspace.path.trim();
  return process.platform === "win32"
    ? directory.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "").toLowerCase()
    : directory;
}

/**
 * Serialize target-directory instance disposal with prompt admission routed
 * through OpenWork. Different directories intentionally use different queues.
 */
export async function withEngineDirectoryFence<T>(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  operation: () => Promise<T>,
): Promise<T> {
  let queue = queuesByConfig.get(config);
  if (!queue) {
    queue = new Map();
    queuesByConfig.set(config, queue);
  }

  const key = directoryKey(workspace);
  const previous = queue.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.set(key, current);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (queue.get(key) === current) queue.delete(key);
  }
}
