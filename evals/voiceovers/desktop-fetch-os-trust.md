# desktop-fetch-os-trust — Desktop remote calls use the OS trust path and explain certificate failures

Cast is an enterprise user in the OpenWork desktop app. The proof opens the Cloud account settings, tries to connect a remote worker whose HTTPS certificate is not trusted by the operating system, verifies the incomplete-chain certificate beat that browsers accept, and finally returns the app to a normal state.

1. The user opens Settings, goes to Account, and the OpenWork Cloud account surface renders normally. There is no vague fetch failed banner; the account controls are visible and ready.

2. The user tries to connect a remote worker over HTTPS, but the server presents a certificate the operating system does not trust. OpenWork keeps the dialog open and shows a certificate-specific error, so support can see that trust is the blocker instead of a bare fetch failure.

3. Next the user points the same dialog at a server whose certificate chain is incomplete, the kind browsers quietly accept but strict clients used to reject with fetch failed. OpenWork now negotiates the connection like a browser would, and the only complaint left is that the endpoint is not a healthy OpenWork server.

4. The user cancels the failed connection and returns to the Cloud account page. The normal account controls are still present, showing the failed probe did not leave the desktop app stuck or degraded.
