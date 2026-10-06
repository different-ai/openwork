// Public surface of the Core hook registry (W0-05). Core files dispatch
// through `coreHooks`; module code registers through it. Importing this file
// also loads the legacy registrations, so every dispatcher sees today's hooks
// even outside app.ts (scripts, jobs).
export { coreHooks, describeCoreHooks, freezeCoreHooks } from "./default-registry.js"
export { mergeCoreHookRecords } from "./merge.js"
export { runWithAfterCommit } from "./mutation.js"
export type { CoreHookModuleStateSource } from "./module-state.js"
export type * from "./points.js"
export type {
  CoreBootContributorRegistration,
  CoreContributorRegistration,
  CoreDecoratorRegistration,
  CoreGuardRegistration,
  CoreHookLogger,
  CoreHookRegistry,
  CoreMiddlewareRegistration,
  CoreParticipantRegistration,
  CorePostCommitRegistration,
  CoreResolverRegistration,
  CoreTxRegistration,
} from "./registry.js"
export { CORE_HOOK_ORDER } from "./types.js"
export type { AfterCommit, CoreHookModuleId, CoreHookRejection, CoreTx } from "./types.js"
import "./legacy/index.js"
