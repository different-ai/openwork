export type DiagnosticsProfile = "generic" | "microsoft" | "servicenow"

export interface WireBody {
  bytes: number
  mediaType: string
  preview: string | null
  summary: string
  truncated: boolean
}

export interface WireMessage {
  body: WireBody | null
  headers: Readonly<Record<string, string>>
}

export interface WireExchange {
  completedAt: string
  correlationId: string
  durationMs: number
  id: string
  profile: DiagnosticsProfile
  runId: string | null
  step: string | null
  receivedAt: string
  request: WireMessage & {
    method: string
    path: string
    queryKeys: readonly string[]
  }
  response: WireMessage & {
    status: number
  }
  sourceProof: string
}
