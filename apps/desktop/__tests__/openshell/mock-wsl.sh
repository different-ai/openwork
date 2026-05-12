#!/usr/bin/env bash
# Recording mock for wsl.exe used by wsl.test.mjs.
# Reads behavior from env vars set by each test:
#   MOCK_WSL_LOG          path to append one line per invocation (NUL-separated argv)
#   MOCK_WSL_STDOUT_FILE  if set, cat its bytes to stdout (raw, for UTF-16 tests)
#   MOCK_WSL_STDOUT       fallback plain-text stdout
#   MOCK_WSL_STDERR       plain-text stderr
#   MOCK_WSL_EXIT         exit code (default 0)
#   MOCK_WSL_DELAY_MS     sleep before exit (for timeout tests)

set -u

if [ -n "${MOCK_WSL_LOG:-}" ]; then
  # Write argv joined by spaces, then a newline. Tests parse by line.
  printf '%s\n' "$*" >> "$MOCK_WSL_LOG"
fi

# Order: emit stdout/stderr first, THEN optionally sleep. This lets tests
# verify that consumers detect a readiness line while the child stays
# alive (e.g. `openshell sandbox create` reports ready then keeps the
# port-forward open). Tests that need pre-emit delay can use
# MOCK_WSL_DELAY_BEFORE_MS.

if [ -n "${MOCK_WSL_DELAY_BEFORE_MS:-}" ]; then
  sleep "$(awk "BEGIN { print $MOCK_WSL_DELAY_BEFORE_MS / 1000 }")"
fi

if [ -n "${MOCK_WSL_STDOUT_FILE:-}" ]; then
  cat "$MOCK_WSL_STDOUT_FILE"
elif [ -n "${MOCK_WSL_STDOUT:-}" ]; then
  printf '%s' "$MOCK_WSL_STDOUT"
fi

if [ -n "${MOCK_WSL_STDERR:-}" ]; then
  printf '%s' "$MOCK_WSL_STDERR" >&2
fi

if [ -n "${MOCK_WSL_DELAY_MS:-}" ]; then
  sleep "$(awk "BEGIN { print $MOCK_WSL_DELAY_MS / 1000 }")"
fi

exit "${MOCK_WSL_EXIT:-0}"
