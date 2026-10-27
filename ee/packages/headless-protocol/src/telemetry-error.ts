/** Telemetry is a closed code vocabulary, never arbitrary provider error types or text. */
const CODES = new Set([
  "aborted", "superseded", "runner_error", "turn_timeout", "max_steps_exceeded", "stuck_repeating", "output_limit",
  "model_credentials_missing", "mcp_unavailable", "model_unreachable", "model_failed", "model_bad_response",
  "model_stream_interrupted", "model_stream_error", "model_stream_authentication_error", "model_stream_permission_error",
  "model_stream_invalid_request_error", "model_stream_not_found_error", "model_stream_request_too_large",
  "model_stream_rate_limit_error",
  "model_free_allowance_exhausted", "model_usage_limit_exceeded", "model_payment_required",
])

export function telemetryFailureCode(value: string): string {
  if (CODES.has(value) || /^model_http_[1-5][0-9]{2}$/.test(value)) return value
  return value.startsWith("model_stream_") ? "model_stream_error" : "runner_error"
}
