# Eval run 2026-07-16T18-25-24-628Z

- Started: 2026-07-16T18:25:24.628Z
- CDP: http://127.0.0.1:37309
- Result: PASSED (1 passed, 0 failed, 0 skipped)
- fraimz: fraimz.html

## ✅ den-api-runtime-version — Org settings shows the running Den version inline
Kind: user-facing flow demo

- ✅ Org settings shows the running Den version beside its description (2213ms)
  - Assertion: The visible value matches the live Den API health version (passed)
  - Assertion: The inline label reports the running Den version (passed)
  - Assertion: The version sits directly to the right of the Org settings description (passed)
  - Assertion: The version uses the light-gray metadata color (passed)
  - Frame: den-api-runtime-version-01-den-web-org-settings-runtime-version.png (passed)
    - Voiceover: Org settings now puts the running Den version directly beside the page description in light gray, keeping the build identity visible without adding another control.
- ✅ Voice-over script coverage (0ms)
  - Assertion: Script frame 1 narrated: "Org settings now puts the running Den version directly beside the page description in li" (passed)

Screenshots: den-api-runtime-version-01-den-web-org-settings-runtime-version.png
