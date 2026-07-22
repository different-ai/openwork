# den-reauth-popup-social — Social reauth keeps the queued action alive

Alex is the Acme Robotics owner. He is signed in with Google, but his admin session has gone stale before he copies an install link for the team.

1. Alex signs in to Acme Robotics, and the browser stays on the Cloud dashboard while the evaluation stages the same stale-session state an admin would hit after stepping away.

2. From Members, Alex clicks Copy install link. OpenWork pauses the action, asks him to confirm it is still him, and offers Continue with Google right inside the security check.

3. Alex finishes Google sign-in in the small popup. The Members page never reloads, the security check disappears, and the original Copy install link action completes by itself with the link copied.
