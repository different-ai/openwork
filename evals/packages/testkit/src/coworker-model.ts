/**
 * The AI model the Open Coworker journeys give their coworkers.
 *
 * The free `opencode/big-pickle` model by default, so a journey needs no
 * account or key. When the free tier is throttled, set
 * `OPENWORK_EVAL_COWORKER_MODEL` to any "providerId/modelId" the packaged
 * app's engine can reach from the runner's environment (for example an
 * OpenRouter model with `OPENROUTER_API_KEY` present); the journeys then use
 * that model wherever they would have used the free one.
 */
export const EVAL_COWORKER_MODEL = process.env.OPENWORK_EVAL_COWORKER_MODEL?.trim() || "opencode/big-pickle";
