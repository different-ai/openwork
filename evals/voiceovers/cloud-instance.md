# cloud-instance — OpenWork Cloud opens a full instance in the browser, booted just in time

Cloud is an alpha, per-organization capability: off by default, hosted (multi-org)
deployments only, so it is absent on self-hosted installs and nothing about it is
required for them to run. An enabled org's members get a full OpenWork instance in
the browser — a Daytona sandbox running openwork-server plus the web UI from our
own snapshot. No orchestrator, no download.

1. I'm signed in to OpenWork on the web. There's no Cloud anywhere — not in the
   sidebar, not in settings, nothing that hints it exists.

2. A platform admin turns Cloud on for my organization alone. It stays off for
   everyone else, and it isn't offered at all on self-hosted installs.

3. I reload, and Cloud is in my sidebar, marked Alpha. Nothing to install,
   nothing to set up.

4. I open Cloud. It brings an instance up for me on the spot, and in a few
   seconds I'm looking at the full OpenWork interface in my browser.

5. My organization's connections are already there. I ask what's on my calendar
   and it answers immediately — I never pasted a credential.

6. I ask it to save a summary to a file in my workspace, and the file appears.

7. I close the tab and go do something else. The instance puts itself to sleep,
   so nothing runs while I'm away.

8. Later I open Cloud again. It wakes up, my summary file is still sitting in
   the workspace, and I carry on exactly where I stopped.
