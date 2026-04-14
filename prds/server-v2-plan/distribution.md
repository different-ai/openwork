# Server V2 Distribution

## Status: Draft
## Date: 2026-04-13

## Purpose

This document defines the preferred distribution model for the new OpenWork server.

It covers:

- how the new server should be built
- how `opencode` and `opencode-router` should be packaged
- how the desktop app should bundle the server
- how standalone server users should install and run it

## Core Distribution Goal

We want one canonical server runtime per platform.

That server runtime should:

- be the same thing the desktop app bundles
- also be shippable as a standalone server download
- include the matching OpenCode and OpenCode Router sidecars

## Recommended Build Model

Recommended implementation/runtime choice:

- implement `apps/server-v2` in TypeScript
- run it with Bun in development
- compile it with Bun for distribution

Recommended packaging choice:

- one compiled server executable per target platform
- embed `opencode` and `opencode-router` into that executable
- extract those sidecars into a managed runtime directory on first run
- launch them from there

This gives us a single-file-per-platform distribution model without needing a second wrapper executable, unless Bun packaging proves insufficient in practice.

## Why Bun Changes The Packaging Story

Bun's `--compile` support gives us a much stronger path than a normal JS runtime build.

Important capabilities:

- compile TypeScript into a standalone executable
- cross-compile for other platforms
- embed arbitrary files with `with { type: "file" }`
- embed build-time constants
- produce minified and bytecode-compiled binaries for faster startup

That means the new server can likely:

- be built as a Bun-compiled executable
- carry embedded sidecar payloads
- self-extract those payloads on startup

## Target Distribution Shape

Per platform, the canonical runtime should be:

- `openwork-server-v2`
  - compiled Bun executable
  - embedded `opencode`
  - embedded `opencode-router`
  - embedded release/runtime manifest

One artifact per platform, for example:

- `openwork-server-v2-darwin-arm64`
- `openwork-server-v2-darwin-x64`
- `openwork-server-v2-linux-x64`
- `openwork-server-v2-linux-arm64`
- `openwork-server-v2-windows-x64.exe`

## Desktop Distribution

Desktop users download the desktop app.

The desktop app should:

- ship with the matching `openwork-server-v2` runtime embedded or bundled as an app resource
- launch only that server
- never directly launch `opencode` or `opencode-router`

At runtime:

1. Desktop app launches `openwork-server-v2`.
2. `openwork-server-v2` checks its managed runtime directory.
3. If needed, it extracts embedded `opencode` and `opencode-router`.
4. It starts and supervises those sidecars itself.
5. Desktop app talks only to the server over port + token.

## Standalone Server Distribution

Some users will want only the server.

For them, we should publish the same canonical runtime as a standalone download.

That means:

- standalone users download `openwork-server-v2` for their platform
- they run it directly
- it performs the same sidecar extraction and supervision the desktop-bundled copy would do

This keeps the runtime identical between:

- desktop-hosted use
- standalone server use

## Runtime Extraction Model

The server executable should embed sidecar payloads and extract them to a persistent versioned runtime directory.

Recommended behavior:

1. On startup, the server determines its runtime version.
2. It computes a runtime directory under app-data.
3. It checks whether the sidecars already exist and match the expected manifest/checksums.
4. If not, it extracts them atomically.
5. It marks executable bits where needed.
6. It launches sidecars from that runtime directory.

Recommended runtime path shape:

```text
<app-data>/runtime/server-v2/<server-version>/
```

Example contents:

```text
<app-data>/runtime/server-v2/0.1.0/
  manifest.json
  opencode
  opencode-router
```

## Why Persistent Runtime Dir Instead Of Temp

We should prefer a persistent runtime directory instead of temp.

Reasons:

- avoids repeated extraction on every run
- avoids temp cleanup breaking the runtime
- improves debuggability
- makes versioned runtime upgrades simpler
- makes locking and atomic replacement easier

## Build Pipeline

Recommended build flow:

1. Build or collect the platform-specific `opencode` binary.
2. Build or collect the platform-specific `opencode-router` binary.
3. Generate a runtime manifest containing:
   - server version
   - OpenCode version
   - router version
   - target platform
   - checksums
4. Compile `apps/server-v2/src/cli.ts` with Bun.
5. Embed the sidecars and manifest into the compiled executable.

Illustrative Bun compile command:

```bash
bun build --compile --minify --bytecode --target=bun-darwin-arm64 ./src/cli.ts --outfile dist/openwork-server-v2
```

The exact build script will likely be JS-driven rather than a one-liner so it can:

- prepare sidecar assets
- generate the manifest
- inject build-time constants
- compile per target

## Bun Embedding Model

The preferred Bun packaging approach is:

- embed sidecar files with `with { type: "file" }`
- access them via Bun's embedded file support
- copy them into the persistent runtime directory on first run

This means we do not need a separate wrapper binary unless Bun's real-world behavior proves insufficient.

## Cross-Platform Targets

The server should be built in a matrix across supported targets.

Initial likely targets:

- `bun-darwin-arm64`
- `bun-darwin-x64`
- `bun-linux-x64`
- `bun-linux-arm64`
- `bun-windows-x64`

Possible later targets:

- `bun-windows-arm64`
- musl variants for portable Linux distribution

For Linux x64, baseline builds may be safer if broad CPU compatibility matters.

## Version Pinning

Each server release should pin:

- server version
- OpenCode version
- router version

Recommended runtime manifest shape:

```json
{
  "serverVersion": "0.1.0",
  "opencodeVersion": "1.2.27",
  "routerVersion": "0.1.0",
  "target": "bun-darwin-arm64",
  "files": {
    "opencode": {
      "sha256": "..."
    },
    "opencode-router": {
      "sha256": "..."
    }
  }
}
```

## Desktop Vs Standalone Release Model

### Desktop release

- desktop app contains the matching `openwork-server-v2` runtime
- user launches app
- app launches server

### Standalone server release

- user downloads `openwork-server-v2` for their platform
- user launches server directly
- server self-extracts sidecars and runs normally

This gives us one runtime with two install channels.

## How This Differs From The Current System

Today, runtime distribution is more fragmented.

Current behavior is closer to:

- desktop app bundles or prepares multiple sidecars
- desktop/Tauri still owns more startup logic
- orchestrator is a separate hosting/control layer
- `openwork-server`, `opencode`, and `opencode-router` are not yet one canonical server runtime bundle

Target behavior becomes:

- desktop app starts one thing: `openwork-server-v2`
- standalone users start that same `openwork-server-v2`
- `openwork-server-v2` starts and supervises its own runtime dependencies

So the key shift is:

- from component distribution
- to runtime-bundle distribution

## Current Workflow Reality

Based on the current repo workflows in this branch:

- macOS notarization is explicitly configured
- Windows signing is not explicitly configured in the GitHub workflows we inspected

That means:

- we should not assume we already have a working Windows signing pipeline
- the new server distribution plan will need an explicit Windows signing step for both desktop and standalone runtime artifacts

## Important Caveats

This Bun-based single-file approach looks promising, but it still needs validation.

### 1. Embedded binary extraction and execution

We need to confirm that embedded sidecar binaries can be:

- copied out reliably
- marked executable reliably
- launched reliably on all supported platforms

### 2. macOS code signing and notarization

This is especially important.

We need to validate:

- the compiled server's codesigning story
- Bun JIT entitlements if needed
- behavior of extracted sidecars under Gatekeeper/notarization

Important practical note:

- the main `openwork-server-v2` executable will need a clean signing and notarization path
- extracted sidecars may also need to be signed appropriately if macOS quarantine or Gatekeeper treats them as separate executables
- we should assume that "signed main binary" does not automatically make extracted child binaries a non-issue

Questions to validate on macOS:

- can the signed/notarized main server extract and launch sidecars without triggering new trust prompts?
- do extracted sidecars need to preserve signatures from the embedded payloads?
- do we need to strip quarantine attributes or will that create trust problems?
- does Bun's compiled executable require specific JIT-related entitlements in our real deployment model?

This means macOS is not just a packaging detail. It is one of the first things we should prototype before fully committing to the single-file distribution format.

### 3. Windows AV / SmartScreen behavior

Extracted executables may have more friction on Windows.

We need to test:

- first-run extraction
- launch reliability
- user-facing warnings

Important practical note:

- Windows Defender or third-party AV may treat a self-extracting executable plus child-process extraction as suspicious behavior
- SmartScreen reputation may apply to the main executable separately from the extracted sidecars
- repeated extraction into temp-like locations is more likely to look suspicious than extraction into a stable app-data runtime directory

Questions to validate on Windows:

- does first-run extraction trigger Defender or SmartScreen warnings?
- are extracted sidecars quarantined, delayed, or scanned in ways that materially hurt startup time?
- do signed extracted sidecars behave better than unsigned ones?
- do we need to prefer a stable per-version runtime directory to avoid repeated AV scans and trust churn?

This means Windows should also get an early prototype, especially for first-run startup latency and user-facing trust prompts.

## Windows Signing Plan

We should plan to sign Windows artifacts explicitly.

That includes:

- desktop app executable/installer
- standalone `openwork-server-v2.exe`
- extracted Windows sidecars when they are shipped as separate signed executables inside the embedded runtime bundle

Recommended signing model:

- use Authenticode signing at minimum
- consider EV signing if SmartScreen reputation becomes a serious UX issue
- timestamp signatures so they remain valid after certificate rotation or expiry

Rule of thumb:

- every Windows executable we intentionally ship to users should be signed

That includes:

- the desktop app executable and/or installer
- `openwork-server-v2.exe`
- `opencode.exe`
- `opencode-router.exe`

Important practical point:

- signing only the main desktop executable is not enough for the server runtime model we want
- if `openwork-server-v2.exe` extracts `opencode.exe` and `opencode-router.exe`, those sidecars should ideally also be signed before embedding

## Suggested Windows Release Flow

### Desktop release flow

1. Build the Windows desktop artifact.
2. Sign the desktop executable or installer.
3. Verify the signature.
4. Publish the signed asset.

### Standalone server release flow

1. Build `openwork-server-v2.exe` for Windows.
2. Build or collect signed Windows `opencode.exe` and `opencode-router.exe` payloads.
3. Embed those signed sidecar payloads into the server executable.
4. Sign the final `openwork-server-v2.exe`.
5. Verify the signature.
6. Publish the signed asset.

This means Windows signing happens at two layers:

- sidecar payload signing
- final runtime signing

## GitHub Actions Sketch

The repo does not currently show an explicit Windows signing step, so we should plan one.

Illustrative shape:

```yaml
jobs:
  build-windows-server-v2:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build server runtime
        run: pnpm --filter openwork-server-v2 build:bin:windows

      - name: Build or fetch Windows sidecars
        run: pnpm --filter openwork-server-v2 build:sidecars:windows

      - name: Import signing certificate
        shell: pwsh
        run: |
          $bytes = [Convert]::FromBase64String("${{ secrets.WINDOWS_CERT_PFX_BASE64 }}")
          [IO.File]::WriteAllBytes("codesign.pfx", $bytes)

      - name: Sign sidecars
        shell: pwsh
        run: |
          signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f codesign.pfx /p "${{ secrets.WINDOWS_CERT_PASSWORD }}" dist\\sidecars\\opencode.exe
          signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f codesign.pfx /p "${{ secrets.WINDOWS_CERT_PASSWORD }}" dist\\sidecars\\opencode-router.exe

      - name: Build embedded runtime
        run: pnpm --filter openwork-server-v2 package:windows

      - name: Sign final server runtime
        shell: pwsh
        run: |
          signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f codesign.pfx /p "${{ secrets.WINDOWS_CERT_PASSWORD }}" dist\\openwork-server-v2.exe

      - name: Verify signature
        shell: pwsh
        run: |
          signtool verify /pa /v dist\\openwork-server-v2.exe
```

The desktop Windows job would follow the same pattern, but sign the desktop executable/installer artifact.

## Secrets And Infrastructure Needed

To support Windows signing in CI, we will likely need:

- a Windows code signing certificate in PFX form
- a password for that PFX
- a timestamp server URL
- possibly a separate EV signing process if we choose that route later

Likely GitHub secrets:

- `WINDOWS_CERT_PFX_BASE64`
- `WINDOWS_CERT_PASSWORD`
- `WINDOWS_TIMESTAMP_URL`

## Recommendation

For now, the important planning takeaway is:

- Windows signing is not already clearly implemented in the repo workflows
- we should treat it as a required new release capability for Server V2 distribution
- both desktop and standalone server runtimes will need explicit Windows signing support

### 4. Upgrade and extraction locking

We need to design:

- atomic extraction
- concurrent launch locking
- old runtime cleanup
- rollback behavior if extraction is interrupted

## Recommended Path

Recommended sequence:

1. Build the new server in Bun/TypeScript.
2. Make the server own runtime supervision logically first.
3. Prototype a multi-file per-platform build first if needed for speed.
4. Then implement the Bun single-file embedded-sidecar distribution path.
5. Use that same runtime artifact in both:
   - desktop releases
   - standalone server releases

The long-term preferred model is still the Bun-based self-extracting single executable per platform.

## Open Questions

1. Should the extracted runtime directory be versioned only by server version, or by server+OpenCode+router tuple?
2. What exact app-data path should we standardize on for desktop-hosted and standalone modes?
3. How should old extracted runtimes be garbage-collected safely?
4. Do we want to keep a multi-file fallback distribution format even after the single-file format works?
5. What exact release pipeline should produce the platform sidecars before the Bun compile step?
