"use client"

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { DynamicToolUIPart } from "ai"
import { Check, KeyRound, Loader2, Lock } from "lucide-react"
import type { CredentialPrompt } from "@openwork/types/den/credential-prompt"
import { DenApiError, createDenClient, readDenSettings } from "@/app/lib/den"
import { DEN_DASHBOARD_LINKS } from "@/app/lib/den-dashboard-links"
import { SecretField, type SecretFieldHandle } from "@/components/secret-field"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { gatewayCredentialBody, promptFields, promptFieldsProblem } from "./credential-prompt-fields"
import { Button, buttonVariants } from "@/components/ui/button"
import { DenReauthNotice } from "@/react-app/domains/cloud/den-reauth-notice"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useOrgFeatureState } from "@/react-app/domains/cloud/use-org-feature"
import { useOptionalMessageList } from "./message-list-provider"
import { credentialPromptCalls, credentialPromptFromToolPart } from "./credential-prompt"

export const CREDENTIAL_SAVED_CONTINUE_PROMPT = "I've saved the key. Go ahead."

/** Keys saved in this window, so a remounting card stays saved before Den answers; never the value. */
const savedHere = new Set<string>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function markSaved(key: string) { savedHere.add(key); for (const listener of listeners) listener() }

type Phase = "entry" | "saving" | "reauth" | "denied" | "gone"

function targetKey(prompt: CredentialPrompt) {
  return JSON.stringify(prompt.target)
}

function denDashboardUrl(baseUrl: string, prompt: CredentialPrompt): string | null {
  try {
    const path = prompt.target.type === "mcp_connection_key" || prompt.target.type === "plugin_connection_key"
      ? `/dashboard/mcp-connections/${encodeURIComponent(prompt.target.connectionId)}`
      : DEN_DASHBOARD_LINKS.gatewayProviders
    const url = new URL(path, baseUrl)
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null
  } catch {
    return null
  }
}

/** Plain, value-free direction for each failure; the key is never repeated back. */
function failureState(error: unknown, name: string): { phase: Phase; message: string | null } {
  if (error instanceof DenApiError) {
    if (error.status === 403 && error.code === "reauth") return { phase: "reauth", message: "Confirm it's you, then enter the key again." }
    if (error.status === 403) return { phase: "denied", message: null }
    if (error.status === 404) return { phase: "gone", message: null }
    if (error.code === "credential_rejected") return { phase: "entry", message: `${name} didn't accept this key. Check it and try again.` }
    if (error.status === 400) return { phase: "entry", message: "Enter only the key, without spaces or a prefix." }
    if (error.status === 409) return { phase: "entry", message: `${name} changed. Ask the agent to check it, then try again.` }
    if (error.status === 502) return { phase: "entry", message: `Couldn't reach ${name} to check the key. Try again.` }
  }
  return { phase: "entry", message: "OpenWork couldn't confirm the key was saved. Try again." }
}

/** Resume the parent script once, only after all of its required targets are ready. */
export function CredentialPromptCards({ part }: { part: DynamicToolUIPart }) {
  const prompts = credentialPromptCalls(part)
  const messageList = useOptionalMessageList()
  const settings = readDenSettings()
  const scope = JSON.stringify([settings.baseUrl, settings.activeOrgId, part.toolCallId])
  const required = new Set(prompts.map(({ prompt }) => targetKey(prompt)))
  const progress = useRef({ scope, required, ready: new Set<string>(), requested: false, resumed: false })
  if (progress.current.scope !== scope) progress.current = { scope, required, ready: new Set(), requested: false, resumed: false }
  progress.current.required = required
  const fulfilled = (key: string, saved: boolean) => {
    const current = progress.current
    // A completion from a previous account must not resume the new account's task.
    if (current.scope !== scope || !current.required.has(key)) return
    current.ready.add(key)
    current.requested ||= saved
    if (!current.requested || current.resumed || ![...current.required].every((target) => current.ready.has(target))) return
    current.resumed = true
    messageList?.continueAfterConnection?.(part.toolCallId, CREDENTIAL_SAVED_CONTINUE_PROMPT)
  }
  return <>{prompts.map(({ part: call, prompt }) => <CredentialPromptCard key={JSON.stringify([scope, targetKey(prompt)])} part={call} prompt={prompt}
    onFulfilled={(saved) => fulfilled(targetKey(prompt), saved)} />)}</>
}

/**
 * The private field an agent asks for, shown where the conversation is. The
 * key goes straight from this field to Den with the signed-in person's
 * session; the transcript, tool results and model only learn it was saved.
 */
export function CredentialPromptCard({ part, prompt: validatedPrompt, continueToolCallId = part.toolCallId, onFulfilled }: {
  part: DynamicToolUIPart
  prompt?: CredentialPrompt
  /** The transcript's own tool call; a Code Mode script's inner call is not a turn part. */
  continueToolCallId?: string
  onFulfilled?: (saved: boolean) => void
}) {
  const prompt = validatedPrompt ?? credentialPromptFromToolPart(part)
  const messageList = useOptionalMessageList()
  const auth = useDenAuth()
  const queryClient = useQueryClient()
  const fieldId = useId()
  // One handle per field; values are read once at save and never kept.
  const fields = useRef(new Map<string, SecretFieldHandle>())
  // Identifiers are safe form data, unlike the private fields. Keep them on a failed check.
  const [identifierValues, setIdentifierValues] = useState<Record<string, string>>({})
  const filled = useRef(new Set<string>())
  const verifiedClient = useRef<ReturnType<typeof createDenClient> | null>(null)
  const [phase, setPhase] = useState<Phase>("entry")
  const [error, setError] = useState<string | null>(null)
  const [hasValue, setHasValue] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const settings = readDenSettings()
  const organizationId = settings.activeOrgId?.trim() ?? ""
  const token = settings.authToken?.trim() ?? ""
  const signedIn = auth.isSignedIn && Boolean(token && organizationId)
  const key = JSON.stringify([settings.baseUrl, organizationId, prompt ? targetKey(prompt) : ""])
  const local = useSyncExternalStore(subscribe, () => savedHere.has(key), () => false)
  const enabled = useOrgFeatureState("secureSecretFields", { active: signedIn })
  // Den's own answer, so a reopened conversation shows what is true now.
  const stored = useQuery({
    queryKey: ["den", "credential-prompt", organizationId, key],
    queryFn: async () => {
      if (!prompt) return false
      const client = createDenClient({ baseUrl: settings.baseUrl, token })
      if (prompt.target.type === "gateway_provider_key" || prompt.target.type === "gateway_provider_credential") {
        return client.gatewayCredentialSetReady(organizationId, prompt.target.inferenceProviderId, prompt.target.credentialSetId)
      }
      const connectionId = prompt.target.connectionId
      return (await client.listMcpConnections(organizationId, "usable")).some((connection) => connection.id === connectionId && connection.connected)
    },
    enabled: signedIn && Boolean(prompt),
    staleTime: 30_000,
    retry: false,
  })
  useEffect(() => {
    if (local || stored.data === true) onFulfilled?.(false)
  }, [local, stored.data, onFulfilled])
  if (!prompt) return null

  const name = prompt.name
  const readOnly = messageList?.readOnly === true
  const saved = local || stored.data === true
  const dashboardUrl = denDashboardUrl(settings.baseUrl, prompt)
  // The field, and its show control, appear only once the rollout is confirmed on.
  const confirmed = enabled.data === true
  const blocked = !signedIn ? "signed_out" : readOnly ? "read_only" : enabled.data === false ? "off" : enabled.isError ? "unverified" : phase === "denied" ? "denied" : phase === "gone" ? "gone" : null
  const showField = confirmed && !blocked && phase !== "reauth" && (!saved || replacing)

  const specs = promptFields(prompt.target)
  const clearAll = () => {
    for (const handle of fields.current.values()) handle.clear()
    setIdentifierValues({})
    filled.current.clear()
    setHasValue(false)
  }
  const save = async () => {
    if (phase === "saving") return
    const run = readDenSettings()
    let values: Record<string, string> = {}
    for (const spec of specs) {
      values[spec.id] = spec.kind === "identifier" ? identifierValues[spec.id]?.trim() ?? "" : fields.current.get(spec.id)?.take() ?? ""
    }
    // Secret handles clear on take(), including failed local validation. Safe
    // identifiers stay put, so recovery asks only for the private values again.
    const problem = promptFieldsProblem(prompt.target, values)
    if (problem) {
      values = {}
      setError(problem)
      return
    }
    const value = values.apiKey ?? ""
    setPhase("saving")
    setError(null)
    try {
      const client = verifiedClient.current ?? createDenClient({ baseUrl: run.baseUrl, token: run.authToken?.trim() ?? "" })
      if (prompt.target.type === "gateway_provider_credential") {
        await client.saveGatewayProviderCredential(organizationId, prompt.target.inferenceProviderId, prompt.target.credentialSetId, gatewayCredentialBody(prompt.target, values))
      } else if (prompt.target.type === "mcp_connection_key") {
        await client.saveMcpConnectionSharedKey(organizationId, prompt.target.connectionId, value)
      } else if (prompt.target.type === "plugin_connection_key") {
        const { pluginId, configObjectId, serverName } = prompt.target
        await client.savePluginConnectionKey(organizationId, { pluginId, configObjectId, serverName, apiKey: value })
      } else {
        await client.saveGatewayProviderKey(organizationId, prompt.target.inferenceProviderId, prompt.target.credentialSetId, value)
      }
      values = {}
      const current = readDenSettings()
      if (current.authToken !== run.authToken || current.activeOrgId !== run.activeOrgId) throw new Error("account_changed")
      clearAll()
      setReplacing(false)
      setPhase("entry")
      markSaved(key)
      void queryClient.invalidateQueries({ queryKey: ["den", "credential-prompt", organizationId, key] })
      // Picks the task up as if the person said so; the message carries no key.
      if (onFulfilled) onFulfilled(true)
      else messageList?.continueAfterConnection?.(continueToolCallId, CREDENTIAL_SAVED_CONTINUE_PROMPT)
    } catch (cause) {
      values = {}
      const next = failureState(cause, name)
      setPhase(next.phase)
      setError(next.message)
    }
  }

  const track = (id: string, has: boolean) => {
    if (has) filled.current.add(id)
    else filled.current.delete(id)
    setHasValue(filled.current.size > 0)
  }
  const plural = specs.length > 1 || prompt.target.type === "gateway_provider_credential"
  const settled = saved && !replacing
  const what = plural ? "credentials" : "API key"
  const title = settled ? `${name}: ${plural ? "credentials" : "key"} saved`
    : blocked === "denied" ? `An admin must add the ${what} for ${name}`
    : blocked === "gone" ? `${name} is no longer available`
    : blocked ? `${plural ? "Credentials" : "API key"} for ${name}`
    : replacing ? `Replace the ${what} for ${name}`
    : `Add the ${what} for ${name}`
  const blockedLine = blocked === "read_only" ? "This conversation is read-only."
    : blocked === "signed_out" ? "Sign in to OpenWork Cloud to add this key here."
    : blocked === "off" ? "Adding keys in chat is off for your organization. Use OpenWork Cloud instead."
    : blocked === "denied" ? "You can't change this key. Ask an organization admin."
    : blocked === "gone" ? "Ask the agent to set it up again."
    : blocked === "unverified" ? "OpenWork couldn't check whether keys can be added here. Use OpenWork Cloud instead."
    : null
  // One state line: who uses the key and where it goes (P9).
  const consent = `Shared with people who can use ${name}${prompt.destination ? ` · sent only to ${prompt.destination}` : ""} · never shown to the agent`
  const Icon = settled ? Check : blocked ? Lock : KeyRound

  return (
    <section data-testid="credential-prompt-card" data-credential-prompt={prompt.target.type} aria-label={`${name} API key`}
      className="w-full max-w-full self-start text-sm text-foreground">
      <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-3 px-3 py-1">
        <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" strokeWidth={1.5} />
        </span>
        <p role="status" className="min-w-0 flex-1 font-medium">{title}</p>
        {settled ? <span aria-label="Saved key, hidden" className="shrink-0 font-mono text-muted-foreground">••••••••</span> : null}
        {settled && !blocked ? <Button variant="ghost" size="sm" onClick={() => { setReplacing(true); setError(null) }}>{plural ? "Replace" : "Replace key"}</Button> : null}
        {blocked && blocked !== "read_only" && blocked !== "gone" && dashboardUrl ? (
          <a className={buttonVariants({ variant: "ghost", size: "sm" })} href={dashboardUrl} target="_blank" rel="noopener noreferrer">Open in OpenWork Cloud</a>
        ) : null}
      </div>
      {blockedLine && !settled ? <p className="px-3 pb-2 text-muted-foreground">{blockedLine}</p> : null}
      {phase === "reauth" && !blocked ? (
        <div className="flex flex-col gap-2 px-3 pb-2">
          <p className="text-muted-foreground">{error}</p>
          <DenReauthNotice
            onVerified={async (client, commit) => {
              verifiedClient.current = client
              commit()
              setPhase("entry")
              setError(null)
            }}
            onCancel={() => { setPhase("entry"); setError(null) }}
          />
        </div>
      ) : null}
      {showField ? (
        <form className="flex flex-col gap-2 px-3 pb-2" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void save() }}>
          <p className="text-muted-foreground">{consent}</p>
          {specs.length > 1 || specs[0]?.kind !== "secret" ? (
            <div className="flex flex-col gap-3">
              {specs.map((spec) => spec.kind === "identifier" ? (
                <Field key={spec.id}>
                  <FieldLabel htmlFor={`${fieldId}-${spec.id}`}>{spec.label}</FieldLabel>
                  <Input id={`${fieldId}-${spec.id}`} autoComplete="off" spellCheck={false} disabled={phase === "saving"} value={identifierValues[spec.id] ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value
                      setIdentifierValues((current) => ({ ...current, [spec.id]: value }))
                      track(spec.id, value.length > 0)
                    }} />
                </Field>
              ) : (
                <SecretField key={spec.id} id={`${fieldId}-${spec.id}`} label={spec.label} revealable={confirmed} multiline={spec.kind === "json"}
                  disabled={phase === "saving"} onSubmit={() => void save()}
                  handleRef={(handle) => { if (handle) fields.current.set(spec.id, handle); else fields.current.delete(spec.id) }}
                  onValueChange={(has) => track(spec.id, has)} />
              ))}
              {error ? <p role="alert" className="text-destructive">{error}</p> : null}
            </div>
          ) : null}
          <div className="flex items-start gap-2">
            {specs.length === 1 && specs[0]?.kind === "secret" ? (
              <div className="min-w-0 flex-1">
                <SecretField id={fieldId} label="API key" labelHidden revealable={confirmed} error={error} disabled={phase === "saving"}
                  handleRef={(handle) => { if (handle) fields.current.set("apiKey", handle); else fields.current.delete("apiKey") }}
                  onSubmit={() => void save()} onValueChange={(has) => track("apiKey", has)} />
              </div>
            ) : <div className="flex-1" />}
            <Button type="submit" size="sm" disabled={phase === "saving" || !hasValue}>
              {phase === "saving" ? <Loader2 data-icon="inline-start" aria-hidden="true" className="animate-spin" strokeWidth={1.5} /> : null}
              {phase === "saving" ? (plural ? "Saving…" : "Checking key…") : plural ? "Save credentials" : "Save key"}
            </Button>
            {replacing ? <Button type="button" variant="ghost" size="sm" disabled={phase === "saving"}
              onClick={() => { clearAll(); setReplacing(false); setError(null) }}>Cancel</Button> : null}
          </div>
        </form>
      ) : null}
    </section>
  )
}
