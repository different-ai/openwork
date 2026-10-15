---
name: principle-prove-it-on-the-real-thing
description: "Apply before declaring anything works. The verdict comes from a spec run against the real artifact on the runtime it ships on, not from a manual CDP poke, a screenshot, a recording, a booted preview, or 'it compiles'."
metadata:
  opencode/autoinvoke: "false"
  opencode/slash: "true"
---

# Prove It on the Real Thing

A claim is proven only by an observable assertion against the thing users get.

**Why:** Proxies feel cheaper and pass for the wrong reasons. A green run on Bun proves nothing about Electron's Node; a local build proves nothing about the notarized zip; a screenshot proves only that a frame existed.

- The verdict is an `evals/specs` run (`run-tests`). Hand-driven CDP, previews, recordings and screenshot indexes are exploration or presentation.
- Run on the shipping runtime and the shipping bytes: Electron Node for desktop server code, downloaded release zips for a release, the extracted `app.asar` when reasoning about shipped code.
- Look at the screenshot yourself. A passing rule is not a good screen.
- A risky condition needs a witness step that fails when the condition did not occur.
- When the check fails, suspect the observation before the system.
