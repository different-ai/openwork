import { describe, expect, test } from "bun:test";
import { detectAiCrawler } from "../lib/ai-crawlers";

describe("detectAiCrawler", () => {
  test("recognizes index, search and live AI agents", () => {
    expect(detectAiCrawler("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)")?.name).toBe("GPTBot");
    expect(detectAiCrawler("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)")?.kind).toBe("index");
    expect(detectAiCrawler("Mozilla/5.0 (compatible; Claude-User/1.0)")?.kind).toBe("live");
    expect(detectAiCrawler("Mozilla/5.0 (compatible; PerplexityBot/1.0)")?.operator).toBe("Perplexity");
    expect(detectAiCrawler("ChatGPT-User/1.0")?.kind).toBe("live");
  });

  test("ignores browsers and classic search crawlers", () => {
    expect(detectAiCrawler("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15")).toBeNull();
    expect(detectAiCrawler("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBeNull();
    expect(detectAiCrawler("")).toBeNull();
  });
});
