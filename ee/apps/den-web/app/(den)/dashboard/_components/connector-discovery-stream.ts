import { z } from "zod";
import type { McpRequirementsDiscovery } from "./mcp-connections-data";

export const discoveryCheckSchema = z.object({
  id: z.enum(["server", "resource", "provider"]),
  status: z.enum(["running", "passed", "failed", "skipped"]),
  httpStatus: z.number().int().min(100).max(599).optional(),
  code: z.enum(["authentication_required", "not_required", "issuer_mismatch", "unavailable", "unsupported"]).optional(),
}).strict();
export type DiscoveryCheck = z.infer<typeof discoveryCheckSchema>;

/** Validate streamed results before the form uses their authentication defaults. */
const resultSchema: z.ZodType<McpRequirementsDiscovery> = z.object({
  status: z.enum(["ready", "manual_action_required", "unsupported", "unreachable"]),
  publishedSignInAddresses: z.array(z.object({ authorizationEndpoint: z.string(), tokenEndpoint: z.string(), advertisedIssuer: z.string(), metadataIssuer: z.string() })).optional(),
  server: z.object({ url: z.string(), protocolVersion: z.string().optional(), initialize: z.enum(["succeeded", "authentication_required", "failed"]) }),
  authentication: z.object({
    kind: z.enum(["none", "oauth", "manual_bearer", "unknown"]),
    resource: z.string().optional(),
    protectedResourceMetadataUrl: z.string().optional(),
    authorizationServers: z.array(z.object({
      issuer: z.string(), authorizationEndpoint: z.string().optional(), tokenEndpoint: z.string().optional(), registrationEndpoint: z.string().optional(),
      clientIdMetadataDocumentSupported: z.boolean(), scopesSupported: z.array(z.string()).optional(), grantTypesSupported: z.array(z.string()).optional(),
      codeChallengeMethodsSupported: z.array(z.string()).optional(), tokenEndpointAuthMethodsSupported: z.array(z.string()).optional(),
    })),
    requiredScopes: z.array(z.string()), resourceScopesSupported: z.array(z.string()).optional(), recommendedScopes: z.array(z.string()),
    refreshSupport: z.enum(["supported", "not_advertised", "unknown"]),
    availableRegistrationMethods: z.array(z.enum(["pre_registered", "client_metadata", "dynamic"])),
    recommendedRegistrationMethod: z.enum(["client_metadata", "dynamic", "pre_registered"]),
  }),
  tools: z.object({
    visibility: z.enum(["available_without_auth", "requires_auth", "unavailable"]), count: z.number().int().nonnegative().optional(),
    items: z.array(z.object({ name: z.string(), readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional(), openWorldHint: z.boolean().optional() })).optional(),
  }),
  manualRequirements: z.array(z.object({ code: z.string(), label: z.string(), reason: z.string(), required: z.boolean() })),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});

export const DISCOVERY_STREAM_ERROR = "The server check could not finish. Try again.";
const MAX_EVENT_CHARS = 1024 * 1024;

/** Actual server events only: no timers or inferred intermediate successes. */
export async function readDiscoveryStream(
  body: ReadableStream<Uint8Array>,
  onCheck: (check: DiscoveryCheck) => void,
  signal?: AbortSignal,
): Promise<McpRequirementsDiscovery> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      // Normalize complete CRLFs, including when \r and \n arrive in different chunks.
      buffer = buffer.replace(/\r\n/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (event.length > MAX_EVENT_CHARS) throw new Error(DISCOVERY_STREAM_ERROR);
        const lines = event.split("\n");
        const name = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (name === "error") throw new Error(DISCOVERY_STREAM_ERROR);
        if (name === "check" || name === "result") {
          let value: unknown;
          try { value = JSON.parse(data); } catch { throw new Error(DISCOVERY_STREAM_ERROR); }
          if (name === "result") {
            const parsed = resultSchema.safeParse(value);
            if (!parsed.success) throw new Error(DISCOVERY_STREAM_ERROR);
            return parsed.data;
          }
          const parsed = discoveryCheckSchema.safeParse(value);
          if (!parsed.success) throw new Error(DISCOVERY_STREAM_ERROR);
          onCheck(parsed.data);
        }
        end = buffer.indexOf("\n\n");
      }
      if (buffer.length > MAX_EVENT_CHARS) throw new Error(DISCOVERY_STREAM_ERROR);
      if (part.done) throw new Error(DISCOVERY_STREAM_ERROR);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
