# Crash Recovery Source Proof

This is a browser-driving E2E spec for the real `AppErrorBoundary`, error
monitoring, analytics preferences and diagnostic formatter source graph. It is
not a packaged-desktop, full renderer boot, pre-boot beacon or native clipboard
test.

Install this checkout's usual app and eval dependencies first. Vite, React and
React DOM resolve through `apps/app/package.json`; no sibling checkout or
prebuilt historical artifact is required.

Run just this spec locally with Node 24+ and a Chrome/Chromium installation:

```sh
OPENWORK_EVAL_E2E_TESTS=1 pnpm --dir evals exec vitest run --config fixtures/crash-recovery/vitest.config.ts specs/crash-recovery.e2e.test.ts
```

For Daytona, add `OPENWORK_EVAL_DAYTONA=1`. The normal testkit placement owns
provisioning and disposal; to reuse an already owned runner, also set
`OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX` to its ID/name. Every test still owns and
disposes a fresh Chrome profile through `spec.world` and `chrome`. This fixture
does not need Den, Electron or a staged HTTP server. The dedicated config avoids
unrelated full-stack setup while preserving the E2E opt-in and capability APIs.

By default each test process snapshots current app source into its own
`evals/results/crash-recovery/source-*` directory and builds the three variants
once. To compare an earlier Git revision without changing product files, set
`OPENWORK_RECOVERY_SOURCE_REF=<sha>`; `git archive` exports only `apps/app/src`
into that owned directory. Build manifests record source hashes, actual imported
modules, version/release identifiers and output hashes. The version assertions
come from those build identifiers, not a fixed commit or release string.

The world installs CDP request interception before navigation. It fulfills only
the virtual loopback fixture's GETs from the immutable local Vite bytes and never
forwards requests. The page's synthetic fetch and clipboard witnesses are
installed before product initialization. Tests assert no external/non-GET browser
requests and no interception errors; eligible report envelopes exist only in
memory. All user clicks use testkit's trusted input channel, with `isTrusted`
observed independently. Browser reads use typed callbacks, not code strings.

Each run retains manifests and per-browser observations alongside ambient
testkit receipts in `evals/results/test-runs`. No recorder handle, provider key,
production DSN or real user content is needed. Missing prerequisites remain
failures/skips rather than reducing assertions. Only the synthetic Error/value,
transport, clipboard, runtime marker and preference edges are supplied by the
fixture; boundary, reporter, gates and sanitizer are real source.
