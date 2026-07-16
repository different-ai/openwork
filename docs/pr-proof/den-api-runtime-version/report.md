# Eval run 2026-07-16T17-38-42-197Z

- Started: 2026-07-16T17:38:42.197Z
- CDP: http://127.0.0.1:37309
- Result: PASSED (1 passed, 0 failed, 0 skipped)
- fraimz: fraimz.html

## ✅ den-api-runtime-version — Den reports the running API version from its public health endpoint
Kind: user-facing flow demo

- ✅ The public health response identifies the running Den build (60ms)
  - Assertion: The health response is healthy (passed)
  - Assertion: The response identifies den-api (passed)
  - Assertion: The response reports the expected running version (passed)
  - Frame: den-api-runtime-version-01-den-api-runtime-version.png (passed)
    - Voiceover: The Den health endpoint now identifies the exact build serving traffic, so an operator can compare a deployment with the intended release without database access or authentication.
- ✅ Voice-over script coverage (0ms)
  - Assertion: Script frame 1 narrated: "The Den health endpoint now identifies the exact build serving traffic, so an operator c" (passed)

Screenshots: den-api-runtime-version-01-den-api-runtime-version.png
