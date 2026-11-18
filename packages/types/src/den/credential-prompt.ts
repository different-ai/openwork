import { z } from "zod"

/**
 * A Den tool result that asks the person, not the agent, for one credential.
 *
 * It carries only what the host needs to show a private field: which saved
 * resource the key belongs to and where that resource sends it. There is no
 * field for the value; the host sends the value straight to Den and the agent
 * only learns that the key was saved.
 */
export const CREDENTIAL_PROMPT_KIND = "credential_prompt" as const

const id = z.string().trim().min(1).max(160)

export const credentialPromptTargetSchema = z.discriminatedUnion("type", [
  /** A shared API key for one organization MCP connection. */
  z.object({ type: z.literal("mcp_connection_key"), connectionId: id }).strict(),
  /** The signed-in person's own API key for a connection where each person uses their own key. */
  z.object({ type: z.literal("mcp_connection_member_key"), connectionId: id }).strict(),
  /**
   * One shared organization key that replaces each person's own key. Saving
   * the key is what changes the connection, and only while it is unchanged
   * since `expectedUpdatedAt`; `audience` is who will share it, for display.
   */
  z.object({
    type: z.literal("mcp_connection_shared_switch"),
    connectionId: id,
    expectedUpdatedAt: z.string().datetime(),
    audience: z.object({
      orgWide: z.boolean(),
      memberCount: z.number().int().min(0).max(100_000),
      teamCount: z.number().int().min(0).max(100_000),
    }).strict(),
  }).strict(),
  /** The shared API key of a plugin's declared MCP server, saved through the plugin's own setup. */
  z.object({ type: z.literal("plugin_connection_key"), pluginId: id, configObjectId: id, serverName: z.string().trim().min(1).max(255), connectionId: id }).strict(),
  /** The shared API key of one AI Gateway provider's organization credential set. */
  z.object({ type: z.literal("gateway_provider_key"), inferenceProviderId: id, credentialSetId: id }).strict(),
  /**
   * Several values for one AI Gateway provider's organization credential set:
   * AWS keys (Bedrock), a Google service-account key (Vertex), or one key per
   * named variable. The host draws the fields for the kind; Den checks the shape.
   */
  z.object({
    type: z.literal("gateway_provider_credential"),
    inferenceProviderId: id,
    credentialSetId: id,
    credentialKind: z.enum(["aws_keys", "gcp_service_account", "api_key_map"]),
    envNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)).min(1).max(6).optional(),
  }).strict().refine((target) => (target.credentialKind === "api_key_map") === (target.envNames !== undefined), "envNames is required for api_key_map only"),
])

export const credentialPromptSchema = z.object({
  schemaVersion: z.literal("1"),
  kind: z.literal(CREDENTIAL_PROMPT_KIND),
  target: credentialPromptTargetSchema,
  /** The saved resource's name, such as the connection or provider name. */
  name: z.string().trim().min(1).max(255),
  /** Where the key will be sent: origin and path only, never credentials or query. */
  destination: z.string().trim().max(2048).nullable(),
}).strict()

export type CredentialPrompt = z.infer<typeof credentialPromptSchema>
export type CredentialPromptTarget = z.infer<typeof credentialPromptTargetSchema>

/** Origin and path of an http(s) URL; null for anything that cannot be shown safely. */
export function credentialPromptDestination(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) return null
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`
  } catch {
    return null
  }
}

/**
 * What the agent reads next to the prompt. Fixed text: resource names are
 * chosen by whoever created the resource, so they are display data for the
 * person only and never part of the agent's instruction. The dashboard URL is
 * built by Den from validated IDs.
 */
export function credentialPromptInstruction(manageUrl: string | null): string {
  const where = manageUrl ? ` Other clients: ask the person to add it at ${manageUrl}.` : ""
  return `A private field for this API key is shown to the person in OpenWork. Never ask them to paste the key in chat or into a tool argument. End your turn; OpenWork continues the task once the key is saved.${where}`
}
