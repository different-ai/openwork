# provider-sync-stable-engine — Org providers import once, the engine stays put

Cast is Alex Chen, owner of Acme Robotics, on a fresh OpenWork desktop
connected to OpenWork Cloud. His org ships a custom LLM provider (Acme Azure
Foundry). Before this fix, signing in started an invisible fight: every cloud
sync erased the provider import baseline, so the app re-imported the provider,
forced an engine reload, and disposed/re-created the active workspace's
OpenCode instance about once a second — the status bar flashed "Reloading
OpenCode config" forever. This demo proves the loop is gone: the provider
imports once, stays imported, and the engine stays quiet.

1. Alex starts on a clean workspace, signed out of the cloud — the composer is idle and the status bar is quiet.

2. He signs in to OpenWork Cloud with a pasted sign-in code and lands on the organization picker — he chooses Acme Robotics, the org whose provider used to trigger the loop.

3. Acme's resources come with him: the onboarding summary shows the org's AI provider models, and he continues into the workspace.

4. The org provider imported exactly once — under the hood the workspace config now remembers the import baseline, so cloud sync has nothing left to re-import.

5. The proof is in the waiting: a full minute in the session and the status bar never flashes "Reloading OpenCode config" — no dispose and re-create churn, the engine connection stays stable.
