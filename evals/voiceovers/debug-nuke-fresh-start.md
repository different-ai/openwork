# debug-nuke-fresh-start — Debug nuke returns Windows to a clean sign-in

This user-facing proof drives a packaged Windows OpenWork app over CDP and uses Daytona filesystem witnesses to show the debug-only nuke deletes seeded local state, preserves the sanitized organization bootstrap, permits clean runtime files after relaunch, and records retry evidence for locked paths.

1. A tester's machine starts out full of real local state. We attach to the running Windows desktop app, seed every local OpenWork and OpenCode state root with recognizable fixtures and bootstrap secrets, then show the app is alive while the filesystem and localStorage witnesses prove the state is present.

2. In Debug settings, the tester opens the Danger zone. The dialog says exactly what will be deleted, what will survive, and asks for the typed word NUKE before the destructive button can run.

3. One typed word wipes the machine. After NUKE is entered, OpenWork relaunches; because the bootstrap kept require-sign-in, the app comes back on the branded sign-in screen, and the seeded browser storage keys are gone.

4. No seeded state survived the cleanup. The Windows filesystem witnesses show seeded markers and run tags gone from OpenWork and OpenCode roots, allow clean runtime credential files to be recreated without fixture data, and keep desktop-bootstrap.json sanitized with baseUrl, requireSignin, and brandAppName while stripping handoff and claim-link secrets.

5. Even a locked database cannot silently survive. We lock a runtime database with an exclusive Windows handle, run the nuke again through the same Debug UI, verify the retry receipt or pending file names the locked path, kill the locker, relaunch once more, and require the boot guard to remove both the pending marker and the locked file.
