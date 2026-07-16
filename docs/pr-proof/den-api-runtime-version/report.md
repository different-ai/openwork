# Eval run 2026-07-16T18-14-51-270Z

- Started: 2026-07-16T18:14:51.270Z
- CDP: http://127.0.0.1:37309
- Result: PASSED (1 passed, 0 failed, 0 skipped)
- fraimz: fraimz.html

## ✅ den-api-runtime-version — Den Web discreetly shows the running Den version
Kind: user-facing flow demo

- ✅ The dashboard sidebar shows the running Den version (380ms)
  - Assertion: The visible value matches the live Den API health version (passed)
  - Assertion: The sidebar label reports the running Den version (passed)
  - Assertion: The version remains discreetly positioned at the bottom of the sidebar (passed)
  - Frame: den-api-runtime-version-01-den-web-runtime-version.png (passed)
    - Voiceover: At the bottom of the Den dashboard sidebar, the running Den version stays available without competing with the workspace controls or navigation.
- ✅ Voice-over script coverage (0ms)
  - Assertion: Script frame 1 narrated: "At the bottom of the Den dashboard sidebar, the running Den version stays available with" (passed)

Screenshots: den-api-runtime-version-01-den-web-runtime-version.png
