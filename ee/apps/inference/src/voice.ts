import { createHash } from "node:crypto"
import { eq, sql } from "@micx-ee/den-db/drizzle"
import type { Hono } from "hono"
import {
  InferenceOrgUsageBucketTable,
  InferenceUsageLedgerBucketChargeTable,
  InferenceUsageLedgerEntryTable,
} from "@micx-ee/den-db"
import { createDenTypeId, normalizeDenTypeId } from "@micx-ee/utils/typeid"
import type { DenTypeId } from "@micx-ee/utils/typeid"
import { env } from "./env.js"
import { findActiveInferenceKey } from "./keys.js"
import { ensureUsableBuckets } from "./limits.js"
import { db } from "./db.js"

const MICX_VOICE_REALTIME_MODEL = "gpt-realtime-2"
const MICX_VOICE_TRANSCRIPTION_MODEL = "gpt-4o-transcribe"

const MICX_VOICE_REALTIME_TOOLS = [
  {
    type: "function",
    name: "micx_snapshot",
    description: "Read the current Micx UI control snapshot: route, status, narration, and visible action metadata.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "micx_list_actions",
    description: "List semantic Micx UI actions. Call this before micx_execute_action when you do not know the exact action id.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "micx_execute_action",
    description: "Execute a semantic Micx UI action by id. Prefer this over screen coordinates or DOM guessing.",
    parameters: {
      type: "object",
      properties: {
        actionId: { type: "string", description: "The action id from micx_list_actions, such as composer.set_text or composer.send." },
        args: { type: "object", description: "Optional JSON arguments for the action.", additionalProperties: true },
      },
      required: ["actionId"],
      additionalProperties: false,
    },
  },
]

function readApiKey(request: Request) {
  const auth = request.headers.get("authorization")
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim()
  }
  return request.headers.get("x-api-key")?.trim() ?? null
}

function buildRequestId() {
  return createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 32)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readStringField(value: unknown, key: string) {
  if (!isRecord(value)) return ""
  const field = value[key]
  return typeof field === "string" ? field.trim() : ""
}

function readOpenAiClientSecret(payload: unknown): { clientSecret: string; expiresAt: number | null } {
  if (!isRecord(payload)) return { clientSecret: "", expiresAt: null }
  const clientSecret = payload.client_secret
  if (typeof clientSecret === "string") return { clientSecret, expiresAt: null }
  if (isRecord(clientSecret)) {
    const value = typeof clientSecret.value === "string" ? clientSecret.value : ""
    const expiresAt = typeof clientSecret.expires_at === "number" ? clientSecret.expires_at : null
    return { clientSecret: value, expiresAt }
  }
  const value = typeof payload.value === "string" ? payload.value : ""
  return { clientSecret: value, expiresAt: null }
}

function secondsUntil(date: Date) {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000))
}

function formatResetMessage(windowEndAt: Date): string {
  const seconds = secondsUntil(windowEndAt)
  if (seconds < 3600) {
    return `It resets in ${Math.ceil(seconds / 60)} minutes.`
  }
  return `It resets in ${Math.ceil(seconds / 3600)} hours.`
}

function micxVoiceRealtimeInstructions() {
  return `# Role and Objective

You are Micx Voice Mode, a voice-first control layer inside Micx.
Help the user control Micx by using the semantic Micx UI tools.

# Tool Policy

- Prefer micx_snapshot, micx_list_actions, and micx_execute_action over visual guessing.
- If the user asks to write or draft something, use composer.set_text.
- If the user asks to send or run the current prompt, use composer.send.
- For navigation, settings, session, transcript, and composer work, inspect the action list first if the action id is unknown.
- Do not claim an action completed until the tool succeeds.
- Ask for confirmation before destructive actions such as deleting a session.

# Voice Style

- Be concise, calm, and direct.
- If audio is unclear, ask the user to repeat it instead of guessing.
- Ignore background speech that is not addressed to Micx.
- Summarize tool results briefly and offer the next useful step.`
}

async function createOpenAiRealtimeClientSecret(input: unknown, micxRequestId: string) {
  if (!env.openAiRealtimeApiKey) {
    return Response.json({ error: { message: "Managed voice is not configured.", type: "invalid_request_error", code: "openai_realtime_key_missing" } }, { status: 503 })
  }

  const model = readStringField(input, "model") || MICX_VOICE_REALTIME_MODEL
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openAiRealtimeApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        output_modalities: ["audio"],
        audio: {
          input: {
            transcription: { model: MICX_VOICE_TRANSCRIPTION_MODEL, language: "en" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.58,
              silence_duration_ms: 320,
              prefix_padding_ms: 300,
              create_response: true,
              interrupt_response: true,
            },
          },
        },
        instructions: micxVoiceRealtimeInstructions(),
        tool_choice: "auto",
        tools: MICX_VOICE_REALTIME_TOOLS,
      },
    }),
  })

  const text = await response.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    const errorPayload = isRecord(payload) && isRecord(payload.error) ? payload.error : null
    const message = typeof errorPayload?.message === "string" ? errorPayload.message : response.statusText
    return Response.json({ error: { message: message || "Failed to create OpenAI Realtime session", type: "api_error", code: "openai_realtime_failed" } }, { status: response.status })
  }

  const { clientSecret, expiresAt } = readOpenAiClientSecret(payload)
  if (!clientSecret) {
    return Response.json({ error: { message: "OpenAI did not return a usable Realtime client secret.", type: "api_error", code: "openai_realtime_invalid_response" } }, { status: 502 })
  }

  return Response.json({
    ok: true,
    clientSecret,
    expiresAt,
    model,
    transcriptionModel: MICX_VOICE_TRANSCRIPTION_MODEL,
    tools: MICX_VOICE_REALTIME_TOOLS.map((tool) => tool.name),
    source: "micx-models",
    micxRequestId,
  })
}

async function chargeVoiceSession(input: {
  inferenceKey: { id: DenTypeId<"inferenceKey">; organization_id: DenTypeId<"organization">; org_membership_id: DenTypeId<"member"> }
  micxRequestId: string
  limits: Awaited<ReturnType<typeof ensureUsableBuckets>>
}) {
  const costAmount = env.voiceSessionCostUnits
  const entryId = createDenTypeId("inferenceUsageLedgerEntry")

  await db.transaction(async (tx) => {
    await tx.insert(InferenceUsageLedgerEntryTable).values({
      id: entryId,
      organization_id: input.inferenceKey.organization_id,
      org_membership_id: input.inferenceKey.org_membership_id,
      inference_key_id: input.inferenceKey.id,
      external_job_id: input.micxRequestId,
      external_event_id: null,
      cost_amount: costAmount,
      event_type: "voice_realtime_session",
      occurred_at: new Date(),
    })

    const bucketLimits = input.limits.bucketLimits as Record<string, number | undefined>
    for (const [windowType, bucketId] of Object.entries(input.limits.bucketIds)) {
      if (!bucketId) continue
      const limitAmount = bucketLimits[windowType]
      if (limitAmount === undefined) continue

      await tx.insert(InferenceUsageLedgerBucketChargeTable).values({
        id: createDenTypeId("inferenceUsageLedgerBucketCharge"),
        ledger_entry_id: entryId,
        bucket_id: bucketId,
        amount: costAmount,
      })
      await tx.update(InferenceOrgUsageBucketTable).set({
        limit_amount: limitAmount,
        used_amount: sql`${InferenceOrgUsageBucketTable.used_amount} + ${costAmount}`,
      }).where(eq(InferenceOrgUsageBucketTable.id, bucketId))
    }
  })
}

export function registerVoiceRoutes(app: Hono) {
  app.post("/voice/realtime/session", async (c) => {
    const rawKey = readApiKey(c.req.raw)
    if (!rawKey) {
      return c.json({ error: { message: "Missing Micx inference API key.", type: "authentication_error", code: "missing_api_key" } }, 401)
    }

    const inferenceKey = await findActiveInferenceKey(rawKey)
    if (!inferenceKey) {
      return c.json({ error: { message: "Invalid Micx inference API key.", type: "authentication_error", code: "invalid_api_key" } }, 401)
    }

    const limits = await ensureUsableBuckets(inferenceKey.organization_id)
    if (!limits.ok) {
      const limitedBucket = "limitedBucket" in limits ? limits.limitedBucket : null
      const resetMessage = limitedBucket ? ` ${formatResetMessage(limitedBucket.windowEndAt)}` : ""
      const retryAfter = limitedBucket ? secondsUntil(limitedBucket.windowEndAt) : undefined
      c.header("x-micx-limit-window-type", limits.windowType)
      if (retryAfter !== undefined) {
        c.header("retry-after", String(retryAfter))
        c.header("x-ratelimit-remaining-tokens", "0")
        if (limitedBucket) {
          c.header("x-ratelimit-limit-tokens", String(limitedBucket.limitAmount))
          c.header("x-ratelimit-reset-tokens", `${retryAfter}s`)
        }
      }
      return c.json({
        error: {
          message: `Your organization has reached its Voice Mode usage limit.${resetMessage}`,
          type: "tokens",
          code: "rate_limit_exceeded",
        },
      }, 429)
    }

    const micxRequestId = buildRequestId()
    let body: unknown = {}
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }

    const response = await createOpenAiRealtimeClientSecret(body, micxRequestId)

    if (response.status === 200) {
      try {
        await chargeVoiceSession({ inferenceKey, micxRequestId, limits })
      } catch (error) {
        console.error("[voice] failed to charge voice session", { micxRequestId, error: error instanceof Error ? error.message : String(error) })
      }
    }

    return response
  })
}
