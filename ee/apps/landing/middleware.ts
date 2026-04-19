import { NextResponse, type NextRequest } from "next/server"
import { agentMarkdown } from "./lib/agent-markdown"

export const config = {
  matcher: ["/", "/pricing", "/enterprise", "/den", "/download", "/trust"],
}

export function middleware(request: NextRequest) {
  const accept = request.headers.get("accept") ?? ""
  const pathname = request.nextUrl.pathname
  const body = agentMarkdown[pathname]

  if (!body || !prefersMarkdown(accept)) {
    const passthrough = NextResponse.next()
    passthrough.headers.set("Vary", "Accept")
    return passthrough
  }

  const tokens = estimateTokens(body)
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      Vary: "Accept",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "Access-Control-Allow-Origin": "*",
      "X-Markdown-Tokens": String(tokens),
    },
  })
}

function prefersMarkdown(accept: string): boolean {
  const offers = parseAccept(accept)
  if (offers.length === 0) return false
  const markdown = bestMatch(offers, ["text/markdown", "text/x-markdown"])
  if (!markdown) return false
  const html = bestMatch(offers, ["text/html", "application/xhtml+xml"])
  if (!html) return true
  return markdown.q > html.q
}

type Offer = { type: string; q: number }

function parseAccept(accept: string): Offer[] {
  return accept
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [type, ...params] = part.split(";").map((p) => p.trim())
      let q = 1
      for (const param of params) {
        const [k, v] = param.split("=").map((s) => s.trim())
        if (k === "q" && v) {
          const parsed = Number(v)
          if (Number.isFinite(parsed)) q = parsed
        }
      }
      return { type: type.toLowerCase(), q }
    })
}

function bestMatch(offers: Offer[], candidates: string[]): Offer | undefined {
  let best: Offer | undefined
  for (const offer of offers) {
    const matches =
      candidates.includes(offer.type) ||
      offer.type === "*/*" ||
      (offer.type.endsWith("/*") && candidates.some((c) => c.startsWith(offer.type.slice(0, -1))))
    if (!matches) continue
    if (!best || offer.q > best.q) best = offer
  }
  return best
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
