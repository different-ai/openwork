import { env } from "../env.js"

export type CloudCodingAppConfig = {
  appId: string
  slug: string
  clientId: string
  clientSecret: string
  privateKey: string
  webhookSecret: string | null
  apiBaseUrl: string
  webBaseUrl: string
}

export function cloudCodingAppConfig(): CloudCodingAppConfig | null {
  const { appId, slug, clientId, clientSecret, privateKey, webhookSecret, apiBaseUrl, webBaseUrl } = env.githubCloudCodingApp
  if (!appId || !slug || !clientId || !clientSecret || !privateKey) return null
  return { appId, slug, clientId, clientSecret, privateKey: privateKey.replace(/\\n/g, "\n"), webhookSecret: webhookSecret ?? null, apiBaseUrl, webBaseUrl }
}
