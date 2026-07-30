# invitee-first-boot-just-works — an invited member's first boot is already configured: only the org's models, no modals, no reload cycles

Acme Robotics locks its laptops to the two models the company approves. This is the
whole journey from the admin's policy to the invited member's first message, and the
point of the demo is that the member does nothing to make it work.

1. Alex runs Acme Robotics. In the desktop policy that covers the whole organization he turns off custom providers and OpenCode Zen — from now on Acme laptops can only use models Acme provides.

2. Then he publishes the two models the team is allowed: GPT-5.4 and GPT-5.5. That is the entire menu, and nothing else is on it.

3. He invites Maya from the members page. Her invitation goes pending, and what lands in her inbox is a plain "join Acme Robotics" link.

4. Maya opens the link, picks a password, and she's in — the page welcomes her to Acme Robotics and hands her the desktop app.

5. She installs OpenWork and opens it for the very first time. One sign-in, one loading screen, and the workspace is already Acme's — nothing to dismiss, nothing to refresh.

6. She opens the model menu and finds exactly two entries: GPT-5.4 and GPT-5.5. No OpenCode Zen, no personal API keys, and no way to add one.

7. Underneath, the app compared Acme's server state against the local machine once, wrote it once, and stopped — no reload banner, no config churn, and not one dialog appeared during the entire boot.

8. Maya types her first message and GPT-5.5 answers. From her side, joining Acme was three clicks and it just worked.
