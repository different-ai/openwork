# den-gateway — OpenWork in the browser at one address, with the machine invisible

web.openworklabs.com is served by den-gateway: it signs the user in, routes them
to their own instance, and injects that instance's credentials server-side. The
browser never holds an instance token, never sees a machine name, and never
learns which compute vendor is behind it. den-api remains the only thing that
talks to Daytona.

1. I go to web.openworklabs.com and get a sign-in page. Nothing is running for me
   yet, and there is nothing to install.

2. I sign in with my work account and land in OpenWork with the cursor already
   in the composer.

3. My workspace is mine. A teammate signing in gets their own, and neither of us
   can see the other's sessions or files.

4. I ask what's on my calendar and it answers. My organization's connections are
   already wired in — I never pasted a key.

5. I ask it to save a summary to a file, and the file appears in my workspace.

6. The address bar says web.openworklabs.com and nothing else — no tokens, no
   machine names, nothing I'd think twice about screen-sharing.

7. I close the tab and come back the next morning from a different laptop. The
   same address opens my workspace with that file still in it.

8. I sign out and reload. It asks me to sign in again — my workspace is not
   reachable without my account.
