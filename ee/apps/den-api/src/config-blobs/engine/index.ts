/**
 * The config-blob engine: canonical hashing, matching, diffing, reference
 * and secret resolution, planning and execution. Pure apart from the adapter
 * calls `executePlan` makes; no db access of its own.
 */
export { baseHash, canonicalJson, canonicalJsonPlain, normalizeSpecValue, specRev, stringifyCanonical } from "./canonical.js"
export {
  blobItemAsConfigItem,
  blobItemRef,
  defaultSimilarity,
  matchArea,
  nameSimilarity,
  validateBlobItems,
  type AreaMatchInput,
  type AreaMatchResult,
  type ItemMatch,
} from "./match.js"
export { classifyMatched, diffSpecs, isDestructiveChange, type ClassifyMatchedInput, type EngineFieldChange, type MatchedClassification } from "./diff.js"
export {
  createRefResolver,
  findRefs,
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
  type ExecutionSecret,
  type PlannedSecrets,
  type PlanSecretsInput,
  type SecretFieldProblems,
  type SecretOccurrence,
} from "./secrets.js"
export {
  buildPlan,
  sortAreas,
  unsupportedReason,
  type BuildPlanInput,
  type BuildPlanResult,
  type ExecutionItem,
  type ExecutionOp,
  type ExecutionPlan,
} from "./plan.js"
export { executePlan, resolveSpec, secretsNeedingValues, type ExecuteOptions, type ExecuteResult } from "./execute.js"
