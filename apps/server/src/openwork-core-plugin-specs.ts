import {
  openworkContextPluginPath,
  openworkPromptLogPluginPath,
} from "./openwork-extensions-plugin-path.js";
import { normalizePluginSpec } from "./plugin-spec.js";

/**
 * OpenWork-owned plugins injected into every managed OpenCode runtime.
 *
 * The prompt logger is the final managed-config entry for readability. Its
 * post-system-hooks snapshot does not rely on being the final effective
 * plugin; it retains OpenCode's live system-array reference until chat.params.
 */
export function openworkCorePluginSpecs(): string[] {
  return [
    "opencode-chrome-devtools",
    openworkContextPluginPath(),
    openworkPromptLogPluginPath(),
  ];
}

export function isOpenworkCorePluginSpec(spec: string): boolean {
  const normalized = normalizePluginSpec(spec);
  return openworkCorePluginSpecs().some(
    (coreSpec) => normalizePluginSpec(coreSpec) === normalized,
  );
}

export function buildOpenworkPluginSpecs(runtimeSpecs: string[]): string[] {
  const coreSpecs = openworkCorePluginSpecs();
  const seen = new Set(coreSpecs.map(normalizePluginSpec));
  const safeRuntimeSpecs: string[] = [];
  // Pinned OpenCode v1.17.11 resolves duplicate config identities last-wins.
  // Walk backwards, then restore order, while reserving OpenWork core IDs.
  for (const spec of [...runtimeSpecs].reverse()) {
    const normalized = normalizePluginSpec(spec);
    // Core plugins are injected by OpenWork. Ignore stale runtime rows that
    // predate that ownership boundary and preserve OpenCode's last-wins rule
    // for duplicate runtime identities.
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    safeRuntimeSpecs.push(spec);
  }
  safeRuntimeSpecs.reverse();
  return [
    ...coreSpecs.slice(0, -1),
    ...safeRuntimeSpecs,
    ...coreSpecs.slice(-1),
  ];
}
