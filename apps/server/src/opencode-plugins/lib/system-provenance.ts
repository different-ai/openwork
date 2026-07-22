export type SystemPromptSource =
  | "openwork.runtime-config.agent.openwork.prompt"
  | "openwork.extensions-preview.connect-steering"
  | "openwork.extensions-preview.connect-skills"
  | "openwork.extensions-preview.session-creation"
  | "openwork.extensions-preview.session-memory"
  | "openwork.extensions-preview.browser-guidance"
  | "openwork.extensions-preview.ui-control-guidance"
  | "openwork.capabilities-knowledge"
  | "opencode-core-composed-header"
  | "opencode-core-or-runtime-plugin";

type TrackedBlock = {
  index: number;
  source: SystemPromptSource;
  value: string;
};

type ProvenanceStore = {
  blocksBySystem: WeakMap<string[], TrackedBlock[]>;
};

const STORE_SYMBOL = Symbol.for("openwork.opencode.system-prompt-provenance.v1");

function provenanceStore(): ProvenanceStore {
  const root = globalThis as typeof globalThis & { [STORE_SYMBOL]?: ProvenanceStore };
  root[STORE_SYMBOL] ??= { blocksBySystem: new WeakMap<string[], TrackedBlock[]>() };
  return root[STORE_SYMBOL];
}

/**
 * Append a system block without modifying its bytes while recording the
 * OpenWork component that contributed it. Symbol.for + globalThis lets the
 * independently bundled OpenCode plugins share the same WeakMap at runtime.
 */
export function pushSystemBlock(system: string[], value: string, source: SystemPromptSource): number {
  const nextLength = system.push(value);
  const tracked = provenanceStore().blocksBySystem.get(system) ?? [];
  tracked.push({ index: nextLength - 1, source, value });
  provenanceStore().blocksBySystem.set(system, tracked);
  return nextLength;
}

/**
 * Resolve provenance against the final array. Index matches are preferred;
 * value matching keeps attribution stable if a later runtime plugin inserts
 * or reorders blocks. Identical reordered duplicates are inherently
 * indistinguishable and retain their contribution order.
 */
export function systemBlockSources(
  system: string[],
  limit = system.length,
): SystemPromptSource[] {
  const tracked = provenanceStore().blocksBySystem.get(system) ?? [];
  const used = new Set<number>();
  return system.slice(0, Math.max(0, Math.trunc(limit))).map((value, index) => {
    const sameIndex = tracked.findIndex((entry, candidateIndex) => (
      !used.has(candidateIndex) && entry.index === index && entry.value === value
    ));
    if (sameIndex >= 0) {
      used.add(sameIndex);
      return tracked[sameIndex]!.source;
    }
    const matchedIndex = tracked.findIndex((entry, candidateIndex) => (
      !used.has(candidateIndex)
      && entry.value === value
      // Do not steal a duplicate contribution from the exact index where it
      // still exists merely because an untracked core block has equal bytes.
      && (entry.index === index || system[entry.index] !== entry.value)
    ));
    if (matchedIndex >= 0) {
      used.add(matchedIndex);
      return tracked[matchedIndex]!.source;
    }
    return "opencode-core-or-runtime-plugin";
  });
}
