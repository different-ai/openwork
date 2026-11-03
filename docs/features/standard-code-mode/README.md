# Workflows as standard JavaScript

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

`codemode-run-standard.ts` keeps Den's tools MCP-shaped and converts them only at the engine boundary:

- **Tool results without an `outputSchema`.** The engine returns nothing for a tool that declares no output schema;
  in MCP the result still comes back. The bridge gives such tools an empty (permissive) schema.
- **Tool errors.** The engine shows a program every failure's message and cause, which could expose host details.
  Only a tool's deliberate refusal (`toolError`) shows its message; any other failure reads "Tool execution failed",
  as on OpenWork's interpreter.
- **Sandbox.** Tests prove a program reaches no network, process, imports or `Function` constructor, so an engine
  update cannot widen it unnoticed.

## Turning it on and off

Turn `standardCodeMode` on for an organization in `/admin` (Features, or the organization's row). The flag is read
per organization, never per member, so a Workflow is always tested and run on the same interpreter.

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

- `ee/apps/den-api/src/mcp/codemode-run-standard.ts`: the bridge that runs a script on the engine with Den's tools.
  Den, `packages/codemode` and `packages/computer-use` use Effect 4.0.6, the version the engine pins, so both
  interpreters share one Effect.
- `codemode-run.ts` (`codemodeRuntimeFor`), `codemode-script-object.ts` (the two languages), `workflow-service.ts`
  (`newWorkflowLanguage`, and choosing or refusing an interpreter for each run), `workflows.ts` and `agent.ts`
  (tests and saves).
- Agent guidance: `codemode-script-object.ts` (`workflowCodeRules`, the language rules) and `build-an-app-skill.ts`.
- Tests: `ee/apps/den-api/test/codemode-standard-runtime.test.ts`.

Not covered yet, each its own change: computer-use programs on the standard interpreter; retiring `packages/codemode`
once no saved Workflow uses `codemode-js`.
