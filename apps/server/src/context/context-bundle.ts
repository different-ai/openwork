import {
  getConnectSnapshot,
  inspectConnectSnapshot,
  resolveConnectWorkspace,
  type ConnectSnapshot,
  type ConnectSnapshotOptions,
} from "../connect-state.js";
import {
  readOpenWorkConnectSkillCatalog,
  renderOpenWorkConnectSkillInstruction,
} from "../connect-skill-catalog.js";
import type { ServerConfig } from "../types.js";

export type OpenWorkContextBundle = {
  ok: true;
  schemaVersion: 1;
  steering: ConnectSnapshot | null;
  skills: {
    instruction: string;
    count: number;
  };
  diagnostics: string[];
  generatedAt: number;
};

export type OpenWorkContextBundleOptions = ConnectSnapshotOptions & {
  now?: () => number;
  steeringMode?: "active" | "passive" | "omit";
  /** @deprecated Prefer steeringMode. Retained for direct route compatibility. */
  includeSteering?: boolean;
};

async function passiveConnectSnapshot(
  config: ServerConfig,
  options: OpenWorkContextBundleOptions,
): Promise<ConnectSnapshot> {
  const inspected = await inspectConnectSnapshot(config);
  const resolved = resolveConnectWorkspace(config, options);
  const workspace: ConnectSnapshot["workspace"] = "workspace" in resolved
    ? {
        resolution: "resolved",
        id: resolved.workspace.id,
        directory: resolved.directory,
        reason: "Passive prompt snapshot; OpenCode health was not probed",
      }
    : {
        resolution: resolved.resolution,
        id: null,
        directory: resolved.directory,
        reason: resolved.reason,
      };
  return { ...inspected.snapshot, workspace };
}

/**
 * Assemble the per-turn context inputs from the same primitives used by the
 * existing Connect state and skill routes. The bundle itself is deliberately
 * uncached; the catalog reader retains its established 30-second cache.
 */
export async function buildOpenWorkContextBundle(
  config: ServerConfig,
  options: OpenWorkContextBundleOptions = {},
): Promise<OpenWorkContextBundle> {
  const diagnostics: string[] = [];
  const diag = (message: string) => diagnostics.push(message);
  const steeringMode = options.steeringMode
    ?? (options.includeSteering === false ? "omit" : "active");
  const steering = steeringMode === "omit"
    ? null
    : steeringMode === "passive"
      ? await passiveConnectSnapshot(config, options)
      : await getConnectSnapshot(config, options);
  if (!steering) {
    diag("steering omitted by caller");
  } else {
    if (steeringMode === "passive") {
      diag("steering assembled passively: no OpenCode health probe or remote MCP request was made for steering");
    }
    if (steering.workspace.resolution === "resolved") {
      diag("steering workspace resolved (id and directory available in the authenticated steering snapshot)");
    } else {
      diag(`steering workspace not resolved (resolution=${steering.workspace.resolution}) — continuing with the server-scoped skill catalog`);
    }
  }

  const skills = await readOpenWorkConnectSkillCatalog(config, undefined, diag);
  const instruction = renderOpenWorkConnectSkillInstruction(skills, diag);
  diag(`response: ${skills.length} skills, instruction ${instruction.length} chars`);

  return {
    ok: true,
    schemaVersion: 1,
    steering,
    skills: {
      instruction,
      count: skills.length,
    },
    diagnostics,
    generatedAt: options.now?.() ?? Date.now(),
  };
}
