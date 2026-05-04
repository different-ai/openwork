import { tool } from "@opencode-ai/plugin"

const redactTarget = (value) => {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.length <= 6) return 'hidden'
  return `${text.slice(0, 2)}…${text.slice(-2)}`
}

const buildGuidance = (result) => {
  const sent = Number(result?.sent || 0)
  const attempted = Number(result?.attempted || 0)
  const reason = String(result?.reason || '')
  const failures = Array.isArray(result?.failures) ? result.failures : []

  if (sent > 0 && failures.length === 0) return 'Delivered successfully.'
  if (sent > 0) return 'Delivered to at least one conversation, but some targets failed.'

  const chatNotFound = failures.some((item) => /chat not found/i.test(String(item?.error || '')))
  if (chatNotFound) {
    return 'Delivery failed because the recipient has not started a chat with the bot yet. Ask them to send /start, then retry.'
  }

  if (/No bound conversations/i.test(reason)) {
    return 'No linked conversation found for this workspace yet. Ask the recipient to message the bot first, then retry.'
  }

  if (attempted === 0) return 'No eligible delivery target found.'
  return 'Delivery failed. Retry after confirming the recipient and bot linkage.'
}

export default tool({
  description: "Send a message via opencodeRouter (Telegram/Slack) to a peer or directory bindings.",
  args: {
    text: tool.schema.string().describe("Message text to send"),
    channel: tool.schema.enum(["telegram", "slack"]).optional().describe("Channel to send on (default: telegram)"),
    identityId: tool.schema.string().optional().describe("OpenCodeRouter identity id (default: all identities)"),
    directory: tool.schema.string().optional().describe("Directory to target for fan-out (default: current session directory)"),
    peerId: tool.schema.string().optional().describe("Direct destination peer id (chat/thread id)"),
    autoBind: tool.schema.boolean().optional().describe("When direct sending, bind peerId to directory if provided"),
  },
  async execute(args, context) {
    const rawPort = (process.env.OPENCODE_ROUTER_HEALTH_PORT || "3005").trim()
    const port = Number(rawPort)
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`Invalid OPENCODE_ROUTER_HEALTH_PORT: ${rawPort}`)
    }
    const channel = (args.channel || "telegram").trim()
    if (channel !== "telegram" && channel !== "slack") {
      throw new Error("channel must be telegram or slack")
    }
    const text = String(args.text || "")
    if (!text.trim()) throw new Error("text is required")
    const directory = (args.directory || context.directory || "").trim()
    const peerId = String(args.peerId || "").trim()
    if (!directory && !peerId) throw new Error("Either directory or peerId is required")
    const payload = {
      channel,
      text,
      ...(args.identityId ? { identityId: String(args.identityId) } : {}),
      ...(directory ? { directory } : {}),
      ...(peerId ? { peerId } : {}),
      ...(args.autoBind === true ? { autoBind: true } : {}),
    }
    const response = await fetch(`http://127.0.0.1:${port}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const body = await response.text()
    let json = null
    try {
      json = JSON.parse(body)
    } catch {
      json = null
    }
    if (!response.ok) {
      throw new Error(`opencodeRouter /send failed (${response.status}): ${body}`)
    }

    const sent = Number(json?.sent || 0)
    const attempted = Number(json?.attempted || 0)
    const reason = typeof json?.reason === 'string' ? json.reason : ''
    const failuresRaw = Array.isArray(json?.failures) ? json.failures : []
    const failures = failuresRaw.map((item) => ({
      identityId: String(item?.identityId || ''),
      error: String(item?.error || 'delivery failed'),
      ...(item?.peerId ? { target: redactTarget(item.peerId) } : {}),
    }))

    const result = {
      ok: true,
      channel,
      sent,
      attempted,
      guidance: buildGuidance({ sent, attempted, reason, failures }),
      ...(reason ? { reason } : {}),
      ...(failures.length ? { failures } : {}),
    }
    return JSON.stringify(result, null, 2)
  },
})

