# daytona-windows-cert-assets — Skill assets for Windows enterprise certificate validation

Cast is an OpenWork maintainer reviewing the checked-in skill and helper scripts locally before anyone spends time in a Daytona Windows sandbox.

1. The maintainer opens the new skill and sees that opencode can discover it by name, with the exact Windows, enterprise CA, GPO cert, TLS fetch, and self-hosted certificate phrases that should trigger it.

2. The maintainer checks that the skill does not fork the repro logic. It points to the existing TLS repro and doctor scripts, and the eval proves those files are still present in the repo.

3. The maintainer checks the reusable CA probe before copying it into Windows. Node accepts the file, and the source explicitly asks Electron's Node runtime for the Windows system certificate store.

4. The maintainer checks the teardown guidance last. The skill includes the scheduled-task stop, repro cleanup, sandbox deletion, and temporary release deletion commands, so the runbook cannot leave resources behind.
