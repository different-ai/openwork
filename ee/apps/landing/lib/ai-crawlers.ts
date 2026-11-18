export type AiCrawler = {
  name: string
  operator: string
  /** index: builds a model's picture of the web ahead of time; live: fetches because a user asked. */
  kind: "index" | "live" | "search"
}

const CRAWLERS: ReadonlyArray<AiCrawler & { pattern: RegExp }> = [
  { name: "GPTBot", operator: "OpenAI", kind: "index", pattern: /GPTBot/i },
  { name: "OAI-SearchBot", operator: "OpenAI", kind: "search", pattern: /OAI-SearchBot/i },
  { name: "ChatGPT-User", operator: "OpenAI", kind: "live", pattern: /ChatGPT-User/i },
  { name: "ClaudeBot", operator: "Anthropic", kind: "index", pattern: /ClaudeBot/i },
  { name: "Claude-SearchBot", operator: "Anthropic", kind: "search", pattern: /Claude-SearchBot/i },
  { name: "Claude-User", operator: "Anthropic", kind: "live", pattern: /Claude-User/i },
  { name: "anthropic-ai", operator: "Anthropic", kind: "index", pattern: /anthropic-ai/i },
  { name: "PerplexityBot", operator: "Perplexity", kind: "search", pattern: /PerplexityBot/i },
  { name: "Perplexity-User", operator: "Perplexity", kind: "live", pattern: /Perplexity-User/i },
  { name: "Google-Extended", operator: "Google", kind: "index", pattern: /Google-Extended/i },
  { name: "GoogleOther", operator: "Google", kind: "index", pattern: /GoogleOther/i },
  { name: "Gemini-Deep-Research", operator: "Google", kind: "live", pattern: /Gemini-Deep-Research/i },
  { name: "Applebot-Extended", operator: "Apple", kind: "index", pattern: /Applebot-Extended/i },
  { name: "meta-externalagent", operator: "Meta", kind: "index", pattern: /meta-externalagent/i },
  { name: "meta-externalfetcher", operator: "Meta", kind: "live", pattern: /meta-externalfetcher/i },
  { name: "Bytespider", operator: "ByteDance", kind: "index", pattern: /Bytespider/i },
  { name: "Amazonbot", operator: "Amazon", kind: "index", pattern: /Amazonbot/i },
  { name: "DuckAssistBot", operator: "DuckDuckGo", kind: "live", pattern: /DuckAssistBot/i },
  { name: "MistralAI-User", operator: "Mistral", kind: "live", pattern: /MistralAI-User/i },
  { name: "CCBot", operator: "Common Crawl", kind: "index", pattern: /CCBot/i },
  { name: "cohere-ai", operator: "Cohere", kind: "index", pattern: /cohere-ai/i },
]

export function detectAiCrawler(userAgent: string): AiCrawler | null {
  if (!userAgent) return null
  for (const crawler of CRAWLERS) {
    if (crawler.pattern.test(userAgent)) {
      return { name: crawler.name, operator: crawler.operator, kind: crawler.kind }
    }
  }
  return null
}
