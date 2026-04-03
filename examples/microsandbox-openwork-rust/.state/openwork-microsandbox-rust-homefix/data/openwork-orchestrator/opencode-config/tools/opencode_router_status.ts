import { tool } from "@opencode-ai/plugin"

const redactTarget = (value) => {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.length <= 6) return 'hidden'
  return `${text.slice(0, 2)}…${text.slice(-2)}`
}

const isNumericTelegramPeerId = (value) => /^-?\d+$/.test(String(value || '').trim())

export default tool({
  description: "Check opencodeRouter messaging readiness (health, identities, bindings).",
  args: {
    channel: tool.schema.enum(["telegram", "slack"]).optional().describe("Channel to inspect (default: telegram)"),
    identityId: tool.schema.string().optional().describe("Identity id to scope checks"),
    directory: tool.schema.string().optional().describe("Directory to inspect bindings for (default: current session directory)"),
    peerId: tool.schema.string().optional().describe("Peer id to inspect bindings for"),
    includeBindings: tool.schema.boolean().optional().describe("Include binding details (default: false)"),
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
    const identityId = String(args.identityId || "").trim()
    const directory = (args.directory || context.directory || "").trim()
    const peerId = String(args.peerId || "").trim()
    const targetValid = channel !== 'telegram' || !peerId || isNumericTelegramPeerId(peerId)
    const includeBindings = args.includeBindings === true

    const fetchJson = async (path) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      const body = await response.text()
      let json = null
      try {
        json = JSON.parse(body)
      } catch {
        json = null
      }
      if (!response.ok) {
        return { ok: false, status: response.status, json, error: typeof json?.error === "string" ? json.error : body }
      }
      return { ok: true, status: response.status, json }
    }

    const health = await fetchJson('/health')
    const identities = await fetchJson(`/identities/${channel}`)
    let bindings = null
    if (includeBindings) {
      const search = new URLSearchParams()
      search.set('channel', channel)
      if (identityId) search.set('identityId', identityId)
      bindings = await fetchJson(`/bindings?${search.toString()}`)
    }

    const identityItems = Array.isArray(identities?.json?.items) ? identities.json.items : []
    const scopedIdentityItems = identityId
      ? identityItems.filter((item) => String(item?.id || '').trim() === identityId)
      : identityItems
    const runningItems = scopedIdentityItems.filter((item) => item && item.enabled === true && item.running === true)
    const enabledItems = scopedIdentityItems.filter((item) => item && item.enabled === true)

    const bindingItems = Array.isArray(bindings?.json?.items) ? bindings.json.items : []
    const filteredBindings = bindingItems.filter((item) => {
      if (!item || typeof item !== 'object') return false
      if (directory && String(item.directory || '').trim() !== directory) return false
      if (peerId && String(item.peerId || '').trim() !== peerId) return false
      return true
    })
    const publicBindings = filteredBindings.map((item) => ({
      channel: String(item.channel || channel),
      identityId: String(item.identityId || ''),
      directory: String(item.directory || ''),
      ...(item?.peerId ? { target: redactTarget(item.peerId) } : {}),
      updatedAt: item?.updatedAt,
    }))

    let ready = false
    let guidance = ''
    let nextAction = ''
    if (!health.ok) {
      guidance = 'OpenCode Router health endpoint is unavailable'
      nextAction = 'check_router_health'
    } else if (!identities.ok) {
      guidance = `Identity lookup failed for ${channel}`
      nextAction = 'check_identity_config'
    } else if (runningItems.length === 0) {
      guidance = `No running ${channel} identity`
      nextAction = 'start_identity'
    } else if (!targetValid) {
      guidance = 'Telegram direct targets must be numeric chat IDs. Prefer linked conversations over asking users for raw IDs.'
      nextAction = 'use_linked_conversation'
    } else if (peerId) {
      ready = true
      guidance = 'Ready for direct send'
      nextAction = 'send_direct'
    } else if (directory) {
      ready = filteredBindings.length > 0
      guidance = ready
        ? 'Ready for directory fan-out send'
        : channel === 'telegram'
          ? 'No linked Telegram conversations yet. Ask the recipient to message your bot (for example /start), then retry.'
          : 'No linked conversations found for this directory yet'
      nextAction = ready ? 'send_directory' : channel === 'telegram' ? 'wait_for_recipient_start' : 'link_conversation'
    } else {
      ready = true
      guidance = 'Ready. Provide a message target (peer or directory).'
      nextAction = 'choose_target'
    }

    const result = {
      ok: health.ok && identities.ok && (!bindings || bindings.ok),
      ready,
      guidance,
      nextAction,
      channel,
      ...(identityId ? { identityId } : {}),
      ...(directory ? { directory } : {}),
      ...(peerId ? { targetProvided: true } : {}),
      ...(peerId ? { targetValid } : {}),
      health: {
        ok: health.ok,
        status: health.status,
        error: health.ok ? undefined : health.error,
        snapshot: health.ok ? health.json : undefined,
      },
      identities: {
        ok: identities.ok,
        status: identities.status,
        error: identities.ok ? undefined : identities.error,
        configured: scopedIdentityItems.length,
        enabled: enabledItems.length,
        running: runningItems.length,
        items: scopedIdentityItems,
      },
      ...(includeBindings
        ? {
            bindings: {
              ok: Boolean(bindings?.ok),
              status: bindings?.status,
              error: bindings?.ok ? undefined : bindings?.error,
              count: filteredBindings.length,
              items: publicBindings,
            },
          }
        : {}),
    }
    return JSON.stringify(result, null, 2)
  },
})

