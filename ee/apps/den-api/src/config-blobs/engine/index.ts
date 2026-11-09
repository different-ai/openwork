/**
 * The config-blob engine: canonical hashing, matching, diffing, reference
 * and secret resolution, planning and execution. Pure apart from the adapter
 * calls `executePlan` makes; no db access of its own.
 */
export { baseHash, canonicalJson, canonicalJsonPlain, itemRev, normalizeSpecValue, specRev, stringifyCanonical, type RevLayout } from "./canonical.js"
export {
  blobItemAsConfigItem,
  blobItemRef,
  defaultSimilarity,
  MAX_PROPOSAL_PAIRS,
  matchArea,
  nameSimilarity,
  TOO_MANY_TO_SUGGEST,
  validateBlobItems,
  type AreaMatchInput,
  type AreaMatchResult,
  type ItemMatch,
} from "./match.js"
export { classifyMatched, diffSpecs, isDestructiveChange, type ClassifyMatchedInput, type EngineFieldChange, type MatchedClassification } from "./diff.js"
export {
  createRefResolver,
  findRefs,
  inviteRef,
  localizeSpec,
  rewriteRefs,
  toPlanRef,
  type RefOccurrence,
  type RefResolution,
  type RefResolverInput,
  type ResolvedRefOccurrence,
} from "./refs.js"
export {
  checkSecretFields,
  findSecrets,
  matchesSecretField,
  planSecrets,
  REDACTED_SECRET,
  redactRawSecrets,
  replacesSecretValue,
  type ExecutionSecret,
  type PlannedSecrets,
  type PlanSecretsInput,
  type SecretFieldProblems,
  type SecretOccurrence,
} from "./secrets.js"
export {
  buildPlan,
  preflightKey,
  previewOp,
  sortAreas,
  unsupportedReason,
  type BuildPlanInput,
  type BuildPlanResult,
  type ExecutionItem,
  type ExecutionOp,
  type ExecutionPlan,
} from "./plan.js"
export { executePlan, resolveSpec, secretsNeedingValues, type ExecuteOptions, type ExecuteResult } from "./execute.js"
export { countApplyItems, emptyApplyCounts, isNoopUpdate, pendingReportItems } from "./execute.js"
export { checkWrittenItems, readItemsFor, type ApplyRead, type WrittenItemsCheck } from "./apply-check.js"
export { parseStoredExecution } from "./stored-execution.js"
export { runPreflight } from "./preflight.js"
export { CONFIG_APPLY_INTERRUPTED_CODE, interruptReport, isInFlight, summarizeReport } from "./report.js"
