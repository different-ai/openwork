# marketplace-connect-only-delivery — org marketplace plugins arrive through OpenWork Connect, with nothing to install

Context (not narrated): Phase D / PR D2 of the extensions drain. Den marketplace
content is cloud-delivered unconditionally — the app no longer consults the org
`connectEnabled` flag for delivery (the flag survives only as the rail kill
switch). Extensions (Legacy) stays purely local (local MCPs, skills,
GitHub/Claude plugin imports). Pre-existing imports keep working untouched.
Frame 5 seeds a legacy import through the still-alive server install route to
simulate pre-flip state; frame 4 runs a real agent turn on the seeded Den eval
stack.

1. My organization publishes a plugin to its marketplace, and on my desktop it simply appears in OpenWork Connect — already active, running in the cloud, with nothing to install.

2. The old install path is really gone: the organization marketplace shows everything as running in the cloud — no Install buttons anywhere — and nobody had to flip a switch to get here.

3. Extensions (Legacy) is purely local territory now: my MCPs, skills, and GitHub plugin imports, with no organization content mixed in.

4. When I ask the agent to use the capability, it discovers it with search and executes it in the cloud — no files ever landed on my machine.

5. And the plugin I imported back in the old days keeps working untouched — it just carries a local-copy badge now, managed through Connect.
