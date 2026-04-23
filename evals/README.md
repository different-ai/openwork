# OpenWork UI evals

Human-readable scenarios that an LLM (or a person) can replay against a live
OpenWork instance to verify end-to-end behavior of the UI.

Each eval is:
- A short list of steps written in plain English.
- An **expected outcome** with observable signals.
- The most useful Chrome DevTools MCP calls to drive it.

They are not unit tests. They intentionally exercise the running stack
(OpenCode + OpenWork server + React UI) so regressions in wiring — not just
types — get caught.

## How to run

1. Start the Docker dev stack:
   ```bash
   packaging/docker/dev-up.sh
   ```
   Use the printed web URL (e.g. `http://localhost:50423`). The port is
   random; never hard-code `5173`/`8787`.

2. Pick a runner:
   - **Chrome DevTools MCP** (recommended). The tool names referenced in each
     flow are the `chrome-devtools_*` tools from the Chrome DevTools MCP
     server. Open the printed web URL in a fresh page via
     `chrome-devtools_new_page` and drive from there.
   - **Manual browser** — open the URL and follow the step lists by hand.

3. Walk each eval top-to-bottom. Only mark ✅ when every expected signal is
   visible. Capture a screenshot with `chrome-devtools_take_screenshot` if you
   want evidence.

4. Stop the stack with the exact `docker compose -p openwork-dev-... down`
   line printed by `dev-up.sh`.

## Conventions

- Selectors in the steps are descriptive, not CSS. Resolve them via
  `chrome-devtools_take_snapshot` and click by `uid`.
- When asked to "wait for X", use `chrome-devtools_wait_for` with the exact
  visible text. Keep the text short and unique.
- If a step expects a connected provider and the stack shows none, note it
  as an environment limitation, not an eval failure.

## Files

- [`react-session-flows.md`](./react-session-flows.md) — the 9 core
  session/settings flows verified during the React port cutover.
