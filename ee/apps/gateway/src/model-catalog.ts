import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference"

const OPENWORK_PROVIDER_ID = "openwork"

// Audio is a pinned service capability, not a selectable chat model.
export const VOICE_TRANSCRIPTION_MODEL = "openai/gpt-4o-mini-transcribe"
export const VOICE_SPEECH_MODEL = "openai/gpt-4o-mini-tts-2025-12-15"
// Budget estimates, NOT provider-enforced maximum costs (pricing checked 2026-09-08).
// STT: 3 MiB at an assumed 24 kbps is ~17.5 min; $0.003/min * 2 rounds to $0.11.
// TTS: 600 chars at an assumed 10 chars/s and 50 audio tokens/s, at $12/M,
// plus 2400 text tokens at $0.60/M, doubled and rounded up gives $0.08.
// Lower bitrates, slower speech, tokenization and price changes can exceed these.
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
export function voiceReservationAmount(model: string) {
  if (model === VOICE_TRANSCRIPTION_MODEL) return 11_000_000
  if (model === VOICE_SPEECH_MODEL) return 8_000_000
  throw new Error("Unsupported voice model")
}
export function isVoiceModel(model: string) {
  return model === VOICE_TRANSCRIPTION_MODEL || model === VOICE_SPEECH_MODEL
}

export type ModelCatalogEntry = {
  alias: string
  upstreamModel: string
  displayName: string
  enabled: boolean
  usageFactor: number
}

const models: ModelCatalogEntry[] = Object.entries(INFERENCE_MODEL_ALIASES).map(([alias, model]) => ({
  alias,
  upstreamModel: model.upstreamModel,
  displayName: model.displayName,
  enabled: model.enabled,
  usageFactor: model.usageFactor,
}))

const enabledModels = models.filter((model) => model.enabled)

export function resolveModelAlias(alias: string) {
  const normalizedAlias = alias.startsWith(`${OPENWORK_PROVIDER_ID}/`)
    ? alias.slice(OPENWORK_PROVIDER_ID.length + 1)
    : alias
  return enabledModels.find((model) => model.alias === normalizedAlias) ?? null
}

export function resolveModelByUpstreamModel(upstreamModel: string) {
  return enabledModels.find((model) => model.upstreamModel === upstreamModel) ?? null
}

export function listModelCatalog() {
  return enabledModels
}
