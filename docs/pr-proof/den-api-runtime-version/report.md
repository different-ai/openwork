# Eval run 2026-07-16T18-34-31-048Z

- Started: 2026-07-16T18:34:31.048Z
- CDP: http://127.0.0.1:37309
- Result: PASSED (1 passed, 0 failed, 0 skipped)
- fraimz: fraimz.html

## ✅ den-api-runtime-version — Org settings shows the running Den version inline
Kind: user-facing flow demo

- ✅ Org settings shows the running Den version beside its description (967ms)
  - Assertion: The visible value matches the live Den API health version (passed)
  - Assertion: The inline label reports the running Den version (passed)
  - Assertion: The version aligns to the far right of the Org settings description row (passed)
  - Assertion: The version uses the discreet light-gray metadata color (passed)
  - Frame: den-api-runtime-version-01-den-web-org-settings-runtime-version.png (passed)
    - Voiceover: Org settings keeps the description on the left and aligns the running Den version to the far right in light gray, making the build identity easy to find without adding another control.
- ✅ Voice-over script coverage (0ms)
  - Assertion: Script frame 1 narrated: "Org settings keeps the description on the left and aligns the running Den version to the" (passed)

Screenshots: den-api-runtime-version-01-den-web-org-settings-runtime-version.png
