import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server"
import { detectAiCrawler } from "./lib/ai-crawlers"
import { POSTHOG_PROJECT_KEY } from "./lib/posthog-client"
import { agentMarkdown } from "./lib/agent-markdown"

export const config = {
  matcher: [
    "/",
    "/connect",
    "/cloud",
    "/pricing",
    "/enterprise",
    "/download",
    "/trust",
    "/glm-5.2",
    "/alternatives/claude-cowork",
    "/alternatives/claude-cowork-3p",
    "/llms.txt",
    "/start.md",
    "/auth.md",
    "/docs/:path*",
    "/.well-known/:path*",
  ],
}

export function middleware(request: NextRequest, event?: NextFetchEvent) {
  const accept = request.headers.get("accept") ?? ""
  const pathname = request.nextUrl.pathname
  const body = agentMarkdown[pathname]
  const markdownRequested = prefersMarkdown(accept)

  // Stage 1 of the AEO funnel: record which AI crawlers and live assistants fetch
  // which pages. Browsers run the client SDK; bots don't, so count them here.
  const crawler = detectAiCrawler(request.headers.get("user-agent") ?? "")
  if (crawler && event && process.env.VERCEL_ENV === "production") {
    event.waitUntil(captureCrawlerHit(crawler, pathname, markdownRequested))
  }

  if (!body || !markdownRequested) {
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

async function captureCrawlerHit(
  crawler: { name: string; operator: string; kind: string },
  pathname: string,
  markdown: boolean,
): Promise<void> {
  try {
    await fetch("https://us.i.posthog.com/i/v0/e/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_PROJECT_KEY,
        event: "ai_crawler_hit",
        distinct_id: `ai-crawler:${crawler.name}`,
        properties: {
          crawler: crawler.name,
          crawler_operator: crawler.operator,
          crawler_kind: crawler.kind,
          path: pathname,
          markdown_requested: markdown,
          $current_url: `https://openworklabs.com${pathname}`,
          $process_person_profile: false,
        },
      }),
    })
  } catch {
    // Analytics must never affect the response.
  }
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
