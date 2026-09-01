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
 * Every tool call the engine would otherwise ask about is auto-allowed, with
 * the protections users still expect kept interactive:
 *
 * - writes outside the workspace and authorized folders still ask:
 *   `external_directory` keeps its ask default ahead of the stored folder
 *   rules (the engine picks the last matching rule, so explicit entries win);
 * - repeated identical tool calls still ask (`doom_loop`);
 * - the engine's default `.env` read denials are restated explicitly so the
 *   top-level allow cannot override them.
 *
 * Stored deny entries are preserved verbatim: the preset only upgrades
 * would-be prompts, mirroring the engine's own `--auto` semantics.
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
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow",
    },
    external_directory: {
      "*": "ask",
      ...externalDirectory,
    },
    doom_loop: "ask",
  };
}
