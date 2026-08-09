import {
  createDefaultScenario,
  createEnterpriseMcpMockServer,
  providerProfileIdSchema,
  scenarioSchema,
} from "./index.js"

const profileId = providerProfileIdSchema.parse(process.env.PROFILE_ID)
const port = Number(process.env.PORT ?? "3979")
const redirectUris = (process.env.OAUTH_REDIRECT_URIS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
const baseScenario = createDefaultScenario(profileId)
const scenario = redirectUris.length > 0
  ? scenarioSchema.parse({
      ...baseScenario,
      oauth: { ...baseScenario.oauth, redirectUris },
    })
  : baseScenario
const server = createEnterpriseMcpMockServer({
  scenario,
  secrets: { oauthClientSecret: process.env.OAUTH_CLIENT_SECRET ?? "" },
  port,
})

await server.start()
console.log(`[enterprise-mcp-mock] ${profileId} listening at ${server.mcpUrl}`)

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await server.stop()
  process.exit(0)
}

process.once("SIGINT", () => {
  void stop()
})
process.once("SIGTERM", () => {
  void stop()
})
