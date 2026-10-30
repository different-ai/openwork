// Asks AI Gateway to send one test prompt with a provider configuration that
// has not been saved yet . Den checks the
// catalog, settings and key shape first; the gateway owns the upstream call.
import type { GatewayProviderTestResult } from "@openwork/types/den/gateway"
import { PROVIDER_TEST_SIGNATURE_HEADER, signProviderTest } from "@openwork-ee/utils/provider-test-signature"

export type GatewayProviderTestInput = {
  providerId: string
  model: string
  settings: Record<string, string>
  credential: { kind: string; secret: string }
}

const GATEWAY_TEST_TIMEOUT_MS = 40_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readResult(value: unknown, model: string): GatewayProviderTestResult | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null
  const status = typeof value.status === "number" ? value.status : null
  const reported = typeof value.model === "string" ? value.model : model
  if (value.ok) return status === null ? null : { ok: true, model: reported, status, code: null, message: null }
  if (typeof value.code !== "string" || typeof value.message !== "string") return null
  return { ok: false, model: reported, status, code: value.code, message: value.message }
}

/**
 * `baseUrl` is Den's route to the gateway and `key` the caller's own gateway key.
 * Called only after Den checked the caller may manage providers: the request is
 * signed for this organization and member with the secret Den shares with the gateway.
 */
export async function requestGatewayProviderTest(input: GatewayProviderTestInput, gateway: { baseUrl: string; key: string; signingSecret: string; organizationId: string; memberId: string; fetch?: typeof fetch; now?: () => number }): Promise<GatewayProviderTestResult> {
  const unreachable: GatewayProviderTestResult = { ok: false, model: input.model, status: null, code: "gateway_unreachable", message: "AI Gateway couldn't run the test. Try again in a moment." }
  const fetcher = gateway.fetch ?? fetch
  const body = JSON.stringify(input)
  const signature = signProviderTest(gateway.signingSecret, { organizationId: gateway.organizationId, memberId: gateway.memberId, body }, gateway.now?.() ?? Date.now())
  try {
    const response = await fetcher(`${gateway.baseUrl.replace(/\/+$/, "")}/api/v1/provider-tests`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.key}`, "content-type": "application/json", [PROVIDER_TEST_SIGNATURE_HEADER]: signature },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(GATEWAY_TEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      console.warn("[gateway-provider-test] gateway answered", response.status)
      return unreachable
    }
    return readResult(await response.json(), input.model) ?? unreachable
  } catch (error) {
    console.warn("[gateway-provider-test] could not reach the gateway", error instanceof Error ? error.message : error)
    return unreachable
  }
}
