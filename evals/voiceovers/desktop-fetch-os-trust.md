# desktop-fetch-os-trust — Desktop remote calls use the OS trust path and explain certificate failures

Cast is an enterprise user in the OpenWork desktop app. The proof opens the Cloud account settings, tries a remote worker whose HTTPS certificate is not trusted by the operating system, connects a healthy remote worker, and finally returns the app to a normal state.

1. The user opens Settings, goes to Account, and the OpenWork Cloud account surface renders normally. There is no vague fetch failed banner; the account controls are visible and ready.

2. The user tries to connect a remote worker over HTTPS, but the server presents a certificate the operating system does not trust. OpenWork keeps the dialog open and shows a certificate-specific error, so support can see that trust is the blocker instead of a bare fetch failure.

3. The user now connects a healthy remote worker over plain HTTP. The dialog closes, and Fraimz remote worker appears in the workspace list, proving discovery and creation succeed through the desktop connection path.

4. The user cleans up that temporary worker and returns to the app's starting baseline. An existing app shows the normal Cloud account controls again; a fresh app returns to the welcome screen, with no failed dialog left behind.
