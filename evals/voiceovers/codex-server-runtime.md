# codex-server-runtime — Codex runs on the remote OpenWork worker

This demo proves that OpenWork can use a ChatGPT subscription through a Codex runtime hosted on a remote worker, without depending on the user's laptop.

1. I connect OpenWork to a remote worker, so agent work can continue on the server even when this laptop is offline.

2. In the worker settings I select the experimental Codex Server runtime, while OpenCode remains available as the default runtime.

3. I click Connect ChatGPT and complete device-code sign-in with my ChatGPT subscription in the browser.

4. OpenWork now shows Codex connected on the remote worker, making it clear where authentication and execution live.

5. I start a task and see Codex stream its messages, commands, and file changes from the server.

6. When Codex asks for permission, I approve the action directly in OpenWork and the task continues.

7. I reopen OpenWork from another client and continue the same remote Codex conversation with its server-side files intact.

8. The worker diagnostics show a healthy Codex app-server runtime, confirming that no Codex process or public control port is required on my laptop.
