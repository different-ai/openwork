import { readFeatures } from "@openwork-ee/den-db/organization-features"

export async function bedrockGuardrailsEnabled(organizationId: string): Promise<boolean> {
  const [{ db }, { env }] = await Promise.all([import("./db.js"), import("./env.js")])
  return (await readFeatures(db.$primary, organizationId, env.features)).bedrockGuardrails
}
