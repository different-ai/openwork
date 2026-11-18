# Packaged sandbox execution repair

Feature: `sandboxTools` (cloud and self-hosted, off by default). This repair keeps the existing rollout; it does not enable a production feature or publish an alpha.

## Acceptance boundary

The previous source-run proof did not validate the distributable. It could resolve workspace dependencies from the checkout that Electron's packaged `app.asar` could not. A compiled-server import alone also missed the lazy adapter import. Source/native tests remain useful regressions, but are not a packaged-app verdict.

This repair must be exercised in a built macOS arm64 `.app`, with the app's own server, staged Node modules, bundled native runtime and packaged plugin files. An independent temporary profile and history database keep the installed app and existing conversations untouched. The final verification receipt belongs to the exact tested build, not merely a source SHA.

## Mode contract

- Rollout off and no requirement: ordinary behavior.
- Rollout on, host tools allowed: additive guest tools with `sandbox_` names; host tools intentionally remain available.
- Host tools turned off: sandbox-only uses the six direct guest tools under `shell`, `read`, `write`, `edit`, `glob`, `grep`. No host implementations, Code Mode interpreter or additional MCP/browser/computer tool may be offered.
- A pending change must distinguish the saved choice from the current effective mode. Existing work must finish without being killed, and the change must apply automatically at the safe boundary. The UI must not claim sandbox-only is active before it is.

Guest tools are normal direct tools in both additive and required modes; using a microVM must not depend on the host Code Mode interpreter. Feature availability alone is not a requirement to remove host tools.

## Packaged dependency and guest assets

The staged dependency closure includes the workspace adapter, microsandbox SDK, and matching platform-native optional package. The complete native package is unpacked so the SDK's Rust launcher can execute `msb` and load its firmware library from physical paths. macOS signing gives the runtime its own Hypervisor entitlement and preserves that signature through outer app signing/notarization.

The Alpine 3.22 guest is pinned by OCI manifest digest for each supported CPU architecture. The build retrieves and verifies only the pinned OCI config/layers, emits a deterministic archive, and bundles it under `Resources/sandbox-image`. Packaged startup verifies those resources and imports the archive into the isolated SDK home before guest creation; it must not silently download a replacement when assets are missing. Source builds retain SDK image acquisition for the same pinned reference.

A trusted bootstrap API origin is also passed from Electron main to the embedded server for signed-out feature discovery. Renderer feature availability alone is not proof that the host admitted the same mode.

## Required packaged evidence

For both real Claude Fable 5.2 and GPT-6.1 Sol sessions:

1. Inspect packaged paths and native signatures; resolve the lazy adapter and SDK inside the artifact, without checkout dependency lookup.
2. Turn off host tools through Settings during an active chat. Observe the pending wording, successful completion, and automatic effective-mode change.
3. Capture the actual model request's direct-tool catalog, not just prompt prose. Require exactly the six guest tools in sandbox-only.
4. Run `uname -s` and require `Linux`; verify an unmounted host witness is unavailable.
5. Authorize a folder, read it at its unchanged absolute path, and observe edits in both directions.
6. Capture screenshots from the packaged renderer, not Vite or a source Electron process.

Portable Den/local controls run separately on Daytona. Its result must name the resolved source SHA. No Daytona microVM success is implied by a controls pass.

## Artifact regression caught during implementation

The first branch-built macOS arm64 package was rejected by the new after-pack check:

```text
Missing unpacked microsandbox runtime asset: node_modules/@superradcompany/microsandbox-darwin-arm64/bin/msb
```

Its staging and unit tests had passed. This is a packaging failure, not a successful app test, and demonstrates why staging-only tests cannot be the final acceptance boundary. The package must pass the archive/layout checks before any real-session result can count.

## Verification status

Implementation and artifact verification are in progress. The PR's commit-bound verification comment records final commands, artifact identity/signing status, screenshots, failures and passing receipts. Do not interpret this document's acceptance checklist as a test result.
