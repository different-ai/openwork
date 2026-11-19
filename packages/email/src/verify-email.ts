import nodemailer from "nodemailer"
import type { EmailSendConfig } from "./send-email.js"

/**
 * Live, read-only checks of the configured mail transport. Nothing is ever
 * sent: SMTP connects, upgrades, signs in and quits; Resend lists the
 * account's domains. Results are fixed codes, never upstream error text.
 */
export type EmailTransportOutcome =
  | "verified"
  | "key_accepted"
  | "auth_failed"
  | "sender_unverified"
  | "unreachable"
  | "timeout"
  | "unexpected_response"

export type EmailTransportCheck =
  | { provider: "smtp" | "resend"; outcome: EmailTransportOutcome }
  /** Development sink: messages are only logged, there is nothing to reach. */
  | { provider: "dev" }
  | { provider: "none" }

export type SmtpVerifyOptions = {
  host: string
  port: number
  secure: boolean
  auth?: { user: string; pass?: string }
  connectionTimeout: number
  greetingTimeout: number
  socketTimeout: number
}
export type SmtpVerifyTransport = { verify(): Promise<true>; close(): void }

export type VerifyEmailTransportOptions = {
  /** Upper bound for the whole check. */
  timeoutMs: number
  signal?: AbortSignal
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  createTransport?: (options: SmtpVerifyOptions) => SmtpVerifyTransport
}

export const RESEND_DOMAINS_URL = "https://api.resend.com/domains"
const MAX_RESEND_BODY_BYTES = 262_144

class CheckTimeout extends Error {}

/** Matches send-email.ts: SMTP_HOST > RESEND_API_KEY > development sink. */
export async function verifyEmailTransport(config: EmailSendConfig, options: VerifyEmailTransportOptions): Promise<EmailTransportCheck> {
  const host = config.smtp?.host?.trim()
  if (host) return { provider: "smtp", outcome: await verifySmtp(config, host, options) }
  const apiKey = config.resendApiKey?.trim()
  if (apiKey) return { provider: "resend", outcome: await verifyResend(apiKey, config.from, options) }
  return config.devMode ? { provider: "dev" } : { provider: "none" }
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, onDeadline: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    const expire = () => { onDeadline(); reject(new CheckTimeout()) }
    timer = setTimeout(expire, timeoutMs)
    if (signal?.aborted) expire()
    else if (signal) {
      abort = expire
      signal.addEventListener("abort", abort, { once: true })
    }
  })
  return Promise.race([operation, deadline]).finally(() => {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener("abort", abort)
  })
}

function smtpOutcome(error: unknown): EmailTransportOutcome {
  if (error instanceof CheckTimeout) return "timeout"
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : ""
  if (code === "EAUTH" || code === "ENOAUTH") return "auth_failed"
  if (code === "ETIMEDOUT") return "timeout"
  if (["ECONNECTION", "ESOCKET", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EDNS", "ETLS", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "unreachable"
  return "unexpected_response"
}

async function verifySmtp(config: EmailSendConfig, host: string, options: VerifyEmailTransportOptions): Promise<EmailTransportOutcome> {
  const smtp = config.smtp
  const timeout = Math.max(1, options.timeoutMs)
  const create = options.createTransport ?? ((settings: SmtpVerifyOptions): SmtpVerifyTransport => nodemailer.createTransport(settings))
  let transporter: SmtpVerifyTransport | undefined
  try {
    transporter = create({
      host,
      port: smtp?.port ?? 587,
      secure: smtp?.secure ?? false,
      auth: smtp?.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    })
    const created = transporter
    // verify() connects, says EHLO, upgrades with STARTTLS, signs in and sends QUIT.
    await withDeadline(created.verify(), timeout, options.signal, () => created.close())
    return "verified"
  } catch (error) {
    // Never keep or return the error: SMTP replies can echo hosts and user names.
    return smtpOutcome(error)
  } finally {
    try { transporter?.close() } catch { /* Release only. */ }
  }
}

function errorName(value: unknown): string | null {
  return value && typeof value === "object" && "name" in value && typeof value.name === "string" ? value.name : null
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body
    || Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel().catch(() => undefined)
    return undefined
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) return undefined
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
      return parsed
    } catch { return undefined }
  } finally {
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** The domain part of EMAIL_FROM: `Name <user@domain>` or `user@domain`. */
export function emailSenderDomain(from: string | undefined): string | null {
  const raw = from?.trim() ?? ""
  const address = /<([^<>]*)>\s*$/.exec(raw)?.[1]?.trim() ?? raw
  const at = address.lastIndexOf("@")
  if (at < 1) return null
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/\.$/, "")
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain) ? domain : null
}

function senderVerified(body: unknown, domain: string): boolean | null {
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) return null
  // Resend verifies each domain and subdomain separately: the sender must match exactly.
  return body.data.some((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("name" in entry) || !("status" in entry)) return false
    if (typeof entry.name !== "string" || entry.name.trim().toLowerCase().replace(/\.$/, "") !== domain) return false
    if (entry.status !== "verified") return false
    const capabilities = "capabilities" in entry ? entry.capabilities : undefined
    const sending = capabilities && typeof capabilities === "object" && "sending" in capabilities ? capabilities.sending : undefined
    return sending === undefined || sending === "enabled"
  })
}

async function verifyResend(apiKey: string, from: string | undefined, options: VerifyEmailTransportOptions): Promise<EmailTransportOutcome> {
  const request = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) return "timeout"
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    return await withDeadline((async () => {
      const response = await request(RESEND_DOMAINS_URL, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
        redirect: "manual",
        signal: controller.signal,
      })
      if (response.status === 200) {
        const domain = emailSenderDomain(from)
        if (!domain) {
          void response.body?.cancel().catch(() => undefined)
          return "sender_unverified"
        }
        const verified = senderVerified(await boundedJson(response, MAX_RESEND_BODY_BYTES), domain)
        if (verified === null) return "unexpected_response"
        return verified ? "verified" : "sender_unverified"
      }
      // Error bodies are small fixed objects; read only the error name.
      let name: string | null = null
      if (response.status >= 400 && response.status < 500) name = errorName(await boundedJson(response, 16_384))
      else void response.body?.cancel().catch(() => undefined)
      // A send-only key cannot list domains, but Resend recognised it.
      if (response.status === 401 && name === "restricted_api_key") return "key_accepted"
      if (response.status === 401 || response.status === 403) return "auth_failed"
      // Resend answers 400 validation_error for an unknown key on every endpoint except sending.
      if (response.status === 400 && name === "validation_error") return "auth_failed"
      if (response.status >= 500) return "unreachable"
      return "unexpected_response"
    })(), Math.max(1, options.timeoutMs), undefined, abort)
  } catch (error) {
    if (error instanceof CheckTimeout || controller.signal.aborted) return "timeout"
    return "unreachable"
  } finally {
    options.signal?.removeEventListener("abort", abort)
  }
}
