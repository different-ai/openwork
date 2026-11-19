// State of one saved model shortcut in Settings. Same reasons as the notice
// the person sees after pressing the key, so the two never disagree.

export type ShortcutRowState =
  | { kind: "pending" }
  | { kind: "available" }
  | { kind: "blocked" }
  | { kind: "provider_disconnected"; providerName: string | null }
  | { kind: "model_missing"; providerName: string | null };

export type ShortcutRowCatalog = {
  /** Every provider the workspace knows about. */
  all: ReadonlyArray<{ id: string; name: string }>;
  /** Connected providers (see getConnectedProviderItems) and their models. */
  connected: ReadonlyArray<{ id: string; models: Readonly<Record<string, unknown>> }>;
};

export function shortcutRowState(input: {
  providerID: string;
  modelID: string;
  providerName?: string | null;
  blocked: boolean;
  catalog: ShortcutRowCatalog | null;
}): ShortcutRowState {
  if (input.blocked) return { kind: "blocked" };
  if (!input.catalog) return { kind: "pending" };
  const provider = input.catalog.all.find((entry) => entry.id === input.providerID);
  const providerName = provider?.name ?? input.providerName ?? null;
  const connected = input.catalog.connected.find((entry) => entry.id === input.providerID);
  if (!connected) return { kind: "provider_disconnected", providerName };
  if (!Object.hasOwn(connected.models, input.modelID)) return { kind: "model_missing", providerName };
  return { kind: "available" };
}
