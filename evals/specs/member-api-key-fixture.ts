import { z } from "zod";

export const connectionResponse = z.object({
  id: z.string(), name: z.string(), updatedAt: z.string(),
  apiKeyAuthScheme: z.enum(["bearer", "token"]).optional(),
  connectedForMe: z.boolean().optional(), needsReconnect: z.boolean().optional(),
  credentialHealth: z.string().optional(),
}).passthrough();
export const inventoryResponse = z.object({ connections: z.array(connectionResponse) });
export const tokenResponse = z.object({ token: z.string() });
export const organizationResponse = z.object({ organization: z.object({ id: z.string() }),
  members: z.array(z.object({ id: z.string(), user: z.object({ id: z.string(), email: z.string() }) })) });
export const newOrganizationResponse = z.object({ organization: z.object({ id: z.string() }) });
export const apiKeyResponse = z.object({ key: z.string() });
export const teamResponse = z.object({ team: z.object({ id: z.string() }) });

export function requireOwnedDen() {
  if (process.env.OPENWORK_EVAL_DEN_API_URL || process.env.OPENWORK_EVAL_DEN_WEB_URL || process.env.OPENWORK_EVAL_DEN_REUSE || process.env.OPENWORK_EVAL_DEN_RUNTIME_PREPARED || process.env.OPENWORK_EVAL_DEN_API_PREPARED) {
    throw new Error("Member key tests require an independently owned Den; remove attached server overrides");
  }
}
