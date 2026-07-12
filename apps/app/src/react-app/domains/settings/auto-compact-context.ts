export type AutoCompactContextConfig = {
  opencode?: {
    compaction?: unknown;
  };
};

export type AutoCompactContextClient = {
  getConfig: (workspaceId: string) => Promise<AutoCompactContextConfig>;
  patchConfig: (
    workspaceId: string,
    patch: { opencode: { compaction: { auto: boolean } } },
  ) => Promise<unknown>;
};

export type AutoCompactContextTarget = {
  client: AutoCompactContextClient;
  workspaceId: string;
};

export function readAutoCompactContextValue(config: AutoCompactContextConfig): boolean {
  const compaction = config.opencode?.compaction;
  if (!compaction || typeof compaction !== "object") return true;
  return Reflect.get(compaction, "auto") !== false;
}

export async function loadAutoCompactContext(target: AutoCompactContextTarget): Promise<boolean> {
  return readAutoCompactContextValue(await target.client.getConfig(target.workspaceId));
}

export async function saveAutoCompactContext(
  target: AutoCompactContextTarget,
  auto: boolean,
): Promise<void> {
  await target.client.patchConfig(target.workspaceId, {
    opencode: { compaction: { auto } },
  });
}
