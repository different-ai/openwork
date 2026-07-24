# typed-automation-dx — Fast typed automations, decoupled from the demo path

The eval engine gets two front doors and a typed contract. `pnpm evals` is now
pure automation — no narration requirements anywhere — while `pnpm fraimz`
stays the demo path, byte-for-byte. Flows gain a compile-checked TypeScript
API (`defineFlow` + `FlowContext`) so generated flow code is verified before
it ever runs. One paragraph per frame; the flow loads its narration from this
file, so this script is the spec the code is held to.

1. The eval runner now has two front doors. Running evals drives automations with no narration requirements, while fraimz stays the demo path. Same engine, two policies.

2. Here is the decoupling in one frame: a flow whose narration drifted from its approved script fails the demo path — and the exact same flow passes as a plain automation, because automation runs don't police narration.

3. Scaffolding no longer requires a script. In automation mode, one command generates a typed flow stub with a compile-checked contract — and the demo path still refuses to scaffold without an approved script.

4. Flows are TypeScript now. The whole runner typechecks, and a flow that misuses the context API is caught by the compiler before it ever drives an app.

5. Nothing breaks behind us: two hundred legacy flows load side by side with the typed ones, and the runner's unit tests still pass.

6. And the demo path is untouched: the voiceover-first demo that guards this whole workflow still passes, drift check and all.
