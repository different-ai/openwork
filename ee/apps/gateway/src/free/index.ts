/**
 * Free Auto in the Gateway.
 *
 *   guest/   signed-out desktop: signed proofs, release window, guest tokens, session proof of work
 *   member/  signed-in members of unsubscribed organizations, on the regular /api/v1 routes
 *   shared/  config, request/response handling, allowance accounting, OpenAI dispatch
 *
 * guest/ and member/ may import shared/; shared/ never imports either.
 */
export { registerAnonymousInferenceRoutes, type FreeRouteDependencies } from "./guest/routes.js"
export { createFreeMemberHandler, type FreeMemberDependencies, type FreeMemberHandler } from "./member/handler.js"
export { readAutoConfig, type AutoConfig } from "./shared/config.js"
