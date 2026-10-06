import {
  buildModuleDisabledBody,
  moduleDisabledHeaders,
  moduleDisabledStatus,
  type ModuleRestrictedDenial,
} from "@openwork/license-contracts/errors"
import type { ModuleId } from "@openwork/license-contracts/modules"
import type { ModuleOffState } from "@openwork/license-contracts/resolver"

/**
 * The framework-agnostic "module off" response (discovery §8.2a): the W0-01
 * body, `X-OpenWork-Module(-Reason)` headers, `cache-control: no-store`, and
 * 404 on desktop-facing routes or 403 elsewhere. W0-04 (Hono) and W0-06
 * (gateway) wrap it.
 */
export function moduleDisabledResponse(input: {
  moduleId: ModuleId
  state: ModuleOffState | ModuleRestrictedDenial
  desktopFacing: boolean
}): Response {
  const body = buildModuleDisabledBody({ moduleId: input.moduleId, state: input.state })
  return new Response(JSON.stringify(body), {
    status: moduleDisabledStatus({ desktopFacing: input.desktopFacing }),
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...moduleDisabledHeaders(body),
    },
  })
}
