# Deep-Link Bridge Progress Log

## Step 0 - Create a clean implementation branch

- Option A: Continue on the old experiment branch and layer the architecture change on top of mixed hypothesis commits.
- Option B: Create a fresh branch from `origin/dev` and cherry-pick only the minimal h1 desktop baseline before building the bridge.
- Option C: Start from the h1+h4+h5 combo branch and prune behavior afterward.

Decision: Option B. It keeps the history readable and limits the first baseline to the already-validated native single-instance handoff.

Result: [x] Worked.

Notes: Created `issue-1022-deeplink-bridge` from `origin/dev` and cherry-picked the h1 desktop baseline commits.

## Step 1 - Add a transport-only JS bridge for pending deep links

- Option A: Put the pending queue and browser event directly inside `packages/app/src/index.tsx`.
- Option B: Add a dedicated helper module for the queue/event contract, then call it from `packages/app/src/index.tsx`.
- Option C: Keep everything in `packages/app/src/app/app.tsx` and delay bridge creation until after the app mounts.

Decision: Option B. It keeps the bridge transport-only, testable in isolation, and reusable from both bootstrap and app consumers.

Result: [x] Worked.

Notes: Added `packages/app/src/app/lib/deep-link-bridge.ts`, moved startup/current deep-link capture into `packages/app/src/index.tsx`, and refactored `packages/app/src/app/app.tsx` to consume only bridged URLs with dedupe after a successful claim. Verified with `pnpm typecheck` and a browser repro against `http://localhost:5176/...ow_bundle=http://127.0.0.1:8123/bundle.json`, which still opened the `SHARED SKILL` modal for `workspace-guide`.

## Step 2 - Forward single-instance launch args into the JS bridge

- Option A: Trust `getCurrent()` / `onOpenUrl()` alone and keep focusing the window from Rust without emitting anything.
- Option B: Emit raw deeplink-like args from the Rust single-instance callback as a Tauri event, then let the JS bridge queue them.
- Option C: Write the args into window-local storage from Rust and poll for them from JS.

Decision: Option B. It is still transport-only, avoids polling, and directly closes the gap we observed between native single-instance launch and JS modal handling.

Result: [x] Worked.

Notes: Added a native Tauri event bridge from the single-instance callback into JS. Verified with `pnpm --filter @different-ai/openwork exec cargo check --manifest-path src-tauri/Cargo.toml`, `pnpm --filter @different-ai/openwork exec cargo build --manifest-path src-tauri/Cargo.toml`, `pnpm typecheck`, and a rebuilt direct-binary two-launch repro. The running instance logged the second launch and `emitting forwarded deeplinks to JS urls=[...]` in `/tmp/openwork-direct-bridge.log`.

## Step 3 - Choose the strongest local validation path for the full chain

- Option A: Use macOS UI automation to assert that the desktop modal is visible after the second launch.
- Option B: Attach Chrome DevTools directly to the Tauri webview and inspect modal state from there.
- Option C: Combine the Step 1 browser proof of the canonical JS consumer opening the shared-skill modal with the Step 2 native proof that the already-running app forwards the raw deeplink into that same JS bridge.

Decision: Option C. Options A and B were not available in this tool session, but the combined proof still exercises both halves of the new architecture with the exact shared-skill deeplink payload.

Result: [x] Best available validation completed.

Notes: The browser-side canonical consumer still opens the `SHARED SKILL` modal for `workspace-guide` when fed the same bundle URL, and the rebuilt desktop binary now forwards the already-running launch payload into the bridge. Direct desktop modal inspection remains blocked by missing local UI automation / webview inspection access in this session.
