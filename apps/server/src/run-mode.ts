/**
 * Engine run mode: how much autonomy agents get before a human approval
 * prompt interrupts them.
 *
 * The mode is engine-global (one choice for every workspace on this server)
 * because the injected engine config file is rendered from the ENGINE_GLOBAL
 * runtime row only. It compiles onto the engine's own `permission` config —
 * OpenWork never adjudicates a tool call itself.
 */

export type EngineRunMode = "approve" | "run-everything";

export const DEFAULT_ENGINE_RUN_MODE: EngineRunMode = "approve";

export function normalizeEngineRunMode(value: unknown): EngineRunMode | undefined {
  return value === "approve" || value === "run-everything" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compile the "run everything" run mode into an engine `permission` object.
 *
 * The engine evaluates the concatenation of its defaults, the user's global
 * config, this injected file, and the workspace's own config, and the last
 * matching rule wins. The catch-all allow therefore upgrades `ask` rules that
 * precede it (engine defaults and the user's global config) while the
 * protections users still expect are restated after it so they stay
 * interactive:
 *
 * - writes outside the workspace and authorized folders still ask:
 *   `external_directory` keeps its ask default ahead of the stored folder
 *   rules so explicit grants and denies remain authoritative;
 * - repeated identical tool calls still ask (`doom_loop`);
 * - `.env` reads keep the engine's own default (`ask`), which the catch-all
 *   would otherwise override.
 *
 * Known limit of this shape: a `deny` written in the user's global config
 * without a leading `"*"` entry precedes the catch-all and is overridden by
 * it. Rules in a workspace's own `opencode.json` are merged after this file
 * and are never affected.
 */
export function compileRunEverythingPermission(
  existingPermission: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const existing = isRecord(existingPermission) ? existingPermission : {};
  const externalDirectory = isRecord(existing.external_directory) ? existing.external_directory : {};
  return {
    ...existing,
    "*": "allow",
    read: {
      "*": "allow",
      "*.env": "ask",
      "*.env.*": "ask",
      "*.env.example": "allow",
    },
    external_directory: {
      "*": "ask",
      ...externalDirectory,
    },
    doom_loop: "ask",
  };
}
