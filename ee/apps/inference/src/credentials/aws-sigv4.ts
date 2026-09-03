// AWS Signature Version 4 request signer (plan §5.3, Bedrock row). Implemented
// with node:crypto only; signs the final upstream request after any body
// rewrite because the payload hash is part of the canonical request.
import { createHash, createHmac } from "node:crypto"

export type AwsCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export type SignableRequest = {
  method: string
  url: URL
  headers: Headers
  body: string | null
}

export type SignAwsRequestInput = SignableRequest & {
  credentials: AwsCredentials
  region: string
  service: string
  now: Date
}

const unreserved = /[A-Za-z0-9\-_.~]/

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function hmac(key: Uint8Array | string, value: string) {
  // Copy into a plain Uint8Array: Buffer's typing is not accepted as a key.
  return new Uint8Array(createHmac("sha256", key).update(value, "utf8").digest())
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

// RFC 3986 encoding with AWS's rules (upper-case hex, `~` unreserved).
export function awsUriEncode(value: string) {
  let encoded = ""
  for (const char of value) {
    if (char.length === 1 && unreserved.test(char)) {
      encoded += char
      continue
    }
    for (const byte of Buffer.from(char, "utf8")) {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return encoded
}

export function amzDate(now: Date) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}

// Non-S3 services expect each already-encoded path segment to be encoded once
// more in the canonical URI (what @smithy/signature-v4 does with uriEscapePath).
function canonicalUri(pathname: string) {
  const path = pathname || "/"
  return path.split("/").map((segment) => awsUriEncode(segment)).join("/")
}

function canonicalQuery(url: URL) {
  const pairs: Array<[string, string]> = []
  url.searchParams.forEach((value, key) => {
    pairs.push([awsUriEncode(key), awsUriEncode(value)])
  })
  pairs.sort(([aKey, aValue], [bKey, bValue]) => (aKey === bKey ? (aValue < bValue ? -1 : aValue > bValue ? 1 : 0) : aKey < bKey ? -1 : 1))
  return pairs.map(([key, value]) => `${key}=${value}`).join("&")
}

function canonicalHeaderValue(value: string) {
  return value.trim().replace(/\s+/g, " ")
}

export function buildCanonicalRequest(input: SignableRequest & { signedHeaders: Map<string, string> }) {
  const names = [...input.signedHeaders.keys()].sort()
  const canonicalHeaders = names.map((name) => `${name}:${canonicalHeaderValue(input.signedHeaders.get(name) ?? "")}\n`).join("")
  return {
    signedHeaderNames: names.join(";"),
    canonicalRequest: [
      input.method.toUpperCase(),
      canonicalUri(input.url.pathname),
      canonicalQuery(input.url),
      canonicalHeaders,
      names.join(";"),
      sha256Hex(input.body ?? ""),
    ].join("\n"),
  }
}

export function deriveSigningKey(secretAccessKey: string, date: string, region: string, service: string) {
  const kDate = hmac(`AWS4${secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, "aws4_request")
}

// Mutates `headers`: sets x-amz-date (+ x-amz-security-token) and
// Authorization. `host` is signed from the URL; fetch sends it itself.
export function signAwsRequest(input: SignAwsRequestInput) {
  const dateTime = amzDate(input.now)
  const date = dateTime.slice(0, 8)
  input.headers.set("x-amz-date", dateTime)
  if (input.credentials.sessionToken) input.headers.set("x-amz-security-token", input.credentials.sessionToken)
  input.headers.delete("authorization")

  const signedHeaders = new Map<string, string>([["host", input.url.host]])
  input.headers.forEach((value, name) => {
    signedHeaders.set(name.toLowerCase(), value)
  })
  const { canonicalRequest, signedHeaderNames } = buildCanonicalRequest({ ...input, signedHeaders })
  const scope = `${date}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", dateTime, scope, sha256Hex(canonicalRequest)].join("\n")
  const signature = hex(hmac(deriveSigningKey(input.credentials.secretAccessKey, date, input.region, input.service), stringToSign))
  input.headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
  )
  return { canonicalRequest, stringToSign, signature }
}

export const bedrockService = "bedrock"

export function bedrockRuntimeHost(region: string) {
  return `bedrock-runtime.${region}.amazonaws.com`
}
