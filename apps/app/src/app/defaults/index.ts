/**
 * App-level hardcoded defaults.
 *
 * These are client-side constants that define the initial state of the
 * app before the user customizes anything. They can be overridden by
 * user preferences stored in localStorage.
 *
 * Keep this folder small and focused. Each file should export clear,
 * well-documented constants with JSDoc explaining what they control
 * and how to override them.
 */

export {
  DEFAULT_VISIBLE_MODELS,
  RECOMMENDED_MODEL_PATTERNS,
  isDefaultVisibleModel,
  isRecommendedModel,
} from "./models";
