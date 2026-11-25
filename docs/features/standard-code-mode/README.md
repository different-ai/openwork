# Workflows and computer programs as standard JavaScript

> **Generally available:** `standardCodeMode` is retired; the enabled behavior is now standard. Permissions, organization settings and entitlements still apply. Any rollout, off-state or kill-switch instructions below describe the historical rollout; see [the retirement guide](../ga-rollout-retirement/README.md).

Feature `standardCodeMode` (cloud and self-hosted, off by default). Author: `reachjalil`.

## What changes

Workflows, Workflow Apps and Automations that run a Workflow execute agent-written code in Den. Until now that code
was OpenWork's own Code Mode dialect (`packages/codemode`): a restricted, JavaScript-like language with its own rules.
This feature moves new Workflows onto industry standards:

- **Language: ECMAScript,** judged by test262, the official conformance suite, and by JavaScript semantics. Agents
  write the JavaScript they already know.
- **Tools: MCP.** Each tool has a name, a description, an `inputSchema`, an optional `outputSchema` and optional
  annotations. A result is never dropped because a tool has no `outputSchema`.
- **Schemas: JSON Schema** is the contract for tools. Effect Schema and zod stay host-side details.
- **Data boundary: JSON semantics** for script input, tool arguments, tool results and the Workflow result.
- **Sandbox: capability-based.** A program reaches the outside only through its tools: no network, filesystem,
  process, imports or `Function` constructor.

We follow standards, not a vendor. The engine today is
[`@opencode/codemode`](https://www.npmjs.com/package/@opencode/codemode), OpenCode's open-source interpreter, because it
is the closest to standard JavaScript. Where it departs from a standard, the bridge adapts or this doc records the
departure; the departure never becomes our rule. The stored language is `ecmascript`, not the engine's name, so
another conforming engine can replace it. The engine version is pinned exactly.

With the feature on for an organization:

- **New code is standard JavaScript.** Workflow tests (`execute_capability_script` and draft tests) run on the
  standard interpreter. A Workflow saved from such a test records `language: "ecmascript"` in its payload.
- **Saved Workflows keep their language.** Every Workflow saved before has `language: "codemode-js"` and keeps
  running on OpenWork's interpreter, so nothing that works today changes. Saving a new version of one, which always
  needs a fresh test run, moves it to `ecmascript`.

Tools, grants, tool policy, audit, receipts and limits (`timeoutMs`, `maxToolCalls`, `maxOutputBytes`) work the same on
both.

## Computer-use programs

`computer_run` programs (agent-written code that drives `tools.ui` on the desktop app's computer or browser, or on a
cloud computer) run on the standard interpreter while the feature is on for the member. They are written and run in
the same turn, so there is no saved code to keep on one interpreter: each program runs start to finish on the one
chosen when it starts, and the next program follows the feature as it is then.

- **Desktop app:** the app window reads the feature like every desktop feature (`GET /v1/org` features, member
  overrides included; signed out, `GET /v1/features`) and reports it to the desktop process
  (`computerSetStandardCodeMode`), as it reports `computerUse`.
- **Cloud computer** (the OpenWork server on a member's cloud worker): the server reads the signed-in organization's
  `GET /v1/org` features itself (`ManagedDesktopPolicy.standardCodeModeEnabled`), reusing an answer for up to 30
  seconds. Unreachable or signed out means OpenWork's Code Mode.
- **Never the request.** Nothing in a program request picks the interpreter. The choice grants nothing either: both
  interpreters run the same `tools.ui` helpers, under the same chat, takeover, Stop and receipt rules.
- **Await every helper.** A helper the program does not await is cancelled when the program returns and sends no
  input afterwards, so receipts stay true. OpenWork's dialect waited for it.
- **Workbot computers** keep OpenWork's Code Mode: their runner does not read organization features yet.

Program errors keep their codes: a helper's refusal (`target_not_found: ...`) still reaches the program, and any
other failure reads "Tool execution failed". With the feature off, programs run exactly as before.

## How the two languages differ

| | OpenWork's dialect (`codemode-js`) | Standard JavaScript (`ecmascript`) |
| --- | --- | --- |
| Language | A restricted subset | ECMAScript: `.then`/`.catch`, `new Promise`, generators, iterators |
| TypeScript annotations | Stripped | Rejected as a parse error, since they are not JavaScript |
| `Promise.all(...)` | Waits where it is called | Returns a promise |
| `async` callbacks in `filter`, `find`, `sort`, `forEach` | Awaited one at a time | JavaScript behaviour (a promise is truthy) |
| `keys()`, `values()`, `entries()` | Arrays | Iterators |
| Script `input` | Frozen | The program's own copy |

Authors find these in the test run that every save needs, since the test runs in the language the Workflow will be
saved in.

## Intentional departures from JavaScript

The engine does these differently from a JavaScript runtime. We accept them and say so to authors: with the feature
on, `execute_capability_script`'s description asks for standard JavaScript, says TypeScript annotations are rejected
and states the first two below, and the build-an-app skill names the forms that run one item at a time.

- **A call nothing awaits is cancelled when the program returns.** A JavaScript runtime would let it finish. Await
  every call, including writes; OpenWork's dialect waited for them.
- **A rejection nothing awaits does not fail the run.** It appears in the run's logs as `warning: Kind: message`.
- **No limit on parallel tool calls.** JavaScript has none, so the language has none (OpenWork's dialect allowed 8).
  If providers need protection, it belongs in Den as a limit on calls, not in the language.

## Where the bridge adapts the engine to the standards

The bridge, `StandardCodeMode` in `packages/codemode/src/standard.ts`, is shared by Den's Workflows and computer-use
programs. It keeps OpenWork's tools MCP-shaped and converts them only at the engine boundary:

- **Tool results without an `outputSchema`.** The engine returns nothing for a tool that declares no output schema;
  in MCP the result still comes back. The bridge gives such tools an empty (permissive) schema.
- **Tool errors.** The engine shows a program every failure's message and cause, which could expose host details.
  Only a tool's deliberate refusal (`toolError`) shows its message; any other failure reads "Tool execution failed",
  as on OpenWork's interpreter.
- **Sandbox.** Tests prove a program reaches no network, process, imports or `Function` constructor, so an engine
  update cannot widen it unnoticed.

## Turning it on and off

Turn `standardCodeMode` on for an organization in `/admin` (Features, or the organization's row). For Workflows the
flag is read per organization, never per member, so a Workflow is always tested and run on the same interpreter.
Computer programs follow the member's own feature state, as their app sees it.

A saved Workflow never switches interpreter silently. With the feature off (or the kill switch):

- New tests and saves use OpenWork's dialect (`codemode-js`) again.
- A Workflow saved as `ecmascript` does not run. Before any tool is called, the run stops with "This Workflow is
  written in standard JavaScript, which is turned off for this organization", recorded as a failed run with
  `errorKind` `LanguageUnavailable`. Running it on OpenWork's interpreter could quietly give different results.
- Nothing stored changes. Turning the feature back on runs those Workflows again; testing and saving one while the
  feature is off moves it to `codemode-js`.

## What to watch

- Failed runs with `errorKind` `LanguageUnavailable` (standard JavaScript Workflows while the feature is off), and
  `ParseError` or `UnsupportedSyntax` (code written in the other language).
- `warning:` lines in run logs: rejections nothing awaited.
- Provider rate-limit errors from Workflows that start many calls at once.

## Code

- `packages/codemode/src/standard.ts`: the bridge that runs a program on the engine with OpenWork's tools.
  `ee/apps/den-api/src/mcp/codemode-run-standard.ts` runs Workflows through it. Den, `packages/codemode` and
  `packages/computer-use` use Effect 4.0.6, the version the engine pins, so both interpreters share one Effect.
- `codemode-run.ts` (`codemodeRuntimeFor`), `codemode-script-object.ts` (the two languages), `workflow-service.ts`
  (`newWorkflowLanguage`, and choosing or refusing an interpreter for each run), `workflows.ts` and `agent.ts`
  (tests and saves).
- Agent guidance: `codemode-script-object.ts` (`workflowCodeRules`, the language rules) and `build-an-app-skill.ts`.
- Computer use: `packages/computer-use/src/runtime.ts` (`runComputerProgram`'s `standardCodeMode` option),
  `computer-control.mjs` (`setStandardCodeMode`), `cloud.mjs`, `apps/server/src/managed-desktop-policy.ts` and the
  app's `ComputerBridge` (`computer-store.ts`).
- Tests: `ee/apps/den-api/test/codemode-standard-runtime.test.ts`,
  `packages/computer-use/program-standard-code-mode.test.mjs`, `packages/computer-use/cloud.test.mjs` and
  `apps/desktop/electron/computer-program.test.mjs`.

Not covered yet, each its own change: Workbot computers; the `computer_run` description for standard JavaScript and
the departures above; retiring `packages/codemode` once no saved Workflow uses `codemode-js`.
