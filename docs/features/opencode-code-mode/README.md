# Workflows on OpenCode's Code Mode

Feature `opencodeCodeMode` (cloud and self-hosted, off by default). Author: `reachjalil`.

## What changes

Workflows, Workflow Apps and Automations that run a Workflow execute agent-written JavaScript in Den. Until now that
code always ran on OpenWork's own Code Mode interpreter (`packages/codemode`), a copy of OpenCode's taken in August
2026 and maintained separately since. OpenCode publishes its current interpreter as
[`@opencode/codemode`](https://www.npmjs.com/package/@opencode/codemode), the same Code Mode the OpenCode engine
runs.

With the feature on for an organization:

- **New code runs on OpenCode's Code Mode.** Workflow tests (`execute_capability_script` and draft tests) run on it,
  and a Workflow saved from such a test records `language: "opencode-codemode"` in its payload.
- **Saved Workflows keep their Code Mode.** Every Workflow saved before has `language: "codemode-js"` and keeps
  running on OpenWork's interpreter, so nothing that works today changes. Saving a new version of one, which always
  needs a fresh test run, moves it to OpenCode's Code Mode.

Tools, grants, tool policy, audit, receipts, limits (`timeoutMs`, `maxToolCalls`, `maxOutputBytes`) and script input
work the same on both.

## How the two differ

OpenCode's Code Mode is much closer to JavaScript. For Workflow authors:

| | OpenWork's (`codemode-js`) | OpenCode's (`opencode-codemode`) |
| --- | --- | --- |
| Language | A restricted subset | Close to modern JavaScript, checked against test262: `.then`/`.catch`, `new Promise`, generators, iterators |
| TypeScript annotations | Stripped | Rejected as a parse error |
| `Promise.all(...)` | Waits where it is called | Returns a promise, as in JavaScript |
| `async` callbacks in `filter`, `find`, `sort`, `forEach` | Awaited one at a time | JavaScript behaviour (a promise is truthy) |
| A call nothing awaits when the program returns | Finishes first | Interrupted |
| A rejection nothing awaits | Fails the run | Becomes a `warning:` line in the run's logs |
| Tool calls at once | 8 | No cap |
| `keys()`, `values()`, `entries()` | Arrays | Iterators |
| Script `input` | Frozen | The program's own copy |

Authors find these during the test run that every save needs, since the test runs on the Code Mode the Workflow will
be saved for.

## Turning it on and off

Turn `opencodeCodeMode` on for an organization in `/admin` (Features, or the organization's row). The flag is read per
organization, never per member, so a Workflow is always tested and run on the same Code Mode.

Turning it off (or the kill switch) runs every Workflow on OpenWork's interpreter again, including ones saved as
`opencode-codemode`. Those keep working when they use only what both support. One that relies on OpenCode's Code Mode
(`.then`, generators, iterators) fails with `UnsupportedSyntax` until the feature is back on or the Workflow is saved
again. Nothing stored changes, so turning it back on restores them.

## What to watch

- Workflow run receipts with `errorKind` `ParseError` or `UnsupportedSyntax` (code written for the other Code Mode).
- `warning:` lines in run logs: rejections nothing awaited.
- Run durations of Workflows with async helpers, which run concurrently on both since #6919.

## Code

- `ee/apps/den-api/src/mcp/codemode-run-opencode.ts`: runs a script on `@opencode/codemode` with Den's tools as they
  are. Den, `packages/codemode` and `packages/computer-use` use Effect 4.0.6, the version `@opencode/codemode`
  pins, so both Code Modes share one Effect. Tools without an output schema get a permissive one, since OpenCode's
  Code Mode hands back nothing for a tool that declares no output. Only a tool's deliberate refusal (`toolError`)
  shows its message to the program; any other failure reads "Tool execution failed", as on OpenWork's Code Mode,
  because OpenCode's would show the host error's message.
- `codemode-run.ts` (`codemodeRuntimeFor`), `codemode-script-object.ts` (the two languages),
  `workflow-service.ts` (`newWorkflowLanguage`, and choosing the Code Mode for each run), `workflows.ts` and `agent.ts`
  (tests and saves).
- Tests: `ee/apps/den-api/test/codemode-opencode-runtime.test.ts`.

Not covered yet: computer-use programs (`packages/computer-use`) still run on OpenWork's interpreter.
`packages/codemode` can go once no saved Workflow uses `codemode-js`.
