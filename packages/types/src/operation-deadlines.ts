/**
 * User-facing operation budgets. These are workflow contracts, not generic
 * fetch defaults: an operation opts in only when it can propagate cancellation
 * to the work it starts.
 */
export const OPENWORK_OPERATION_DEADLINES = {
  denSessionRestoreMs: 35_000,
  denHandoffExchangeMs: 35_000,
  cloudMcpServerMs: 60_000,
  cloudMcpTransportMs: 65_000,
  cloudMcpSubmissionMs: 135_000,
} as const;
