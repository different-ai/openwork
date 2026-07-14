import { createHmac, timingSafeEqual } from "node:crypto"

function signaturePayload(runId: string, step: string): string {
  return `openwork-diagnostics-v1\n${runId}\n${step}`
}

export function createDiagnosticRunSignature(secret: string, runId: string, step: string): string {
  return createHmac("sha256", secret).update(signaturePayload(runId, step)).digest("hex")
}

export function verifyDiagnosticRunSignature(input: {
  runId: string
  secret: string
  signature: string
  step: string
}): boolean {
  if (!input.secret || !/^[0-9a-f]{64}$/u.test(input.signature)) return false
  const supplied = Buffer.from(input.signature, "hex")
  const expected = Buffer.from(createDiagnosticRunSignature(input.secret, input.runId, input.step), "hex")
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
