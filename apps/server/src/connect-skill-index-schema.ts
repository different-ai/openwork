import { z } from "zod";

import type {
  OpenWorkAgentSkillDiscoverySchemaUri,
  OpenWorkAgentSkillIndex,
  OpenWorkAgentSkillIndexEntry,
  OpenWorkAgentSkillIndexUri,
} from "@openwork/types/den/agent-skill-index";

// Keep runtime validation local: Electron imports the compiled server with
// Node, while the shared types workspace intentionally exports TypeScript
// source for app and Den builds. The parity test guards this local copy.
export const OPENWORK_AGENT_SKILL_INDEX_URI: OpenWorkAgentSkillIndexUri =
  "skill://index.json";
export const OPENWORK_AGENT_SKILL_DISCOVERY_SCHEMA_URI:
  OpenWorkAgentSkillDiscoverySchemaUri =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

const openworkAgentSkillCapabilityRuntimeSchema = z.string()
  .regex(/^(?:skill:[^:\s]+|plugin:[^:\s]+:[^:\s]+)$/)
  .max(256);

export const openworkAgentSkillIndexEntryRuntimeSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  type: z.literal("skill-md"),
  description: z.string().max(1_024),
  url: z.string().startsWith("skill://").max(2_048),
  capability: openworkAgentSkillCapabilityRuntimeSchema,
}).passthrough() satisfies z.ZodType<OpenWorkAgentSkillIndexEntry>;

export const openworkAgentSkillIndexEnvelopeRuntimeSchema = z.object({
  $schema: z.literal(OPENWORK_AGENT_SKILL_DISCOVERY_SCHEMA_URI),
  skills: z.array(z.unknown()),
}).passthrough();

export const openworkAgentSkillIndexRuntimeSchema = z.object({
  $schema: z.literal(OPENWORK_AGENT_SKILL_DISCOVERY_SCHEMA_URI),
  skills: z.array(openworkAgentSkillIndexEntryRuntimeSchema),
}).passthrough() satisfies z.ZodType<OpenWorkAgentSkillIndex>;

export type OpenWorkAgentSkillSchemaIssue = {
  code: string;
  path: string;
};

const SAFE_SCHEMA_PATH_SEGMENT = /^[A-Za-z0-9_$-]{1,64}$/;

function safeSchemaPathSegment(segment: PropertyKey): string {
  if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
    return String(segment);
  }
  if (typeof segment === "string" && SAFE_SCHEMA_PATH_SEGMENT.test(segment)) {
    return segment;
  }
  return "unknown";
}

/** Return schema-owned issue metadata without copying dynamic values/messages. */
export function firstOpenWorkAgentSkillSchemaIssue(
  error: z.ZodError,
  prefix: readonly PropertyKey[] = [],
): OpenWorkAgentSkillSchemaIssue {
  const issue = error.issues[0];
  const path = [...prefix, ...(issue?.path ?? [])]
    .map(safeSchemaPathSegment)
    .join(".");
  return {
    code: issue?.code ?? "unknown",
    path: path || "$",
  };
}
