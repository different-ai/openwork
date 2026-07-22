# den-reauth-pending-action — Reauth keeps the pending action alive

1. Alex is an org admin whose sign-in is more than fifteen minutes old. We sign in as Alex, deliberately age the session in the eval database, and keep the dashboard visible so the account still feels signed in.

2. From Members, Alex clicks Copy install link. Instead of a dead error banner, OpenWork opens the security check and clearly asks Alex to confirm it is him before changing workspace settings.

3. Alex enters his password once. The dialog closes, OpenWork retries the original copy action automatically, and the button flips to Copied with the install URL already on the clipboard.

4. Even when the browser refuses programmatic copying, Alex is not stuck. The freshly minted install link appears right on the page with a manual copy affordance, and no scary browser error is shown.
