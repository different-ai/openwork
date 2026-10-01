import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server"
import {
  BROWSER_KEYS,
  CLOUD_BROWSER_INSTRUCTION,
  CLOUD_BROWSER_TOOL_DESCRIPTIONS,
  LIMITS,
  handoffGuidance,
  isCloudBrowserError,
  nextStepFor,
  type BrowserKey,
  type CloudBrowser,
} from "@openwork-ee/cloud-browser"
import { z } from "zod"

/**
 * Cloud browser tools on `/mcp/agent`, for headless runs only (Slack replies,
 * cloud Automations, Workbot). Desktop, Claude, Cursor and other MCP clients
 * never see them: the desktop has its own local browser tools, and a hand-off
 * only makes sense where the person has the Den Web live view.
 *
 * Names and arguments follow the desktop tool contract
 * (apps/server/src/opencode-plugins/openwork-chrome-devtools.ts).
 */
export const CLOUD_BROWSER_TOOL_NAMES = ["browser_open", "browser_observe", "browser_act", "browser_navigate", "browser_handoff"] as const

export function cloudBrowserToolsAvailable(input: {
  /** The caller presented a headless-run MCP token (see headless-run-token.ts). */
  headlessRun: boolean
  /** The organization has the `cloudBrowser` capability. */
  capabilityEnabled: boolean
  /** The deployment configured a cloud browser. */
  configured: boolean
  memberId: string | null | undefined
}): boolean {
  return input.headlessRun && input.capabilityEnabled && input.configured && Boolean(input.memberId)
}

/** The agent server's instructions, plus the cloud browser rules when its tools are registered. */
export function withCloudBrowserInstructions(instructions: string, enabled: boolean): string {
  return enabled ? `${instructions}\n${CLOUD_BROWSER_INSTRUCTION}` : instructions
}

const OPEN_WORLD: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }

const tabId = z.string().min(1).max(64).optional().describe("A tabId from an earlier browser result. Defaults to the active tab.")
const address = z.string().url().max(4_096).describe("A complete http or https address.")
const ref = z.string().regex(/^e\d{1,4}$/).describe("An element ref from the latest observation, such as e12.")
const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    ref: ref.optional(),
    x: z.number().optional().describe("Viewport CSS pixels from the observation image, when there is no ref."),
    y: z.number().optional().describe("Viewport CSS pixels from the observation image, when there is no ref."),
  }),
  z.object({ type: z.literal("fill"), ref, text: z.string().max(LIMITS.fillChars) }),
  z.object({ type: z.literal("key"), key: z.enum(BROWSER_KEYS) }),
  z.object({
    type: z.literal("scroll"),
    deltaY: z.number().min(-LIMITS.scrollDelta).max(LIMITS.scrollDelta).describe("Positive scrolls down, negative up."),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
])

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function failure(error: unknown, onError: ((error: unknown) => void) | undefined): CallToolResult {
  if (isCloudBrowserError(error)) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({ ok: false, code: error.code, message: error.message, next: nextStepFor(error), dispatched: error.dispatched, retrySafe: false }),
      }],
    }
  }
  onError?.(error)
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({ ok: false, code: "browser_operation_failed", message: "The browser operation could not finish. Observe the page before deciding what remains.", next: "observe", retrySafe: false }),
    }],
  }
}

function siteOf(url: string | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : null
  } catch {
    return null
  }
}

/** "github.com" or "https://github.com/login" to an address to open; a plain name ("Gusto") opens nothing. */
export function siteAddress(site: string | undefined): string | null {
  if (!site) return null
  const candidate = /^https?:\/\//i.test(site) ? site : `https://${site}`
  try {
    const url = new URL(candidate)
    return url.hostname.includes(".") && !/\s/.test(site) ? url.toString() : null
  } catch {
    return null
  }
}

export function registerCloudBrowserTools(input: {
  server: McpServer
  browser: CloudBrowser
  key: BrowserKey
  /** The person's live view in Den Web. */
  browserUrl: (site: string | null) => string
  onError?: (error: unknown) => void
}) {
  const { server, browser, key, onError } = input
  const run = async (operation: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await operation()
    } catch (error) {
      return failure(error, onError)
    }
  }

  server.registerTool("browser_open", {
    title: "Open website",
    description: CLOUD_BROWSER_TOOL_DESCRIPTIONS.browser_open,
    annotations: OPEN_WORLD,
    inputSchema: z.object({ url: address }),
  }, async ({ url }) => run(async () => json(await browser.open(key, { url }))))

  server.registerTool("browser_observe", {
    title: "Read page",
    description: CLOUD_BROWSER_TOOL_DESCRIPTIONS.browser_observe,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      tabId,
      includeImage: z.boolean().optional().describe("Attach a screenshot (default true). Use false when text and controls are enough."),
    }),
  }, async (args) => run(async () => {
    const { image, ...observation } = await browser.observe(key, args)
    return {
      content: [
        { type: "text", text: JSON.stringify(observation) },
        ...(image ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }] : []),
      ],
    }
  }))

  server.registerTool("browser_act", {
    title: "Act on page",
    description: CLOUD_BROWSER_TOOL_DESCRIPTIONS.browser_act,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({ tabId, observationId: z.string().min(1).max(64), action: actionSchema }),
  }, async (args) => run(async () => json(await browser.act(key, args))))

  server.registerTool("browser_navigate", {
    title: "Go to address",
    description: CLOUD_BROWSER_TOOL_DESCRIPTIONS.browser_navigate,
    annotations: OPEN_WORLD,
    inputSchema: z.object({ tabId, url: address }),
  }, async (args) => run(async () => json(await browser.navigate(key, args))))

  server.registerTool("browser_handoff", {
    title: "Hand off to the person",
    description: CLOUD_BROWSER_TOOL_DESCRIPTIONS.browser_handoff,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: z.object({
      reason: z.enum(["sign_in", "captcha", "confirm"]),
      site: z.string().trim().min(1).max(253).optional().describe("The site's name or host, for the person. Defaults to the open page's host."),
    }),
  }, async ({ reason, site }) => run(async () => {
    let status = await browser.status(key).catch(() => null)
    // The person needs the page in front of them: open the named site when nothing is open yet.
    const address = !status?.running || !status.url ? siteAddress(site) : null
    if (address) {
      await browser.open(key, { url: address })
      status = await browser.status(key).catch(() => null)
    }
    const current = site ?? siteOf(status?.url ?? null)
    return json(handoffGuidance({ reason, site: current, browserUrl: input.browserUrl(current) }))
  }))
}
