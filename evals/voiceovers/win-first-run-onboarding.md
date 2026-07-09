# win-first-run-onboarding — Windows first launch lands in a chat-ready workspace and the first send offers a model choice

Cast is a brand-new Windows user launching the packaged OpenWork desktop app for the very first time — no prior state anywhere on the machine. The proof was driven against a real packaged build inside a Daytona Windows 11 VM.

1. The instant the app opens there is no welcome wizard and no empty picker — just a calm full-screen loader that says Preparing workspace, in the same quiet style as the boot overlay, while OpenWork creates a default workspace in the user's home folder and starts the engine.

2. When the engine is ready the loader hands off straight into a live chat session inside the default OpenWork workspace. The composer is focused and ready with the free model preselected, and the select-or-create session page never appeared at any point.

3. The user types their first message and presses Run task. Instead of sending silently, OpenWork holds the draft and asks one question first: power your first task with OpenWork Models, bring your own API key, or skip and use the free model.

4. The user picks skip and use the free model. The held message sends itself immediately — no retyping — the agent answers in the same session, and the one-shot provider step is marked complete so it never interrupts again.
