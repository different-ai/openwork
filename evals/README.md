# OpenWork UI evals

Human-readable scenarios that an LLM (or a person) can replay against a live
OpenWork instance to verify end-to-end behavior of the UI.

Each eval is:
- A short list of steps written in plain English.
- An **expected outcome** with observable signals.
- The CDP browser tool calls to drive it.

They are not unit tests. They intentionally exercise the running stack
(OpenCode + OpenWork server + React UI) so regressions in wiring — not just
types — get caught.

## How to run

### Option A: On Daytona (recommended)

Run against a real Electron app in a Daytona cloud sandbox. No local Docker or
display needed. See [`daytona-flows.md`](./daytona-flows.md) for full details.

Quick start:

```bash
# 1. Create sandbox
daytona create --name openwork-test --dockerfile .devcontainer/Dockerfile \
  --context .devcontainer/Dockerfile --context .devcontainer/start-display.sh \
  --context .devcontainer/start-services.sh \
  --class large --memory 8 --auto-stop 60 --public --target us

# 2. Start services
daytona exec openwork-test 'bash /workspace/.devcontainer/start-services.sh'

# 3. Get CDP URL
daytona preview-url openwork-test -p 9825
# → https://9825-xxx.daytonaproxy01.net

# 4. Run evals using browser_* tools with that URL
browser_list({ browser_url: "https://9825-xxx.daytonaproxy01.net" })
```

### Option B: Local Electron

Start the Electron dev app locally:

```bash
pnpm dev
```

Wait ~15s, then use the browser tools against `http://127.0.0.1:9825`.

### Option C: Manual browser

Open the app and follow the step lists by hand.

## Tool reference

Evals use the OpenCode browser tools (`.opencode/tools/browser.ts`), not
Chrome DevTools MCP. Every tool takes `browser_url` as the first argument.

| Tool | Description |
|------|-------------|
| `browser_list` | List page targets on the CDP endpoint |
| `browser_navigate` | Navigate a target to a URL |
| `browser_snapshot` | Accessibility tree with UIDs |
| `browser_click` | Click by snapshot UID |
| `browser_fill` | Fill input by snapshot UID |
| `browser_evaluate` | Run JS in the page |
| `browser_screenshot` | Capture PNG |

## Conventions

- Use `browser_evaluate` for button clicks and text input — it's more reliable
  than snapshot UIDs for dynamic React UIs.
- For Lexical editors, use `document.execCommand('insertText', false, text)`
  after focusing. Direct DOM manipulation doesn't trigger Lexical state updates.
- For React state injection (e.g., folder picker bypass), use the
  `__reactFiber$` → reducer dispatch pattern documented in `daytona-flows.md`.
- When asked to "wait for X", use `sleep` then `browser_evaluate` to check.

## Files

- [`daytona-flows.md`](./daytona-flows.md) — Daytona sandbox flows (workspace
  creation, session messaging, screenshot verification).
- [`react-session-flows.md`](./react-session-flows.md) — core
  session/settings flows verified during the React port cutover, including
  long streaming interruption coverage.
- [`onboarding-welcome-flows.md`](./onboarding-welcome-flows.md) — the 7
  onboarding/welcome flows covering first-run experience and folder
  explanation.
