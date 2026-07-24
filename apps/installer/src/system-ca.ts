import { spawn } from "node:child_process"
import tls from "node:tls"

// Enterprise TLS interception can be trusted by the browser/OS while Bun fetch
// only sees bundled roots. Mirror desktop runtime.mjs resolveSystemCaEnv by
// extending Bun fetch with best-effort OS trust-store CAs.

type SystemCaTlsModule = {
  getCACertificates?: (type?: string) => string[]
}

export type TlsFetchInit = RequestInit & { tls?: { ca?: string[] } }

const COMMAND_TIMEOUT_MS = 10_000
const OUTPUT_LIMIT_CHARS = 8 * 1024 * 1024
const WINDOWS_CERT_BEGIN = "-----OPENWORK-CERTIFICATE-----"
const WINDOWS_CERT_END = "-----END-OPENWORK-CERTIFICATE-----"
const PEM_CERT_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
const TLS_SYSTEM_MODULE: SystemCaTlsModule = tls

let systemCaCertificatesPromise: Promise<string[]> | null = null

function dedupeCertificates(certs: Iterable<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const cert of certs) {
    const trimmed = cert.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function pemFromBase64(value: string): string | null {
  const base64 = value.replace(/\s+/g, "")
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return null
  }
  const lines = base64.match(/.{1,64}/g)
  if (!lines) return null
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`
}

export function parseWindowsPowerShellCertificates(output: string): string[] {
  const certs: string[] = []
  const pattern = new RegExp(`${WINDOWS_CERT_BEGIN}\\s*([A-Za-z0-9+/=\\r\\n]+?)\\s*${WINDOWS_CERT_END}`, "g")
  for (const match of output.matchAll(pattern)) {
    const pem = pemFromBase64(match[1] ?? "")
    if (pem) certs.push(pem)
  }
  return dedupeCertificates(certs)
}

export function parseDarwinSecurityCertificates(output: string): string[] {
  const certs: string[] = []
  for (const match of output.matchAll(PEM_CERT_PATTERN)) {
    certs.push(match[0])
  }
  return dedupeCertificates(certs)
}

function runCommand(command: string, args: string[], windowsHide: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide })
    } catch {
      resolve(null)
      return
    }

    let output = ""
    let settled = false
    const timeout = setTimeout(() => {
      child.kill()
      finish(null)
    }, COMMAND_TIMEOUT_MS)

    function finish(value: string | null) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      if (settled) return
      const next = `${output}${String(chunk)}`
      if (next.length > OUTPUT_LIMIT_CHARS) {
        child.kill()
        finish(null)
        return
      }
      output = next
    })
    child.on("error", () => finish(null))
    child.on("exit", (code) => finish(code === 0 ? output : null))
  })
}

function loadNodeSystemCertificates(): string[] {
  try {
    if (typeof TLS_SYSTEM_MODULE.getCACertificates !== "function") return []
    return dedupeCertificates(TLS_SYSTEM_MODULE.getCACertificates("system"))
  } catch {
    return []
  }
}

async function loadWindowsSystemCertificates(): Promise<string[]> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$stores = @('Cert:\\LocalMachine\\Root', 'Cert:\\LocalMachine\\CA', 'Cert:\\CurrentUser\\Root', 'Cert:\\CurrentUser\\CA')
foreach ($store in $stores) {
  Get-ChildItem -Path $store -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.RawData) {
      '${WINDOWS_CERT_BEGIN}'
      [Convert]::ToBase64String($_.RawData)
      '${WINDOWS_CERT_END}'
    }
  }
}
`
  const output = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], true)
  return output ? parseWindowsPowerShellCertificates(output) : []
}

async function loadDarwinSystemCertificates(): Promise<string[]> {
  const output = await runCommand("security", ["find-certificate", "-a", "-p", "/Library/Keychains/System.keychain"], false)
  return output ? parseDarwinSecurityCertificates(output) : []
}

async function resolveSystemCaCertificates(): Promise<string[]> {
  const nodeCerts = loadNodeSystemCertificates()
  if (nodeCerts.length > 0) return nodeCerts

  try {
    if (process.platform === "win32") return await loadWindowsSystemCertificates()
    if (process.platform === "darwin") return await loadDarwinSystemCertificates()
    return []
  } catch {
    return []
  }
}

export async function loadSystemCaCertificates(): Promise<string[]> {
  systemCaCertificatesPromise ??= resolveSystemCaCertificates()
  return await systemCaCertificatesPromise
}

function mergeFetchInitWithCa(init: TlsFetchInit | undefined, ca: string[]): TlsFetchInit {
  const callerCa = init?.tls?.ca
  const mergedCa = callerCa ? dedupeCertificates([...callerCa, ...ca]) : ca
  if (init?.tls) {
    return { ...init, tls: { ...init.tls, ca: mergedCa } }
  }
  return { ...init, tls: { ca: mergedCa } }
}

export function createSystemCaFetch(loadCertificates: () => Promise<string[]>): typeof fetch {
  return async function systemCaFetch(input: RequestInfo | URL, init?: TlsFetchInit): Promise<Response> {
    const ca = await loadCertificates().catch(() => [])
    if (ca.length === 0) return fetch(input, init)
    return fetch(input, mergeFetchInitWithCa(init, ca))
  }
}

export const fetchWithSystemCa = createSystemCaFetch(loadSystemCaCertificates)
