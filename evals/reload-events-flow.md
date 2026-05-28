# Reload events flow

End-to-end checks for the reload-required toast. These protect the contract that
OpenWork only asks the user to reload when reload-relevant files change while the
app is already running.

## Why

OpenWork bootstraps workspace files such as `opencode.jsonc`, `.opencode/agents`,
and legacy command frontmatter. Those internal startup writes should refresh the
OpenWork/OpenCode baseline silently. The user-facing **Reload required** toast is
reserved for real runtime edits to OpenCode config, MCP, skills, agents,
commands, or plugins.

## Flow 1 — App boot does not show stale reload toast

Steps:
1. Start the Electron dev app from a clean process.
2. Select an existing local workspace that already has an `opencode.jsonc` file.
3. Wait 6 seconds after the main session route becomes ready.
4. Create a new task and wait another 6 seconds.

Pass criteria:
- No toast appears with title **Reload required**.
- No toast body mentions `opencode.jsonc`, `OpenCode config`, agents, commands,
  skills, or plugins.
- Creating the new task does not create or update `opencode.jsonc` just because
  the route resolved the workspace.

Tool recipe:
```js
// After selecting the workspace/session route.
await new Promise((resolve) => setTimeout(resolve, 6000));
document.body.innerText.includes("Reload required"); // expected false
```

## Flow 2 — Internal bootstrap writes are silent

Steps:
1. Create a temporary local workspace with no `.opencode` directory.
2. Add it through the OpenWork workspace picker.
3. Wait until the session route is ready.
4. Wait 6 seconds for reload-event polling to run.

Pass criteria:
- OpenWork creates the default project `opencode.jsonc` and `.opencode/agents/openwork.md`.
- No **Reload required** toast appears for those internally-created files.
- A subsequent new task in that workspace also does not show a reload toast.

## Flow 3 — No-op rewrites do not prompt reload

Steps:
1. While the app is running, record the exact contents of the selected
   workspace's `opencode.jsonc`.
2. Rewrite `opencode.jsonc` with the same bytes.
3. Wait 6 seconds.

Pass criteria:
- No **Reload required** toast appears.
- The server reload event cursor may advance only if a real fingerprint changed;
  identical content must not create a visible reload prompt.

## Flow 4 — Runtime config edits still prompt reload

Steps:
1. While the app is running on the selected workspace, append or change a real
   project OpenCode config value in `opencode.jsonc`.
2. Wait up to 6 seconds.

Pass criteria:
- A **Reload required** toast appears.
- The description identifies the config change, ideally naming `opencode.jsonc`.
- Clicking **Reload now** reloads the workspace engine and clears the toast.

## Flow 5 — Hidden project config is watched

Steps:
1. Use a workspace whose active project config lives at `.opencode/opencode.jsonc`.
2. Start OpenWork and wait until the session route is ready.
3. Modify `.opencode/opencode.jsonc` while the app is running.
4. Wait up to 6 seconds.

Pass criteria:
- A **Reload required** toast appears for the hidden project config change.
- Rewriting the same file content again does not create a second visible toast
  after the current toast is dismissed and the engine is reloaded.

## Known regressions this catches

- Workspace resolution rewrites `opencode.jsonc` on every app open or new task.
- Raw filesystem notifications show a reload toast even when file content did
  not change.
- Startup-created OpenWork agent/config files leak into the user-facing reload
  event stream.
- `.opencode/opencode.jsonc` changes are missed because only root-level config
  files are watched.
