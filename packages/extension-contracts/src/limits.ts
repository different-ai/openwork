export const OPEN_WORK_EXTENSION_MANIFEST_SCHEMA_VERSION = 1

/** Finite v1 wire limits. These are contract values, not runtime policy. */
export const OPEN_WORK_EXTENSION_MANIFEST_LIMITS = Object.freeze({
  commandArgumentCount: 64,
  commandArgumentLength: 4_096,
  contributionCount: 128,
  descriptionLength: 2_048,
  detectionCount: 128,
  enablementConditionCount: 64,
  identifierLength: 255,
  instructionsLength: 16_384,
  labelLength: 255,
  manifestCount: 512,
  nameLength: 255,
  platformCount: 4,
  promptLength: 8_192,
  referenceLength: 2_048,
  reloadReasonCount: 6,
  requiredEnvironmentVariableCount: 64,
  resourceCount: 128,
  sourceReferenceLength: 512,
})
