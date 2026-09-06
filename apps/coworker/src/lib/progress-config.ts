/** Hard bounds for optional activity copy. No model is selected by default. */
export const PROGRESS_LIMITS = Object.freeze({
  longRunningMs: 15_000,
  clockMs: 1_000,
  debounceMs: 2_000,
  minCallIntervalMs: 30_000,
  timeoutMs: 5_000,
  maxCallsPerExecution: 3,
  // ASCII bytes bound tokens conservatively, without a tokenizer or an estimate.
  maxInputBytes: 1_024,
  inputFramingBytes: 128,
  maxOutputTokens: 80,
  maxOutputChars: 240,
  maxNoteChars: 320,
  maxFacts: 3,
  maxVisibleSteps: 50,
  maxCount: 999,
  activityPollMs: 1_500,
  activityReadTimeoutMs: 5_000,
  maxActivityExecutions: 16,
  maxReplyChars: 20_000,
  maxReplyParts: 64,
  cleanupMs: 2_000,
  summaryPollMs: 100,
  maxInputPrice: 0.50,
  maxOutputPrice: 2,
});

export const PROGRESS_AGENT = "progress-summary";
export const PROGRESS_TITLE = "Observed progress selection";
export const PROGRESS_SYSTEM = 'Select useful observed progress facts. Return only JSON {"facts":["status",...]}. Include status and dependencies when present, and steps if any failed. No other keys, prose, predictions, ETA, confidence, reasoning, or tools.';
