import { z } from "zod"
import type { MicrosoftGraphPageTokens } from "./microsoft-graph.js"
import { openToken, sealToken } from "./signed-links.js"

const domain = "microsoft-graph-list-page"
const schema = z.object({ e: z.number().int(), list: z.string(), url: z.string() })

export const microsoftGraphPageTokens: MicrosoftGraphPageTokens = {
  seal: (page) => sealToken(domain, { ...page, e: Math.floor(Date.now() / 1000) + 3600 }),
  open: (token) => /^[A-Za-z0-9_-]+$/.test(token) ? openToken(domain, token, schema) : null,
}
