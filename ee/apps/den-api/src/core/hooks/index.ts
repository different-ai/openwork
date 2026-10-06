// Public surface of the Core hook registry (W0-05). Core files dispatch
// through `coreHooks`; module code registers through it. Importing this file
// also loads the legacy registrations, so every dispatcher sees today's hooks
// even outside app.ts (scripts, jobs).
export { coreHooks, describeCoreHooks, freezeCoreHooks } from "./default-registry.js"
export { runWithAfterCommit } from "./mutation.js"
export type { CoreHookModuleStateSource } from "./module-state.js"
export type * from "./points.js"
export type {
  CoreGuardRegistration,
  CoreHookLogger,
  CoreHookRegistry,
  CoreParticipantRegistration,
  CorePostCommitRegistration,
  CoreTxRegistration,
} from "./registry.js"
export { CORE_HOOK_ORDER } from "./types.js"
export type { AfterCommit, CoreHookModuleId, CoreHookRejection, CoreTx } from "./types.js"
import "./legacy/index.js"
