#!/usr/bin/env bash
# Recording mock for powershell.exe used by doctor.test.mjs.
# Mirrors mock-wsl.sh. Env vars:
#   MOCK_PWSH_LOG          path to append one invocation per line (joined argv)
#   MOCK_PWSH_STDOUT_FILE  if set, cat its bytes to stdout
#   MOCK_PWSH_STDOUT       fallback plain-text stdout
#   MOCK_PWSH_STDERR       plain-text stderr
#   MOCK_PWSH_EXIT         exit code (default 0)

set -u

if [ -n "${MOCK_PWSH_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$MOCK_PWSH_LOG"
fi

if [ -n "${MOCK_PWSH_STDOUT_FILE:-}" ]; then
  cat "$MOCK_PWSH_STDOUT_FILE"
elif [ -n "${MOCK_PWSH_STDOUT:-}" ]; then
  printf '%s' "$MOCK_PWSH_STDOUT"
fi

if [ -n "${MOCK_PWSH_STDERR:-}" ]; then
  printf '%s' "$MOCK_PWSH_STDERR" >&2
fi

exit "${MOCK_PWSH_EXIT:-0}"
