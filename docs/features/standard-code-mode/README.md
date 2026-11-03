# Workflows as standard JavaScript

Feature `standardCodeMode` (cloud and self-hosted, off by default). Author: `reachjalil`.

## What changes

Workflows, Workflow Apps and Automations that run a Workflow execute agent-written code in Den. Until now that code
was OpenWork's own Code Mode dialect (`packages/codemode`): a restricted, JavaScript-like language with its own rules.
This feature moves new Workflows onto industry standards:

- **Language: ECMAScript.** Programs are standard JavaScript, checked against test262, the official ECMAScript
  conformance suite. Agents write the JavaScript they already know, with no OpenWork-specific dialect to learn.
- **Tools: MCP and JSON Schema.** Den's tools keep their MCP shape: a description, a JSON Schema for input and an
  optional one for output. They are the same tools that agents see through OpenWork Connect.

The engine that runs the language today is [`@opencode/codemode`](https://www.npmjs.com/package/@opencode/codemode),
OpenCode's open-source interpreter. It is an implementation detail: the stored language is `ecmascript`, not the
engine's name, so another conforming engine can replace it.

With the feature on for an organization:

- **New code is standard JavaScript.** Workflow tests (`execute_capability_script` and draft tests) run on the
  standard interpreter. A Workflow saved from such a test records `language: "ecmascript"` in its payload.
- **Saved Workflows keep their language.** Every Workflow saved before has `language: "codemode-js"` and keeps
  running on OpenWork's interpreter, so nothing that works today changes. Saving a new version of one, which always
  needs a fresh test run, moves it to `ecmascript`.

Tools, grants, tool policy, audit, receipts, limits (`timeoutMs`, `maxToolCalls`, `maxOutputBytes`) and script input
work the same on both.

## How the two differ

| | OpenWork's dialect (`codemode-js`) | Standard JavaScript (`ecmascript`) |
| --- | --- | --- |
| Language | A restricted subset | ECMAScript, checked against test262: `.then`/`.catch`, `new Promise`, generators, iterators |
| TypeScript annotations | Stripped | Rejected as a parse error, since they are not JavaScript |
| `Promise.all(...)` | Waits where it is called | Returns a promise |
| `async` callbacks in `filter`, `find`, `sort`, `forEach` | Awaited one at a time | Standard behaviour (a promise is truthy) |
| A call nothing awaits when the program returns | Finishes first | Interrupted |
| A rejection nothing awaits | Fails the run | Becomes a `warning:` line in the run's logs |
| Tool calls at once | 8 | No cap |
| `keys()`, `values()`, `entries()` | Arrays | Iterators |
| Script `input` | Frozen | The program's own copy |

Authors find these during the test run that every save needs, since the test runs in the language the Workflow will
be saved in.

## Where the engine differs from the standards

The adapter in `codemode-run-standard.ts` keeps Den on the standards where the engine does not:

- **Tool output.** In MCP, a tool without an `outputSchema` still returns its result. The engine returns nothing for a
  tool that declares no output schema, so the adapter gives such tools a permissive one.
- **Tool failures.** The engine shows a program every failure's message and cause. Only a tool's deliberate refusal
  (`toolError`) shows its message, as on OpenWork's interpreter. Any other failure reads "Tool execution failed", so
  host error details never reach a program, its receipts or the model.
- **Host access.** Programs reach no network, process, module system or `Function` constructor, only the tools Den
  provides. A test pins this, so an engine update cannot widen it unnoticed.

## Turning it on and off

Turn `standardCodeMode` on for an organization in `/admin` (Features, or the organization's row). The flag is read
per organization, never per member, so a Workflow is always tested and run on the same interpreter.

Turning it off (or the kill switch) runs every Workflow on OpenWork's interpreter again, including ones saved as
`ecmascript`. Those keep working when they use only what both support. One that relies on standard features the
dialect lacks (`.then`, generators, iterators) fails with `UnsupportedSyntax` until the feature is back on or the
Workflow is saved again. Nothing stored changes, so turning it back on restores them.

## What to watch

- Workflow run receipts with `errorKind` `ParseError` or `UnsupportedSyntax` (code written in the other language).
- `warning:` lines in run logs: rejections nothing awaited.
- Run durations of Workflows with async helpers, which run concurrently in both languages since #6919.

## Code

- `ee/apps/den-api/src/mcp/codemode-run-standard.ts`: the adapter that runs a script on the engine with Den's tools.
  Den, `packages/codemode` and `packages/computer-use` use Effect 4.0.6, the version the engine pins, so both
  interpreters share one Effect.
- `codemode-run.ts` (`codemodeRuntimeFor`), `codemode-script-object.ts` (the two languages),
  `workflow-service.ts` (`newWorkflowLanguage`, and choosing the interpreter for each run), `workflows.ts` and
  `agent.ts` (tests and saves).
- Tests: `ee/apps/den-api/test/codemode-standard-runtime.test.ts`.

Not covered yet: computer-use programs (`packages/computer-use`) still run on OpenWork's interpreter.
`packages/codemode` can go once no saved Workflow uses `codemode-js`.
