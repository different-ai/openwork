import { env } from "./env.js"

export function memberSignInLink(connection: { id: string; organizationId: string; name: string }) {
  const signIn = new URL("/connect/mcp", env.betterAuthUrl)
  signIn.searchParams.set("connectionId", connection.id)
  signIn.searchParams.set("org", connection.organizationId)
  signIn.searchParams.set("name", connection.name)
  return signIn.toString()
}

export function invitationBillingUrl() {
  return new URL("/dashboard/billing", env.betterAuthUrl).toString()
}

export function connectionRemovalLink(connectionId: string) {
  const link = new URL(`/dashboard/mcp-connections/${encodeURIComponent(connectionId)}`, env.betterAuthUrl)
  link.searchParams.set("remove", "1")
  return link.toString()
}

export function myAgentLink() {
  return new URL("/dashboard/my-bot", env.betterAuthUrl).toString()
}

export function libraryConnectorLink(connectionId: string) {
  return new URL(`/dashboard/library/connectors/${encodeURIComponent(connectionId)}`, env.betterAuthUrl).toString()
}

export function libraryCatalogLink() {
  return new URL("/dashboard/library/connectors/new", env.betterAuthUrl).toString()
}

export function libraryWorkflowLink(configObjectId: string) {
  return new URL(`/dashboard/library/workflows/${encodeURIComponent(configObjectId)}`, env.betterAuthUrl).toString()
}

export function automationsLink() {
  return new URL("/dashboard/automations", env.betterAuthUrl).toString()
}

export function yourConnectionsLink() {
  return new URL("/dashboard/your-connections", env.betterAuthUrl).toString()
}
